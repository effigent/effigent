import { pool } from '@/lib/db.ts';
import { resolveCaller, agentFor } from '@/lib/caller.ts';
import { loadRun } from '@/lib/storage.ts';
import { runCostUsd } from '@/lib/engine/cost.ts';
import { analyzeAgent } from '@/lib/engine/plan.ts';
import { summarizeAgent } from '@/lib/engine/summary.ts';
import { loadRecord, saveRecord, mergeSuggestions } from '@/lib/experiments-store.ts';
import type { Run } from '@/lib/engine/types.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * The plan for one agent, in the form a coding agent applies it:
 * `GET ?agent=` → every recommended change with its files, basis, predicted
 * value and applied state. The same analysis as Insights (plan.ts + summary.ts
 * over the last WINDOW sessions), and — like Insights — it records what was
 * suggested, so `effigent applied <id>` can mark it without opening the
 * dashboard. Bearer key (`effigent recommendations`) or a signed-in user.
 */

const WINDOW = 40;

interface Row { session_id: string; agent_id: string; started_at: string | null; cost_usd: string | number | null; blob_path: string | null; parsed: Run | null }

export async function GET(req: Request) {
  const caller = await resolveCaller(req);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const which = agentFor(caller, new URL(req.url).searchParams.get('agent'));
  if ('error' in which) return Response.json({ error: which.error }, { status: which.status });
  const { tenantId } = caller, agent = which.agent;

  const { rows } = await pool.query<Row>(
    `select session_id, agent_id, started_at, cost_usd, blob_path, parsed from runs
      where tenant_id = $1 and agent_id = $2 order by started_at desc nulls last limit ${WINDOW}`,
    [tenantId, agent],
  );
  const loaded = await Promise.all(rows.map((r) => loadRun(tenantId, r.blob_path, r.parsed).catch(() => null)));
  const runs: Run[] = [];
  rows.forEach((r, i) => {
    const run = loaded[i];
    if (!run?.steps?.length) return;
    runs.push({
      ...run,
      runId: r.session_id,
      agentId: r.agent_id,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : run.startedAt,
      usageByModel: run.usageByModel ?? {},
      costUsd: runCostUsd(run) || Number(r.cost_usd ?? run.costUsd ?? 0),
    });
  });
  if (!runs.length) return Response.json({ agent, sessions: 0, recommendations: [], notes: [], note: `No sessions captured for '${agent}' yet.` });

  const analysis = analyzeAgent(agent, runs);
  const summary = summarizeAgent(analysis, runs);
  let record = { agentId: agent, recommendations: {} } as Awaited<ReturnType<typeof loadRecord>>;
  try {
    record = await loadRecord(tenantId, agent);
    if (mergeSuggestions(record, summary.actions, {
      now: new Date().toISOString(),
      threshold: analysis.compaction.threshold,
      detected: analysis.loop.map((o) => ({ lever: o.lever, adoptedAt: o.adoptedAt })),
    })) await saveRecord(tenantId, record);
  } catch (err) {
    console.error(`[recommendations] record not updated tenant=${tenantId} agent=${agent}:`, err);
  }

  const r2 = (v: number) => Math.round(v * 100) / 100;
  const inActions = new Set(summary.actions.map((a) => a.id));
  return Response.json({
    agent,
    sessions: runs.length,
    headline: summary.headline,
    recommendations: summary.actions.map((a) => {
      const rec = record.recommendations[a.id];
      return {
        id: a.id,
        title: a.title,
        why: a.why,
        basis: a.basis,
        perMonthUsd: a.perMonthUsd && { low: r2(a.perMonthUsd.low), high: r2(a.perMonthUsd.high) },
        files: a.files,
        appliedAt: rec?.appliedAt ?? null,
        source: rec?.source ?? null,
      };
    }),
    // Findings that are not a file to write (e.g. advisor spend) — for the person, not the agent.
    notes: analysis.plan.filter((p) => !inActions.has(p.id) && p.id !== 'recapture').map((p) => ({ id: p.id, title: p.title, why: p.summary })),
  });
}
