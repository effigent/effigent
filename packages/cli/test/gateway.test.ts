import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SseSplitter, startGateway, type Gateway, type GatewayRecord } from '../src/gateway.js';

const SSE_EVENTS = [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
];
const SSE_BODY = SSE_EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let upstream: Server | undefined;
let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.close();
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = gw = undefined;
});

async function fakeUpstream(handler: (seen: Seen, res: import('node:http').ServerResponse) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/prefix`, seen };
}

const REQ_HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
  authorization: 'Bearer sk-ant-oat-secret',
  'x-claude-code-session-id': 'sess-1',
  'x-claude-code-agent-id': 'agent-7',
  'accept-encoding': 'gzip, br',
};

describe('gateway', () => {
  it('streams SSE through byte-identical, forwards auth/beta headers, records usage', async () => {
    const up = await fakeUpstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1' });
      // Split mid-event to exercise the splitter's buffering.
      const cut = 37;
      res.write(SSE_BODY.slice(0, cut));
      setTimeout(() => res.end(SSE_BODY.slice(cut)), 5);
    });
    const records: GatewayRecord[] = [];
    const lines: string[] = [];
    gw = await startGateway({ upstream: up.url, onRecord: (r) => records.push(r), log: (l) => lines.push(l) });

    const body = JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const res = await fetch(`${gw.url}/v1/messages?beta=true`, { method: 'POST', headers: REQ_HEADERS, body });
    const text = await res.text();
    await new Promise((r) => setTimeout(r, 10));

    expect(res.status).toBe(200);
    expect(res.headers.get('request-id')).toBe('req_1');
    expect(text).toBe(SSE_BODY);
    const s = up.seen[0];
    expect(s.url).toBe('/prefix/v1/messages?beta=true');
    expect(s.body).toBe(body);
    expect(s.headers.authorization).toBe('Bearer sk-ant-oat-secret');
    expect(s.headers['anthropic-beta']).toBe('oauth-2025-04-20,claude-code-20250219');
    expect(s.headers['anthropic-version']).toBe('2023-06-01');
    expect(s.headers['x-claude-code-agent-id']).toBe('agent-7');
    expect(s.headers.host).not.toContain(new URL(gw.url).port);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 200,
      stream: true,
      requestModel: 'claude-opus-5-5',
      model: 'claude-opus-5-5',
      usage: { inputTokens: 10, outputTokens: 42, cacheReadInputTokens: 5000, cacheCreationInputTokens: 200 },
      claudeCode: { 'x-claude-code-session-id': 'sess-1', 'x-claude-code-agent-id': 'agent-7' },
    });
    // The debug log never carries credentials.
    expect(lines.join('\n')).not.toContain('sk-ant');
    expect(lines.join('\n')).toContain('authorization(redacted)');
  });

  it('non-stream JSON: decompressed upstream body reaches the client readable, usage recorded', async () => {
    const json = JSON.stringify({ model: 'claude-sonnet-5', content: [], usage: { input_tokens: 3, output_tokens: 4 } });
    await fakeUpstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(json));
    }).then(async (up) => {
      const records: GatewayRecord[] = [];
      gw = await startGateway({ upstream: up.url, onRecord: (r) => records.push(r) });
      const res = await fetch(`${gw.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: '{"model":"claude-sonnet-5"}' });
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(await res.text()).toBe(json);
      await new Promise((r) => setTimeout(r, 10));
      expect(up.seen[0].headers['x-api-key']).toBe('k');
      expect(records[0]).toMatchObject({ stream: false, model: 'claude-sonnet-5', usage: { inputTokens: 3, outputTokens: 4 } });
    });
  });

  it('passes other paths and error statuses through, recording only successful /v1/messages', async () => {
    const up = await fakeUpstream((s, res) => {
      if (s.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":12}');
      } else {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
        res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
      }
    });
    const records: GatewayRecord[] = [];
    gw = await startGateway({ upstream: up.url, onRecord: (r) => records.push(r) });
    const a = await fetch(`${gw.url}/v1/messages/count_tokens`, { method: 'POST', body: '{}' });
    expect(await a.json()).toEqual({ input_tokens: 12 });
    const b = await fetch(`${gw.url}/v1/messages`, { method: 'POST', body: '{}' });
    expect(b.status).toBe(429);
    expect(b.headers.get('retry-after')).toBe('3');
    await b.text();
    await new Promise((r) => setTimeout(r, 10));
    expect(records).toHaveLength(0);
  });

  it('client abort cancels the upstream request', async () => {
    let upstreamClosed = false;
    const up = await fakeUpstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(SSE_EVENTS[0])}\n\n`);
      res.on('close', () => (upstreamClosed = true));
      // never ends on its own
    });
    gw = await startGateway({ upstream: up.url });
    const ac = new AbortController();
    const res = await fetch(`${gw.url}/v1/messages`, { method: 'POST', body: '{"stream":true}', signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    for (let i = 0; i < 50 && !upstreamClosed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(upstreamClosed).toBe(true);
    expect(up.seen).toHaveLength(1);
  });

  it('unreachable upstream → Anthropic-shaped 502', async () => {
    gw = await startGateway({ upstream: 'http://127.0.0.1:1' });
    const res = await fetch(`${gw.url}/v1/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { type: string }).type).toBe('error');
  });

  it('SseSplitter handles CRLF and byte-split multi-byte characters', () => {
    const out: unknown[] = [];
    const sp = new SseSplitter((d) => out.push(d));
    const bytes = new TextEncoder().encode('data: {"t":"é"}\r\n\r\ndata: {"t":2}\n\n');
    sp.push(bytes.slice(0, 13)); // inside the 2-byte 'é'
    sp.push(bytes.slice(13));
    sp.end();
    expect(out).toEqual([{ t: 'é' }, { t: 2 }]);
  });
});
