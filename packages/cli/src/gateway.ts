import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamAccumulator, anthropicUsage, type ApiMessage, type TokenUsage } from '@effigent/core';

/**
 * The local Anthropic gateway behind `effigent claude`. Claude Code (or any
 * Anthropic client) points ANTHROPIC_BASE_URL at it; every request is forwarded
 * UNCHANGED to the real upstream — body, auth (x-api-key or the subscription
 * OAuth bearer) and anthropic-version/-beta headers byte for byte — and the
 * response is streamed back as it arrives. The gateway only READS the traffic:
 * for POST /v1/messages it records model + usage + the x-claude-code-* identity
 * headers, never content and never credentials.
 *
 * Fidelity rules (each one breaks Claude Code when wrong):
 *  - hop-by-hop headers are dropped both ways; `accept-encoding` is dropped on
 *    the way up because fetch decompresses — a forwarded content-encoding
 *    header would hand the client plain bytes it then tries to gunzip.
 *  - the client hanging up (Esc) aborts the upstream request, so no output is
 *    billed that nobody reads.
 *  - an upstream failure becomes an Anthropic-shaped 502, never a crash.
 */

export interface GatewayRecord {
  path: string;
  status: number;
  stream: boolean;
  durationMs: number;
  /** Model the client asked for (request body). */
  requestModel?: string;
  /** Model that answered (response). */
  model?: string;
  usage?: TokenUsage;
  /** x-claude-code-* headers (identity: session, agent, parent agent …). */
  claudeCode: Record<string, string>;
}

export interface GatewayOptions {
  /** Upstream base, e.g. https://api.anthropic.com (a path prefix is kept). */
  upstream: string;
  onRecord?: (r: GatewayRecord) => void;
  /** Debug line sink — receives header NAMES and identity values only. */
  log?: (line: string) => void;
  fetch?: typeof fetch;
  port?: number;
}

export interface Gateway {
  url: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);
const DROP_UP = new Set([...HOP_BY_HOP, 'accept-encoding']);
const DROP_DOWN = new Set([...HOP_BY_HOP, 'content-encoding']);
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'proxy-authorization']);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** SSE bytes in → parsed `data:` events out; buffers events split across chunks. */
export class SseSplitter {
  private buf = '';
  private readonly decoder = new TextDecoder();
  constructor(private readonly onEvent: (data: unknown) => void) {}

  push(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i).replace(/^\r?\n\r?\n/, '');
      this.emit(raw);
    }
  }

  end(): void {
    this.buf += this.decoder.decode();
    if (this.buf.trim()) this.emit(this.buf);
    this.buf = '';
  }

  private emit(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    try {
      this.onEvent(JSON.parse(data));
    } catch {
      /* not JSON (e.g. a keep-alive) */
    }
  }
}

export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const upstream = opts.upstream.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const path = req.url ?? '/';
    const body = await readBody(req);

    const headers = new Headers();
    const claudeCode: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null || DROP_UP.has(name)) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      if (name.startsWith('x-claude-code-')) claudeCode[name] = String(value);
    }

    const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(path);
    let requestModel: string | undefined;
    let shape = '';
    if (isMessages) {
      try {
        const j = JSON.parse(body.toString('utf8')) as { model?: string; tools?: unknown[]; messages?: unknown[]; max_tokens?: number; system?: unknown };
        requestModel = j.model;
        // Structure only (never content): tells main turns from side calls in the debug log.
        const sys = typeof j.system === 'string' ? j.system.length : JSON.stringify(j.system ?? '').length;
        shape = ` tools=${j.tools?.length ?? 0} msgs=${j.messages?.length ?? 0} max_tokens=${j.max_tokens ?? '-'} system_chars=${sys}`;
      } catch {
        /* forwarded as-is either way */
      }
    }
    log?.(
      `${req.method} ${path} model=${requestModel ?? '-'}${shape} headers=[${Object.keys(req.headers)
        .map((h) => (SECRET_HEADERS.has(h) ? `${h}(redacted)` : h))
        .join(',')}] ${Object.entries(claudeCode)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
    );

    // Client hung up before we finished → stop the upstream request too.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let up: Response;
    try {
      up = await doFetch(`${upstream}${path}`, {
        method: req.method,
        headers,
        body: body.length && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
        signal: abort.signal,
        redirect: 'manual',
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      log?.(`upstream error ${path}: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `effigent gateway: upstream ${upstream} unreachable` },
        }),
      );
      return;
    }

    const outHeaders: Record<string, string | string[]> = {};
    up.headers.forEach((value, name) => {
      if (DROP_DOWN.has(name)) return;
      if (name === 'set-cookie') return; // collected below — forEach joins them
      outHeaders[name] = value;
    });
    const cookies = up.headers.getSetCookie?.() ?? [];
    if (cookies.length) outHeaders['set-cookie'] = cookies;
    res.writeHead(up.status, outHeaders);
    res.flushHeaders();

    const contentType = up.headers.get('content-type') ?? '';
    const stream = contentType.includes('text/event-stream');
    const observe = isMessages && up.ok;
    const acc = new StreamAccumulator();
    const sse = observe && stream ? new SseSplitter((ev) => acc.add(ev as Parameters<StreamAccumulator['add']>[0])) : null;
    const jsonChunks: Buffer[] = [];

    try {
      if (up.body) {
        for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
          if (sse) sse.push(chunk);
          else if (observe) jsonChunks.push(Buffer.from(chunk));
        }
      }
      res.end();
    } catch (err) {
      // Client abort or upstream cut mid-stream: what arrived is still billed.
      if (!abort.signal.aborted) log?.(`stream error ${path}: ${err instanceof Error ? err.message : String(err)}`);
      res.destroy();
    }

    if (!observe || (!opts.onRecord && !log)) return;
    let msg: ApiMessage | null = null;
    if (sse) {
      sse.end();
      msg = acc.result();
    } else {
      try {
        msg = JSON.parse(Buffer.concat(jsonChunks).toString('utf8')) as ApiMessage;
      } catch {
        msg = null;
      }
    }
    const record: GatewayRecord = {
      path,
      status: up.status,
      stream,
      durationMs: Date.now() - started,
      requestModel,
      model: msg?.model ?? requestModel,
      usage: msg?.usage ? anthropicUsage(msg.usage) : undefined,
      claudeCode,
    };
    log?.(`← ${record.status} ${record.model ?? '-'} ${record.durationMs}ms usage=${JSON.stringify(record.usage ?? {})} ${Object.values(claudeCode).join(' ')}`);
    opts.onRecord?.(record);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log?.(`handler error: ${err instanceof Error ? err.stack : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'effigent gateway error' } }));
      } else {
        res.destroy();
      }
    });
  });
  // Long generations: never time a request out on our side.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
