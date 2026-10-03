import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { StreamAccumulator, type ApiMessage, type RequestParams } from '@effigent/core';
import { Recorder } from './recorder.js';
import { uploadRun } from './upload.js';
import type { UploadResult } from './types.js';

/**
 * Effigent runtime — phase 1: RECORD ONLY.
 *
 *   import Anthropic from '@anthropic-ai/sdk';
 *   import { createRuntime } from '@effigent/runtime';
 *
 *   const effigent = createRuntime({ agent: 'invoice-recon' });   // key: EFFIGENT_API_KEY
 *   const client = effigent.wrap(new Anthropic());
 *
 *   await effigent.run(async () => {
 *     // your agent loop, unchanged — every client.messages.create / .stream call
 *     // inside this function is one run (one session in the dashboard)
 *   });
 *
 * Run boundaries: an API agent has no session, so `run(fn)` draws one (via
 * AsyncLocalStorage, so concurrent runs stay separate). Calls made OUTSIDE any
 * `run()` collect into one ambient run, uploaded by `flush()` or when the process
 * is about to exit.
 *
 * Fail-open, always: the wrapper returns the SDK's own promise/stream untouched,
 * and any recording or upload error goes to `onError` — never into the agent.
 * The runtime changes NO behaviour yet; applying approved policies comes once the
 * analyzer can recognise a pattern from the start of a live run.
 *
 * Covered: `messages.create` (plain and `stream: true`) and `messages.stream()`
 * (it calls `create` internally). Not covered yet: `client.beta.messages`.
 */

export interface RuntimeOptions {
  /** Agent name in your workspace. A scoped agent key pins the agent server-side anyway. */
  agent?: string;
  /** Effigent key (`eff_…`). Default: EFFIGENT_API_KEY. Without one, nothing is recorded. */
  apiKey?: string;
  /** Collector URL. Default: EFFIGENT_SERVER, else the hosted collector. */
  server?: string;
  /** Called with every internal error (recording or upload). Default: one console warning. */
  onError?: (err: unknown) => void;
  /** Called after every upload attempt. */
  onUpload?: (result: UploadResult) => void;
  /** Test seam: the fetch used for uploads. */
  fetch?: typeof fetch;
}

export interface RunOptions {
  /** Your own id for this run (shown as the session id). Default: a random UUID. */
  sessionId?: string;
}

export interface Runtime {
  /** Wrap an Anthropic client in place and return it. Idempotent. */
  wrap<T extends object>(client: T): T;
  /** Run `fn` as one recorded run; uploads when it settles (success or throw). */
  run<R>(fn: () => Promise<R> | R, opts?: RunOptions): Promise<R>;
  /** Upload the ambient run (calls made outside `run()`), if it has anything. */
  flush(): Promise<UploadResult | null>;
}

export type { UploadResult } from './types.js';

const DEFAULT_SERVER = 'https://collector.effigent.ai';
const WRAPPED = Symbol.for('effigent.runtime.wrapped');

type CreateFn = (params: RequestParams, options?: unknown) => PromiseLike<unknown>;
interface StreamLike {
  iterator: () => AsyncIterator<unknown>;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const apiKey = opts.apiKey ?? process.env.EFFIGENT_API_KEY;
  const server = (opts.server ?? process.env.EFFIGENT_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, '');
  const agent = opts.agent ?? process.env.EFFIGENT_AGENT ?? 'api-agent';
  let warned = false;
  const onError =
    opts.onError ??
    ((err: unknown) => {
      if (warned) return;
      warned = true;
      console.warn(`[effigent] recording error (further errors suppressed): ${err instanceof Error ? err.message : String(err)}`);
    });
  const safe = (f: () => void) => {
    try {
      f();
    } catch (err) {
      onError(err);
    }
  };
  if (!apiKey) onError(new Error('no Effigent API key (set EFFIGENT_API_KEY) — calls pass through unrecorded'));

  const store = new AsyncLocalStorage<Recorder>();
  let ambient: Recorder | null = null;
  const current = (): Recorder => store.getStore() ?? (ambient ??= new Recorder(randomUUID(), agent));

  const upload = async (rec: Recorder): Promise<UploadResult | null> => {
    if (!apiKey || rec.empty) return null;
    const result = await uploadRun(rec.toRun(), { server, apiKey, agent, fetch: opts.fetch ?? fetch });
    if (!result.ok) onError(new Error(`upload failed (HTTP ${result.status}): ${result.detail ?? ''}`));
    safe(() => opts.onUpload?.(result));
    return result;
  };

  const flush = async (): Promise<UploadResult | null> => {
    const rec = ambient;
    ambient = null;
    return rec ? upload(rec) : null;
  };
  // beforeExit fires again after async work, but the ambient run is cleared first.
  if (apiKey) process.once('beforeExit', () => void flush());

  const observe = (rec: Recorder, params: RequestParams, pending: PromiseLike<unknown>) => {
    const t0 = Date.now();
    safe(() => rec.onRequest(params));
    // Same parsed promise the caller awaits (APIPromise caches it); registered first,
    // so a stream's iterator is patched before the caller starts reading it.
    pending.then(
      (result) => {
        if (params.stream) {
          safe(() => recordStream(rec, result as StreamLike, t0));
        } else {
          safe(() => rec.onResponse(result as ApiMessage, Date.now() - t0));
        }
      },
      () => {
        /* API error: nothing billed, nothing to record; the caller sees the error */
      },
    );
  };

  const recordStream = (rec: Recorder, stream: StreamLike, t0: number) => {
    if (!stream || typeof stream.iterator !== 'function') return;
    const inner = stream.iterator;
    // Patch `iterator`, not Symbol.asyncIterator: tee() and toReadableStream() read it too.
    stream.iterator = function patched(this: unknown) {
      const it = inner.call(this);
      const acc = new StreamAccumulator();
      return (async function* () {
        try {
          while (true) {
            const step = await it.next();
            if (step.done) return step.value;
            safe(() => acc.add(step.value as Parameters<StreamAccumulator['add']>[0]));
            yield step.value;
          }
        } finally {
          safe(() => {
            const msg = acc.result();
            if (msg) rec.onResponse(msg, Date.now() - t0);
          });
        }
      })();
    };
  };

  return {
    wrap<T extends object>(client: T): T {
      const messages = (client as { messages?: { create?: CreateFn } & Record<symbol, unknown> }).messages;
      if (!messages || typeof messages.create !== 'function' || messages[WRAPPED]) return client;
      const original = messages.create;
      messages.create = function create(this: unknown, params: RequestParams, options?: unknown) {
        const pending = original.call(this, params, options);
        if (apiKey) {
          try {
            observe(current(), params ?? {}, pending);
          } catch (err) {
            onError(err);
          }
        }
        return pending; // the SDK's own APIPromise — .withResponse() etc. keep working
      };
      messages[WRAPPED] = true;
      return client;
    },

    async run<R>(fn: () => Promise<R> | R, runOpts: RunOptions = {}): Promise<R> {
      const rec = new Recorder(runOpts.sessionId ?? randomUUID(), agent);
      try {
        return await store.run(rec, fn);
      } finally {
        try {
          await upload(rec);
        } catch (err) {
          onError(err);
        }
      }
    },

    flush,
  };
}
