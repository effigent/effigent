import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { buildRunGraph, segmentEpisodes, usageCostUsd, type Run } from '@effigent/core';
import { createRuntime, type UploadResult } from '../src/index.js';

const MODEL = 'claude-sonnet-4-5';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });

const sse = (events: Array<Record<string, unknown>>) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' },
  });

/** A real SDK client whose HTTP layer answers from a queue. */
function fakeAnthropic(responses: Array<() => Response>) {
  const fetchFn = (async () => {
    const next = responses.shift();
    if (!next) throw new Error('fake anthropic: no response queued');
    return next();
  }) as unknown as typeof fetch;
  return new Anthropic({ apiKey: 'sk-test', fetch: fetchFn, maxRetries: 0 });
}

/** Captures what the runtime POSTs to the collector. */
function fakeCollector(status = 200) {
  const uploads: Array<{ url: string; headers: Record<string, string>; run: Run }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    uploads.push({ url, headers: init.headers as Record<string, string>, run: JSON.parse(String(init.body)) as Run });
    return json({ parsed: true }, status);
  }) as unknown as typeof fetch;
  return { uploads, fetchFn };
}

const message = (content: unknown[], usage: Record<string, unknown>) => ({
  id: 'msg_' + Math.random().toString(36).slice(2),
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage,
});

const USAGE_1 = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 50,
  cache_read_input_tokens: 1000,
  cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 },
};
const USAGE_2 = { input_tokens: 30, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 1200 };

describe('runtime: record a tool loop (non-streaming)', () => {
  it('produces transcript-shaped steps, tokens on the first step per request, and uploads one run', async () => {
    const collector = fakeCollector();
    const effigent = createRuntime({ apiKey: 'eff_test', agent: 'invoice-recon', server: 'https://collector.test/', fetch: collector.fetchFn });
    const client = effigent.wrap(
      fakeAnthropic([
        () => json(message([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu_1', name: 'get_invoice', input: { id: 42 } }], USAGE_1)),
        () => json(message([{ type: 'text', text: 'Invoice 42 is paid.' }], USAGE_2)),
      ]),
    );

    const answer = await effigent.run(
      async () => {
        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Is invoice 42 paid?' }];
        const r1 = await client.messages.create({ model: MODEL, max_tokens: 100, messages });
        messages.push({ role: 'assistant', content: r1.content });
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"status":"paid"}' }] });
        const r2 = await client.messages.create({ model: MODEL, max_tokens: 100, messages });
        return (r2.content[0] as { text: string }).text;
      },
      { sessionId: 'sess-1' },
    );
    expect(answer).toBe('Invoice 42 is paid.'); // the agent's own result, untouched

    expect(collector.uploads).toHaveLength(1);
    const { url, headers, run } = collector.uploads[0]!;
    expect(url).toBe('https://collector.test/api/v1/ingest');
    expect(headers).toMatchObject({
      authorization: 'Bearer eff_test',
      'x-effigent-session-id': 'sess-1',
      'x-effigent-agent-id': 'invoice-recon',
      'x-effigent-format': 'run',
      'x-effigent-source': 'runtime',
    });

    expect(run.steps.map((s) => `${s.kind}/${s.name}`)).toEqual([
      'model_turn/user',
      'model_turn/assistant',
      'tool_use/get_invoice',
      'tool_result/get_invoice', // a result, NOT a user turn
      'model_turn/assistant',
    ]);
    const [, a1, use, result, a2] = run.steps;
    expect(a1!.tokens).toEqual({ input: 100, output: 20, cacheCreation: 50, cacheCreation1h: 50, cacheRead: 1000, context: 1150 });
    expect(a1!.durationMs).toBeGreaterThanOrEqual(0);
    expect(use!.tokens).toBeUndefined(); // same request: tokens only on its first step
    expect(use!.payload).toBe('{"id":42}');
    expect(use!.toolUseId).toBe('tu_1');
    expect(result!.payload).toBe('{"status":"paid"}');
    expect(result!.isError).toBe(false);
    expect(a2!.tokens?.input).toBe(30);

    expect(run.firstPrompt).toBe('Is invoice 42 paid?');
    expect(run.finalOutput).toBe('Invoice 42 is paid.');
    expect(run.models).toEqual([MODEL]);
    expect(run.usageByModel[MODEL]).toEqual({
      inputTokens: 130,
      outputTokens: 32,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 2200,
      cacheCreation1hInputTokens: 50,
    });
    expect(run.costUsd).toBeCloseTo(usageCostUsd(MODEL, run.usageByModel[MODEL]!), 12);
    expect(run.costUsd).toBeGreaterThan(0);

    // The analyzer reads it like any captured session: one ask → one episode.
    const episodes = segmentEpisodes(buildRunGraph(run));
    expect(episodes).toHaveLength(1);
  });
});

describe('runtime: streaming', () => {
  const streamEvents = [
    { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_s', name: 'search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"refunds"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 15 } },
    { type: 'message_stop' },
  ];

  it('records messages.stream() (which goes through create internally)', async () => {
    const collector = fakeCollector();
    const effigent = createRuntime({ apiKey: 'eff_test', fetch: collector.fetchFn });
    const client = effigent.wrap(fakeAnthropic([() => sse(streamEvents)]));

    const final = await effigent.run(async () => {
      const stream = client.messages.stream({ model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'find refunds' }] });
      return stream.finalMessage();
    });
    expect(final.content[0]).toMatchObject({ type: 'tool_use', input: { q: 'refunds' } });

    const run = collector.uploads[0]!.run;
    expect(run.steps.map((s) => `${s.kind}/${s.name}`)).toEqual(['model_turn/user', 'tool_use/search']);
    expect(run.steps[1]!.payload).toBe('{"q":"refunds"}');
    expect(run.steps[1]!.tokens).toMatchObject({ input: 10, output: 15, cacheRead: 500 });
  });

  it('records create({ stream: true }) iterated by the caller', async () => {
    const collector = fakeCollector();
    const effigent = createRuntime({ apiKey: 'eff_test', fetch: collector.fetchFn });
    const client = effigent.wrap(fakeAnthropic([() => sse(streamEvents)]));

    const seen = await effigent.run(async () => {
      const stream = await client.messages.create({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'find refunds' }] });
      let n = 0;
      for await (const _ of stream) n++;
      return n;
    });
    expect(seen).toBe(streamEvents.length); // every event still reaches the caller

    const run = collector.uploads[0]!.run;
    expect(run.steps.map((s) => s.kind)).toEqual(['model_turn', 'tool_use']);
    expect(run.usageByModel[MODEL]?.outputTokens).toBe(15);
  });
});

describe('runtime: fail-open', () => {
  it('an upload failure never reaches the agent', async () => {
    const errors: unknown[] = [];
    const effigent = createRuntime({
      apiKey: 'eff_test',
      onError: (e) => errors.push(e),
      fetch: (async () => {
        throw new Error('collector down');
      }) as unknown as typeof fetch,
    });
    const client = effigent.wrap(fakeAnthropic([() => json(message([{ type: 'text', text: 'hi' }], USAGE_2))]));
    const out = await effigent.run(async () => {
      await client.messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] });
      return 'done';
    });
    expect(out).toBe('done');
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/collector down/);
  });

  it('a 403 from the collector (runtime not enabled) is reported, not thrown', async () => {
    const errors: unknown[] = [];
    const results: UploadResult[] = [];
    const collector = fakeCollector(403);
    const effigent = createRuntime({ apiKey: 'eff_test', fetch: collector.fetchFn, onError: (e) => errors.push(e), onUpload: (r) => results.push(r) });
    const client = effigent.wrap(fakeAnthropic([() => json(message([{ type: 'text', text: 'hi' }], USAGE_2))]));
    await effigent.run(() => client.messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] }));
    expect(results[0]).toMatchObject({ ok: false, status: 403 });
    expect(errors).toHaveLength(1);
  });

  it('an API error passes through and records nothing', async () => {
    const collector = fakeCollector();
    const effigent = createRuntime({ apiKey: 'eff_test', fetch: collector.fetchFn });
    const client = effigent.wrap(fakeAnthropic([() => json({ type: 'error', error: { type: 'api_error', message: 'boom' } }, 500)]));
    await expect(
      effigent.run(() => client.messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] })),
    ).rejects.toThrow();
    // The user turn was recorded, but nothing came back: no run (as parseTranscript would say).
    expect(collector.uploads).toHaveLength(0);
  });

  it('without a key it records nothing and the client still works', async () => {
    const prev = process.env.EFFIGENT_API_KEY;
    delete process.env.EFFIGENT_API_KEY;
    try {
      const collector = fakeCollector();
      const effigent = createRuntime({ fetch: collector.fetchFn, onError: () => {} });
      const client = effigent.wrap(fakeAnthropic([() => json(message([{ type: 'text', text: 'hi' }], USAGE_2))]));
      const r = await effigent.run(() => client.messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }));
      expect(r.content[0]).toMatchObject({ text: 'hi' });
      expect(collector.uploads).toHaveLength(0);
    } finally {
      if (prev !== undefined) process.env.EFFIGENT_API_KEY = prev;
    }
  });
});

describe('runtime: run boundaries', () => {
  it('concurrent runs stay separate; calls outside run() go to the ambient run on flush()', async () => {
    const collector = fakeCollector();
    const effigent = createRuntime({ apiKey: 'eff_test', fetch: collector.fetchFn });
    const reply = () => json(message([{ type: 'text', text: 'ok' }], USAGE_2));
    const client = effigent.wrap(fakeAnthropic([reply, reply, reply]));
    const ask = (q: string) => client.messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: q }] });

    await Promise.all([effigent.run(() => ask('a'), { sessionId: 'A' }), effigent.run(() => ask('b'), { sessionId: 'B' })]);
    await ask('outside');
    expect(collector.uploads.map((u) => u.run.runId).sort()).toEqual(['A', 'B']);

    const flushed = await effigent.flush();
    expect(flushed?.ok).toBe(true);
    expect(collector.uploads[2]!.run.firstPrompt).toBe('outside');
    expect(await effigent.flush()).toBeNull(); // nothing left
  });

  it('wrap is idempotent (no double recording)', async () => {
    const collector = fakeCollector();
    const effigent = createRuntime({ apiKey: 'eff_test', fetch: collector.fetchFn });
    const client = effigent.wrap(effigent.wrap(fakeAnthropic([() => json(message([{ type: 'text', text: 'ok' }], USAGE_2))])));
    await effigent.run(() => client.messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }));
    expect(collector.uploads[0]!.run.steps).toHaveLength(2);
  });
});
