import { pool } from '@/lib/db.ts';
import { resolveCaller, agentFor } from '@/lib/caller.ts';
import { loadRun } from '@/lib/storage.ts';
import { runCostUsd } from '@/lib/engine/cost.ts';
import { measureEffect, type EffectMeasurement } from '@/lib/engine/experiments.ts';
import { loadRecord, saveRecord } from '@/lib/experiments-store.ts';
import type { Run } from '@/lib/engine/types.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Results: what Effigent suggested for an agent, and — for everything applied —
 * whether it actually saved tokens (engine/experiments.ts: matched before/after,
 * bootstrap interval, quality guard, mechanism check).
 *
 * GET  ?agent=  → every recorded recommendation with its measured result
 * POST { agent, recId, appliedAt?, undo? } → mark a recommendation applied (or undo)
 *
 * A signed-in dashboard user, or a Bearer key (`effigent applied`, so the coding agent
 * that made the change can record it); a scoped key acts on its own agent only.
 */

const BEFORE = 20;
const AFTER = 40;

interface Row { session_id: string; agent_id: string; started_at: string | null; cost_usd: string | number | null; blob_path: string | null; parsed: Run | null }

async function runsAround(tenantId: string, agent: string, at: string): Promise<Run[]> {
  const cols = 'session_id, agent_id, started_at, cost_usd, blob_path, parsed';
  const [b, a] = await Promise.all([
    pool.query<Row>(`select ${cols} from runs where tenant_id = $1 and agent_id = $2 and started_at < $3 order by started_at desc limit ${BEFORE}`, [tenantId, agent, at]),
    pool.query<Row>(`select ${cols} from runs where tenant_id = $1 and agent_id = $2 and started_at >= $3 order by started_at asc limit ${AFTER}`, [tenantId, agent, at]),
  ]);
  const rows = [...b.rows, ...a.rows];
  const loaded = await Promise.all(rows.map((r) => loadRun(tenantId, r.blob_path, r.parsed).catch(() => null)));
  const out: Run[] = [];
  rows.forEach((r, i) => {
    const run = loaded[i];
    if (!run?.steps?.length) return;
    out.push({
      ...run,
      runId: r.session_id,
      agentId: r.agent_id,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : run.startedAt,
      usageByModel: run.usageByModel ?? {},
      costUsd: runCostUsd(run) || Number(r.cost_usd ?? run.costUsd ?? 0),
    });
  });
  return out;
}

const round = (m: EffectMeasurement) => {
  const r = (v: number) => Number(v.toFixed(4));
  const mm = (x: EffectMeasurement['tokensPerRequest']) => x && { before: r(x.before), after: r(x.after), changePct: r(x.changePct), ci: [r(x.ci[0]), r(x.ci[1])] };
  return { ...m, tokensPerRequest: mm(m.tokensPerRequest), costPerRequest: mm(m.costPerRequest), primary: m.primary && { ...mm(m.primary)!, name: m.primary.name },
    realizedPerMonthUsd: m.realizedPerMonthUsd == null ? null : Number(m.realizedPerMonthUsd.toFixed(2)) };
};

export async function GET(req: Request) {
  const caller = await resolveCaller(req);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = caller.tenantId;
  const which = agentFor(caller, new URL(req.url).searchParams.get('agent'));
  if ('error' in which) return Response.json({ error: which.error }, { status: which.status });
  const agent = which.agent;
  try {
    const record = await loadRecord(tenantId, agent);
    const recs = Object.values(record.recommendations);
    const results = await Promise.all(recs.map(async (rec) => {
      if (!rec.appliedAt) return { ...rec, result: null };
      try {
        const runs = await runsAround(tenantId, agent, rec.appliedAt);
        return { ...rec, result: round(measureEffect(runs, rec.appliedAt, rec.recId, rec.params ?? {})) };
      } catch (err) {
        console.error(`[experiments] measure failed tenant=${tenantId} agent=${agent} rec=${rec.recId}:`, err);
        return { ...rec, result: null };
      }
    }));
    results.sort((x, y) => (y.appliedAt ? 1 : 0) - (x.appliedAt ? 1 : 0) || (y.predictedPerMonthUsd?.high ?? 0) - (x.predictedPerMonthUsd?.high ?? 0));
    return Response.json({ agent, experiments: results });
  } catch (err) {
    console.error(`[experiments] failed tenant=${tenantId} agent=${agent}:`, err);
    return Response.json({ agent, experiments: [], note: 'Run storage is not set up for this workspace yet.' });
  }
}

export async function POST(req: Request) {
  const caller = await resolveCaller(req);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = caller.tenantId;
  let body: { agent?: string; recId?: string; appliedAt?: string; undo?: boolean };
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const which = agentFor(caller, body.agent);
  if ('error' in which) return Response.json({ error: which.error }, { status: which.status });
  if (!body.recId) return Response.json({ error: 'recId is required' }, { status: 400 });
  const record = await loadRecord(tenantId, which.agent);
  const rec = record.recommendations[body.recId];
  if (!rec) return Response.json({ error: 'This recommendation has not been suggested for this agent. Run `effigent recommendations` or open Insights first.' }, { status: 404 });
  if (body.undo) {
    delete rec.appliedAt; delete rec.appliedBy; delete rec.source;
  } else {
    const at = body.appliedAt ? new Date(body.appliedAt) : new Date();
    if (Number.isNaN(at.getTime())) return Response.json({ error: 'appliedAt is not a date' }, { status: 400 });
    if (at.getTime() > Date.now() + 86_400_000) return Response.json({ error: 'appliedAt cannot be in the future' }, { status: 400 });
    rec.appliedAt = at.toISOString(); rec.appliedBy = caller.actor; rec.source = 'marked';
  }
  await saveRecord(tenantId, record);
  return Response.json({ ok: true, recommendation: rec });
}
