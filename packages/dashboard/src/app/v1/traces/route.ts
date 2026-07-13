import { authenticateKey, persistRun } from '@/lib/agent-auth.ts';
import { StorageNotProvisioned } from '@/lib/storage.ts';
import { otelToRuns, type OtlpTracesPayload } from '@/lib/engine/otel.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * OTLP/HTTP GenAI traces (OpenLLMetry, Codex, any OTel exporter).
 * Requires uncompressed JSON: OTEL_EXPORTER_OTLP_PROTOCOL=http/json,
 * OTEL_EXPORTER_OTLP_COMPRESSION=none. Bearer cck_ key.
 */
export async function POST(req: Request) {
  const auth = await authenticateKey(req.headers.get('authorization'));
  if (!auth) return Response.json({ error: 'invalid API key' }, { status: 401 });

  let payload: OtlpTracesPayload;
  try {
    payload = (await req.json()) as OtlpTracesPayload;
  } catch {
    return Response.json(
      {
        error: 'send OTLP/HTTP as uncompressed JSON',
        hint: 'set OTEL_EXPORTER_OTLP_PROTOCOL=http/json and OTEL_EXPORTER_OTLP_COMPRESSION=none',
      },
      { status: 415 },
    );
  }

  const runs = otelToRuns(payload, {
    agentId: auth.agentName, // scoped key forces attribution; overrides span attrs
    defaultAgentId: 'unknown-otel-agent',
  });
  if (runs.length === 0) return Response.json({ parsed: false, runs: 0 }, { status: 202 });

  try {
    for (const run of runs) await persistRun(auth, run.runId, run);
  } catch (err) {
    if (err instanceof StorageNotProvisioned) {
      return Response.json(
        { error: 'workspace storage not provisioned', hint: 'an org admin must configure S3 storage before capture can start' },
        { status: 409 },
      );
    }
    throw err;
  }
  return Response.json({ parsed: true, runs: runs.length });
}
