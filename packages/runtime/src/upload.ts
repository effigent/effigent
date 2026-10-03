import type { Run } from '@effigent/core';
import type { UploadResult } from './types.js';

interface UploadTarget {
  server: string;
  apiKey: string;
  agent: string;
  fetch: typeof fetch;
}

// The collector runs on Vercel (~4.5 MB body cap); stay under it with headroom, as the CLI does.
const MAX_BODY_BYTES = 3_500_000;
const TIMEOUT_MS = 10_000;

/** Same ladder as cli/src/upload.ts: cut payloads before ever dropping steps. */
function shrinkToFit(run: Run): { json: string; truncated: boolean } {
  const fits = (r: Run) => {
    const json = JSON.stringify(r);
    return Buffer.byteLength(json) <= MAX_BODY_BYTES ? json : null;
  };
  const cut = (s: Run['steps'][number], cap: number) =>
    s.payload.length <= cap ? s : { ...s, payload: s.payload.slice(0, cap), fullChars: s.fullChars ?? s.payload.length };
  let json = fits(run);
  if (json) return { json, truncated: false };
  for (const cap of [4000, 2000, 1000, 500, 200]) {
    json = fits({ ...run, steps: run.steps.map((s) => cut(s, cap)) });
    if (json) return { json, truncated: true };
  }
  const skeleton = run.steps.map((s) =>
    s.kind === 'tool_result' || (s.kind === 'model_turn' && s.name === 'assistant') ? cut(s, 0) : cut(s, 200),
  );
  json = fits({ ...run, steps: skeleton });
  if (json) return { json, truncated: true };
  return { json: JSON.stringify({ ...run, steps: [...skeleton.slice(0, 800), ...skeleton.slice(-800)] }), truncated: true };
}

/** POST a recorded run to the pre-parsed ingest path. Never throws. */
export async function uploadRun(run: Run, target: UploadTarget): Promise<UploadResult> {
  const sessionId = run.runId;
  try {
    const { json, truncated } = shrinkToFit(run);
    const res = await target.fetch(`${target.server}/api/v1/ingest`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        'content-type': 'application/json',
        'x-effigent-session-id': sessionId,
        'x-effigent-agent-id': target.agent,
        'x-effigent-format': 'run',
        // Lets the collector refuse runtime uploads for workspaces that have not chosen the runtime.
        'x-effigent-source': 'runtime',
      },
      body: json,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      ok: res.ok,
      status: res.status,
      sessionId,
      truncated,
      detail: res.ok ? undefined : await res.text().catch(() => undefined),
    };
  } catch (err) {
    return { ok: false, status: 0, sessionId, detail: err instanceof Error ? err.message : String(err) };
  }
}
