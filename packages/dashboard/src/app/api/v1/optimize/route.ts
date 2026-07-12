import { authenticateKey } from '@/lib/agent-auth.ts';
import { pool } from '@/lib/db.ts';
import { buildRunGraph } from '@/lib/engine/graph.ts';
import { analyzeDeterminism } from '@/lib/engine/determinism.ts';
import { synthesizeTools } from '@/lib/engine/synthesize.ts';
import { replayToolSpec } from '@/lib/engine/replay.ts';
import { buildKnowledgeGraph } from '@/lib/engine/knowledge.ts';
import { detectDrift } from '@/lib/engine/drift.ts';
import type { RawStep, Run } from '@/lib/engine/types.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The activation bundle — what `effigent optimize <agent>` installs into the
 * running agent. Bearer key auth (scoped keys are pinned to their agent).
 * Returns replay-validated ToolSpecs + the knowledge graph for the agent's
 * last WINDOW runs; `?mark=1` stamps agents.optimized_at once something
 * activatable exists (the dashboard's Optimized badge).
 */

const WINDOW = 20;

interface DbStep {
  kind: RawStep['kind'];
  name: string;
  payload: string;
  isError?: boolean;
  toolUseId?: string;
  model?: string;
  tokens?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
  ms?: number;
  durationMs?: number;
}
interface RunRow {
  session_id: string;
  started_at: string | null;
  cost_usd: string | number | null;
  steps: DbStep[] | null;
  first_prompt: string | null;
  final_output: string | null;
  models: string[] | null;
}

export async function GET(req: Request) {
  const auth = await authenticateKey(req.headers.get('authorization'));
  if (!auth) return Response.json({ error: 'invalid API key' }, { status: 401 });

  const url = new URL(req.url);
  const requested = url.searchParams.get('agent') ?? undefined;
  // A scoped key can only optimize its own agent.
  const agentId = auth.agentName ?? requested;
  if (!agentId) return Response.json({ error: 'agent required (?agent= or a scoped key)' }, { status: 400 });
  if (auth.agentName && requested && requested !== auth.agentName) {
    return Response.json({ error: 'scoped key is bound to a different agent' }, { status: 403 });
  }

  const { rows } = await pool.query<RunRow>(
    `select session_id, started_at, cost_usd,
            parsed->'steps' as steps,
            parsed->>'firstPrompt' as first_prompt,
            parsed->>'finalOutput' as final_output,
            parsed->'models' as models
       from runs where tenant_id = $1 and agent_id = $2
      order by started_at desc nulls last limit ${WINDOW}`,
    [auth.tenantId, agentId],
  );

  const runs: Run[] = rows
    .filter((r) => r.steps?.length)
    .map((r) => ({
      runId: r.session_id,
      agentId,
      // pg returns timestamp columns as Date; the engine sorts startedAt as an
      // ISO string (localeCompare). Coerce at the boundary or the pipeline throws.
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
      models: r.models ?? [],
      usageByModel: {},
      costUsd: Number(r.cost_usd ?? 0),
      firstPrompt: r.first_prompt ?? undefined,
      finalOutput: r.final_output ?? undefined,
      steps: (r.steps ?? []).map((s) => ({
        kind: s.kind,
        name: s.name,
        payload: String(s.payload ?? ''),
        isError: s.isError,
        toolUseId: s.toolUseId,
        model: s.model,
        tokens: s.tokens,
        durationMs: s.durationMs ?? s.ms,
      })),
    }));

  if (runs.length < 2) {
    return Response.json(
      { agentId, window: WINDOW, runCount: runs.length, tools: [], knowledge: null, drift: null,
        note: 'not enough history — the brain needs at least a few runs' },
      { status: 200 },
    );
  }

  // The engine pipeline is the untested-on-real-data path. A single malformed
  // run must never take the whole endpoint down (a bare 500 breaks `effigent
  // optimize` and the SessionStart auto-injection). Contain any throw, log it
  // for diagnosis, and degrade to an empty bundle — the CLI's refresh is
  // fail-open by design, so the agent keeps working.
  try {
    const graphs = runs.map(buildRunGraph);
    const analyses = analyzeDeterminism(graphs);
    const drift = detectDrift(graphs);

    const tools = synthesizeTools(analyses).map((spec) => {
      const analysis = analyses.find((a) => a.l1 === spec.clusterKey);
      const replay = analysis ? replayToolSpec(spec, analysis) : undefined;
      return { ...spec, replay };
    });

    // Persist the synthesized set (source of truth for the dashboard's per-tool
    // switches) WITHOUT touching `enabled` — the owner's disables survive every
    // regeneration and drop those tools from the bundle. Table-guarded until
    // migration 011 runs.
    let disabled = new Set<string>();
    try {
      for (const t of tools) {
        await pool.query(
          `insert into agent_tools (tenant_id, agent_id, tool_id, name, status, spec)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (tenant_id, agent_id, tool_id) do update
             set name = excluded.name, status = excluded.status, spec = excluded.spec, updated_at = now()`,
          [auth.tenantId, agentId, t.id, t.name, t.replay?.status ?? 'shadow', JSON.stringify(t)],
        );
      }
      const off = await pool.query<{ tool_id: string }>(
        `select tool_id from agent_tools where tenant_id=$1 and agent_id=$2 and enabled=false`,
        [auth.tenantId, agentId],
      );
      disabled = new Set(off.rows.map((r) => r.tool_id));
    } catch {
      /* agent_tools not migrated yet — no per-tool switches */
    }
    const activeTools = tools.filter((t) => !disabled.has(t.id));
    const ready = activeTools.filter((t) => t.replay?.status === 'ready');
    const knowledge = buildKnowledgeGraph(analyses).find((k) => k.agentId === agentId) ?? null;

    const activatable = ready.length > 0 || (knowledge?.worthIt ?? false);
    if (url.searchParams.get('mark') === '1' && activatable) {
      await pool
        .query(
          `update agents set optimized_at = now() where tenant_id = $1 and name = $2`,
          [auth.tenantId, agentId],
        )
        .catch(() => {/* agents row may not exist for unregistered ids */});
    }

    return Response.json({
      agentId,
      window: WINDOW,
      runCount: runs.length,
      generatedAt: new Date().toISOString(),
      tools: activeTools,
      readyTools: ready.length,
      disabledTools: disabled.size,
      knowledge,
      drift: drift ? { changed: drift.changed, changedAt: drift.changedAt, z: drift.z } : null,
      activatable,
    });
  } catch (err) {
    console.error(
      `[optimize] pipeline failed tenant=${auth.tenantId} agent=${agentId} runs=${runs.length}:`,
      err,
    );
    return Response.json(
      {
        agentId, window: WINDOW, runCount: runs.length,
        tools: [], readyTools: 0, disabledTools: 0, knowledge: null, drift: null,
        activatable: false, degraded: true,
        note: 'analysis temporarily unavailable — the run set could not be analyzed',
      },
      { status: 200 },
    );
  }
}
