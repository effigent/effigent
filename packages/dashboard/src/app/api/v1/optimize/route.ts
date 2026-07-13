import { authenticateKey } from '@/lib/agent-auth.ts';
import { pool } from '@/lib/db.ts';
import { buildRunGraph } from '@/lib/engine/graph.ts';
import { analyzeDeterminism } from '@/lib/engine/determinism.ts';
import { synthesizeTools } from '@/lib/engine/synthesize.ts';
import { replayToolSpec } from '@/lib/engine/replay.ts';
import { buildKnowledgeGraph, renderKnowledgeBundle, renderSlimContext } from '@/lib/engine/knowledge.ts';
import { detectDrift } from '@/lib/engine/drift.ts';
import { loadRun } from '@/lib/storage.ts';
import type { Run } from '@/lib/engine/types.ts';

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

// Tool injection is off for the insights-only POC: we still compute and return
// the analysis, but we do NOT stamp agents.optimized_at (the "Optimized" badge
// implies an active injection). Set EFFIGENT_ENABLE_INJECTION=1 to re-enable.
const INJECTION_ENABLED = process.env.EFFIGENT_ENABLE_INJECTION === '1';

interface RunRow {
  session_id: string;
  started_at: string | null;
  cost_usd: string | number | null;
  blob_path: string | null;
  parsed: Run | null; // legacy inline rows; null for S3-stored runs
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
    `select session_id, started_at, cost_usd, blob_path, parsed
       from runs where tenant_id = $1 and agent_id = $2
      order by started_at desc nulls last limit ${WINDOW}`,
    [auth.tenantId, agentId],
  );

  // Run content lives in the org's S3 bucket — load the window in parallel
  // (legacy pre-S3 rows carry inline `parsed`; loadRun handles both).
  const loaded = await Promise.all(rows.map((r) => loadRun(auth.tenantId, r.blob_path, r.parsed)));
  const runs: Run[] = rows
    .map((r, i) => {
      const run = loaded[i];
      if (!run?.steps?.length) return null;
      // pg returns timestamps as Date; the engine sorts startedAt as an ISO string.
      return {
        ...run,
        runId: r.session_id,
        agentId,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : run.startedAt,
        usageByModel: run.usageByModel ?? {},
        costUsd: Number(r.cost_usd ?? run.costUsd ?? 0),
      } as Run;
    })
    .filter((r): r is Run => r !== null);

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
    // OKF bundle (Open Knowledge Format) — interlinked markdown concept files the
    // agent navigates. Rendered server-side; the CLI just writes them to disk.
    const okf = knowledge?.worthIt
      ? renderKnowledgeBundle(knowledge, { generatedAt: new Date().toISOString() })
      : [];
    // The slim, budgeted knowledge actually pushed into the agent's context —
    // the smallest set of facts that stops it re-running the lookups. OKF (above)
    // + the explorer hold the full detail; only this goes in-prompt.
    const slimContext = knowledge?.worthIt ? renderSlimContext(knowledge) : null;

    const activatable = ready.length > 0 || (knowledge?.worthIt ?? false);
    if (INJECTION_ENABLED && url.searchParams.get('mark') === '1' && activatable) {
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
      okf,
      slimContext,
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
