import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { loadRun } from '@/lib/storage.ts';
import { buildRunGraph } from '@/lib/engine/graph.ts';
import { buildRunBrief, renderBriefText } from '@/lib/engine/brief.ts';
import { computeRunLedger, aggregateLedgers } from '@/lib/engine/ledger.ts';
import { suggestTools } from '@/lib/engine/suggest.ts';
import { callOpenRouter, hasOpenRouterKey } from '@/lib/openrouter.ts';
import type { Run } from '@/lib/engine/types.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * The AI analyst — reads the last N runs of ONE agent (as compact briefs, not
 * raw transcripts) together with the deterministic evidence (waste ledger,
 * mined tool suggestions) and writes the agent-level story: what this agent is
 * used for, where its money goes, what recurs, and the few changes worth
 * making. Roadmap item #3, scoped to redacted briefs.
 */

const MODEL = process.env.EFFIGENT_ANALYST_MODEL ?? process.env.EFFIGENT_EXPLAIN_MODEL ?? 'anthropic/claude-sonnet-4.5';
const WINDOW = 12;

const CACHE = new Map<string, { at: number; analysis: string; runCount: number }>();
const TTL_MS = 10 * 60 * 1000;

export async function GET(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!hasOpenRouterKey()) {
    return Response.json({ error: 'the AI analyst needs OPENROUTER_API_KEY on the server' }, { status: 501 });
  }
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  const agent = new URL(req.url).searchParams.get('agent');
  if (!agent) return Response.json({ error: 'agent required' }, { status: 400 });

  const cacheKey = `${tenantId}|${agent}`;
  const hit = CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return Response.json({ analysis: hit.analysis, runCount: hit.runCount, model: MODEL, cached: true });
  }

  const { rows } = await pool.query(
    `select session_id, agent_id, started_at, cost_usd, blob_path, parsed
       from runs where tenant_id = $1 and agent_id = $2
       order by started_at desc nulls last limit ${WINDOW}`,
    [tenantId, agent],
  );
  if (!rows.length) return Response.json({ error: 'no runs for this agent' }, { status: 404 });

  const loaded = await Promise.all(rows.map((r) => loadRun(tenantId, r.blob_path ?? null, r.parsed ?? null)));
  const runs: Run[] = [];
  rows.forEach((r, i) => {
    const run = loaded[i];
    if (!run?.steps?.length) return;
    runs.push({
      ...run,
      runId: r.session_id,
      agentId: r.agent_id,
      costUsd: Number(r.cost_usd ?? run.costUsd ?? 0),
      usageByModel: run.usageByModel ?? {},
    });
  });
  if (!runs.length) return Response.json({ error: 'run content unavailable' }, { status: 404 });

  const graphs = runs.map(buildRunGraph);
  const briefs = graphs.map((g, i) => renderBriefText(buildRunBrief(runs[i], g)));
  const ledger = aggregateLedgers(runs.map((r, i) => computeRunLedger(r, graphs[i])));
  const suggestions = suggestTools(graphs);

  const evidence = [
    `WASTE LEDGER over these ${runs.length} runs (independent per-class estimates, total spend $${ledger.totalUsd.toFixed(2)}):`,
    `  cache misses ~$${ledger.slices.cacheMissUsd.toFixed(2)} (hit rate ${(ledger.cacheHitRate * 100).toFixed(1)}%) · error recovery ~$${ledger.slices.errorRecoveryUsd.toFixed(2)} (${ledger.errorCount} errors) · dead context ~$${ledger.slices.deadContextUsd.toFixed(2)} · redundant calls ~$${ledger.slices.redundantUsd.toFixed(2)}`,
    '',
    suggestions.length
      ? `RECURRING WORKFLOWS mined across runs (tool candidates):\n${suggestions
          .slice(0, 5)
          .map((s) => `  - ${s.actions.join(' → ')} · ${s.support}/${s.runsTotal} runs · ${s.occurrences}× · $${s.totalCostUsd.toFixed(2)} · e.g. "${s.exampleAsks[0] ?? ''}"`)
          .join('\n')}`
      : 'RECURRING WORKFLOWS: none passed the evidence gates.',
  ].join('\n');

  const prompt = [
    `You are the analyst for the AI agent "${agent}". Below: compact briefs of its last ${runs.length} sessions`,
    '(episode skeletons + excerpts; sensitive values already redacted), then deterministic measurements.',
    '',
    '===== SESSION BRIEFS =====',
    briefs.join('\n\n---\n\n'),
    '',
    '===== MEASUREMENTS =====',
    evidence,
    '',
    'Write the agent brief for the engineer who owns it, in plain markdown (### section headers), exactly these sections:',
    '### What this agent does — the actual task mix you see in the briefs, 2-3 sentences, concrete.',
    '### Where the money goes — tie session patterns to the measurements; name the expensive habits with run/episode evidence.',
    '### What recurs — recurring asks/workflows worth turning into tools or skills; reference the mined workflows if they match what you see, and call out any you see that the miner missed.',
    '### Top 3 changes — numbered, most valuable first. Each: the change, the evidence, the estimated impact. Only changes the data supports.',
    '',
    'Rules: cite session/episode evidence for every claim ("in 4 of 12 sessions…"). Never invent runs or numbers.',
    'If evidence is thin for a section, say so plainly rather than padding. Under 450 words total.',
  ].join('\n');

  try {
    const analysis = (await callOpenRouter(MODEL, prompt, { maxTokens: 1600, timeoutMs: 100_000 })).trim();
    if (!analysis) return Response.json({ error: 'model returned nothing' }, { status: 502 });
    CACHE.set(cacheKey, { at: Date.now(), analysis, runCount: runs.length });
    return Response.json({ analysis, runCount: runs.length, model: MODEL, cached: false });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'analyst failed' }, { status: 502 });
  }
}
