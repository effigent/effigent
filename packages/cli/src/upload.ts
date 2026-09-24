/** Shared transcript upload — used by `effigent sync` (batch) and `effigent run` (per-run, from CI). */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseTranscript, type Run } from '@effigent/core';

export interface UploadTarget {
  server: string;
  apiKey: string;
}

export interface UploadOutcome {
  ok: boolean;
  status: number;
  detail?: string;
}

/** Hosted collectors cap request bodies (~4.5 MB on Vercel). Above this we
 *  parse locally and ship the compact Run instead of the raw transcript. */
const MAX_BODY_BYTES = 3_500_000;

/**
 * Shrink a Run until its JSON fits the body cap. Order matters: TEXT goes first,
 * STRUCTURE last. Every usage-bearing step (per-request tokens, true context) and
 * every result's real size (`fullChars`) is what the cost/rent engine needs — a
 * big session is exactly the one worth analysing, so it must keep all its
 * requests. Head+tail sampling (which drops requests) is the very last resort.
 */
function shrinkToFit(run: Run): { json: string; truncated: boolean } {
  const fits = (r: Run) => { const json = JSON.stringify(r); return Buffer.byteLength(json) <= MAX_BODY_BYTES ? json : null; };
  const cut = (s: Run['steps'][number], cap: number) =>
    s.payload.length <= cap ? s : { ...s, payload: s.payload.slice(0, cap), fullChars: s.fullChars ?? s.payload.length };
  let json = fits(run);
  if (json) return { json, truncated: false };
  for (const cap of [4000, 2000, 1000, 500, 200]) {
    json = fits({ ...run, steps: run.steps.map((s) => cut(s, cap)) });
    if (json) return { json, truncated: true };
  }
  // Results and assistant text reduced to their sizes; tool inputs and user asks keep 200 chars.
  const skeleton = run.steps.map((s) => (s.kind === 'tool_result' || (s.kind === 'model_turn' && s.name === 'assistant') ? cut(s, 0) : cut(s, 200)));
  json = fits({ ...run, steps: skeleton });
  if (json) return { json, truncated: true };
  // Last resort: first/last 800 steps (requests in the middle are lost — cost analysis degrades).
  const sampled: Run = { ...run, steps: [...skeleton.slice(0, 800), ...skeleton.slice(-800)] };
  return { json: JSON.stringify(sampled), truncated: true };
}

/**
 * The session transcript plus its subagent transcripts (`<session>/subagents/*.jsonl`).
 * Subagent lines are `isSidechain: true` and carry the parent sessionId, so the
 * parser can account their spend without mixing them into the main conversation.
 */
function readSessionWithSubagents(filePath: string, sessionId: string): Buffer {
  const main = readFileSync(filePath);
  const dir = join(dirname(filePath), sessionId, 'subagents');
  if (!existsSync(dir)) return main;
  const parts = [main];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    try { parts.push(Buffer.from('\n'), readFileSync(join(dir, f))); } catch { /* unreadable subagent file: skip it */ }
  }
  return Buffer.concat(parts);
}

export async function uploadSessionFile(
  target: UploadTarget,
  filePath: string,
  sessionId: string,
  agentId?: string,
): Promise<UploadOutcome> {
  const raw = readSessionWithSubagents(filePath, sessionId);
  const gz = gzipSync(raw);
  const base = target.server.replace(/\/$/, '');
  const authHeaders = {
    authorization: `Bearer ${target.apiKey}`,
    'x-effigent-session-id': sessionId,
    ...(agentId ? { 'x-effigent-agent-id': agentId } : {}),
  };

  try {
    // Large session: parse locally, upload the compact Run (server redacts + persists
    // through the same choke point).
    if (gz.length > MAX_BODY_BYTES) {
      const run = parseTranscript(raw.toString('utf8'), { agentId });
      if (!run) return { ok: false, status: 0, detail: 'transcript too large and not parseable locally' };
      const { json, truncated } = shrinkToFit(run);
      const res = await fetch(`${base}/api/v1/ingest`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json', 'x-effigent-format': 'run' },
        body: json,
      });
      return {
        ok: res.ok,
        status: res.status,
        detail: res.ok ? (truncated ? 'large session — step payloads trimmed locally' : undefined) : await res.text(),
      };
    }

    const res = await fetch(`${base}/api/v1/ingest`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      body: gz,
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? undefined : await res.text() };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}
