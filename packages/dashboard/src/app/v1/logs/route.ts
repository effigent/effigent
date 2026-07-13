import { authenticateKey, persistRun } from '@/lib/agent-auth.ts';
import { otelLogsToRuns, type OtlpLogsPayload } from '@/lib/engine/otel.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * OTLP/HTTP GenAI log records. OpenAI Codex configures OTel only via
 * ~/.codex/config.toml and emits token usage as structured log EVENTS
 * (codex.sse_event, codex.tool_result, …) rather than on trace spans, so its
 * cost data arrives here. Requires uncompressed JSON:
 * protocol = "json" on the config.toml otlp-http exporter. Bearer cck_ key.
 */
export async function POST(req: Request) {
  const auth = await authenticateKey(req.headers.get('authorization'));
  if (!auth) return Response.json({ error: 'invalid API key' }, { status: 401 });

  let payload: OtlpLogsPayload;
  try {
    payload = (await req.json()) as OtlpLogsPayload;
  } catch {
    return Response.json(
      {
        error: 'send OTLP/HTTP logs as uncompressed JSON',
        hint: 'in ~/.codex/config.toml set the otlp-http exporter protocol = "json"',
      },
      { status: 415 },
    );
  }

  const runs = otelLogsToRuns(payload, {
    agentId: auth.agentName, // scoped key forces attribution; overrides record attrs
    defaultAgentId: 'unknown-otel-agent',
  });
  if (runs.length === 0) return Response.json({ parsed: false, runs: 0 }, { status: 202 });

  for (const run of runs) await persistRun(auth, run.runId, run);
  return Response.json({ parsed: true, runs: runs.length });
}
