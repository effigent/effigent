import { gunzipSync } from 'node:zlib';
import { authenticateKey, persistRun } from '@/lib/agent-auth.ts';
import { StorageNotProvisioned } from '@/lib/storage.ts';
import { parseTranscript } from '@/lib/engine/transcript.ts';

const notProvisioned = () =>
  Response.json(
    { error: 'workspace storage not provisioned', hint: 'an org admin must configure S3 storage before capture can start' },
    { status: 409 },
  );

/**
 * Translate a persist failure into a response the CLI can actually act on.
 *
 * A bare `throw` here becomes a 500 with an EMPTY body, which is what let a 100%
 * ingest failure rate (the `runs.parsed` not-null violation, migration 013) look
 * indistinguishable from a network blip for weeks: the hook logged
 * "upload failed (HTTP 500)" with no detail, and nobody could tell why. The blob
 * is already in S3 by the time we get here, so a failure at this point means an
 * orphaned object — say so loudly, and echo the Postgres specifics.
 */
const persistFailed = (err: unknown, sessionId: string) => {
  if (err instanceof StorageNotProvisioned) return notProvisioned();
  const pgErr = err as { code?: string; table?: string; column?: string; constraint?: string; message?: string };
  console.error(
    `[ingest] persist FAILED for session ${sessionId} — blob may be orphaned in S3.`,
    JSON.stringify({ code: pgErr?.code, table: pgErr?.table, column: pgErr?.column, constraint: pgErr?.constraint, message: pgErr?.message }),
  );
  return Response.json(
    {
      error: 'could not persist run',
      // Enough for the operator to diagnose from the CLI output alone; no row data.
      dbCode: pgErr?.code,
      dbTable: pgErr?.table,
      dbColumn: pgErr?.column,
      hint:
        pgErr?.code === '23502'
          ? 'not-null violation — a schema migration is missing on this database (see migration 013)'
          : 'the run blob was written to S3 but its metadata row failed; retrying the upload is safe (upsert)',
    },
    { status: 500 },
  );
};

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface RunLike {
  runId?: string;
  agentId?: string;
  models?: string[];
  usageByModel?: Record<string, { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }>;
  costUsd?: number;
  startedAt?: string;
  endedAt?: string;
  firstPrompt?: string;
  finalOutput?: string;
  steps?: Array<{ kind: string; name: string; payload: string; isError?: boolean; toolUseId?: string; timestamp?: string }>;
}

/**
 * Transcript ingest (Claude Code SessionEnd hook / `effigent run` / `effigent sync`).
 * Bearer key; session id via header. Two body shapes:
 *  - gzipped (or plain) JSONL transcript (default)
 *  - `x-effigent-format: run` + JSON — a Run the CLI pre-parsed locally, used when
 *    the transcript exceeds the platform body cap (~4.5 MB). Same persist path,
 *    same redaction; the scoped key still forces attribution.
 *
 * Headers are `x-effigent-*`; the legacy `x-ccopt-*` names are still read as a
 * fallback so CLIs published before the rename keep uploading. Remove once no
 * pre-rename CLI is in the wild.
 */
export async function POST(req: Request) {
  const auth = await authenticateKey(req.headers.get('authorization'));
  if (!auth) return Response.json({ error: 'invalid API key' }, { status: 401 });

  const sessionId =
    req.headers.get('x-effigent-session-id') ?? req.headers.get('x-ccopt-session-id') ?? '';
  if (!sessionId) return Response.json({ error: 'x-effigent-session-id header required' }, { status: 400 });
  const agentIdHeader =
    req.headers.get('x-effigent-agent-id') ?? req.headers.get('x-ccopt-agent-id') ?? undefined;

  // Pre-parsed Run path (large sessions).
  if ((req.headers.get('x-effigent-format') ?? req.headers.get('x-ccopt-format')) === 'run') {
    let run: RunLike;
    try {
      run = (await req.json()) as RunLike;
    } catch {
      return Response.json({ error: 'invalid run JSON' }, { status: 400 });
    }
    if (!Array.isArray(run.steps) || run.steps.length === 0) {
      return Response.json({ error: 'run.steps required' }, { status: 400 });
    }
    const effectiveAgentId = auth.agentName ?? agentIdHeader ?? run.agentId ?? 'unknown-agent';
    const full = {
      runId: run.runId ?? sessionId,
      agentId: effectiveAgentId,
      models: run.models ?? [],
      usageByModel: run.usageByModel ?? {},
      costUsd: typeof run.costUsd === 'number' ? run.costUsd : 0,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      firstPrompt: run.firstPrompt,
      finalOutput: run.finalOutput,
      steps: run.steps,
    };
    // persistRun redacts + trims payloads — same choke point as the raw path.
    try {
      await persistRun(auth, sessionId, full as Parameters<typeof persistRun>[2]);
    } catch (err) {
      return persistFailed(err, sessionId);
    }
    return Response.json({ parsed: true, agentId: effectiveAgentId, costUsd: full.costUsd, preparsed: true });
  }

  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length === 0) return Response.json({ error: 'binary body required' }, { status: 400 });

  let jsonl: string;
  try {
    // Vercel may strip content-encoding; sniff the gzip magic bytes instead.
    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    jsonl = (isGzip ? gunzipSync(raw) : raw).toString('utf8');
  } catch {
    return Response.json({ error: 'failed to decompress body' }, { status: 400 });
  }

  // A scoped agent key binds attribution to its agent — it wins over the
  // client-supplied header (a leaked key must not be able to spoof another agent).
  const effectiveAgentId = auth.agentName ?? agentIdHeader;

  const run = parseTranscript(jsonl, { agentId: effectiveAgentId });
  if (!run) return Response.json({ parsed: false, reason: 'no assistant activity' }, { status: 202 });

  try {
    await persistRun(auth, sessionId, run);
  } catch (err) {
    return persistFailed(err, sessionId);
  }
  return Response.json({ parsed: true, agentId: run.agentId, costUsd: run.costUsd });
}
