import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { loadRun } from '@/lib/storage.ts';
import { buildRunGraph } from '@/lib/engine/graph.ts';
import { buildRunBrief, renderBriefText } from '@/lib/engine/brief.ts';
import { analyzeAgent } from '@/lib/engine/plan.ts';
import { runCostUsd } from '@/lib/engine/cost.ts';
import { callOpenRouter, hasOpenRouterKey } from '@/lib/openrouter.ts';
import type { Run } from '@/lib/engine/types.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * The AI analyst — reads the last N runs of ONE agent (as compact briefs, not
 * raw transcripts) together with the MEASURED analysis (engine/plan.ts: spend
 * anatomy, request-reason mix, the session law + EOQ point, explained expensive
 * sessions, priced changes, detected adoptions) and, reasoning first (an explicit
 * reasoning budget), writes the agent-level story: what this agent is
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
      costUsd: runCostUsd(run) || Number(r.cost_usd ?? run.costUsd ?? 0),
      usageByModel: run.usageByModel ?? {},
    });
  });
  if (!runs.length) return Response.json({ error: 'run content unavailable' }, { status: 404 });

  const graphs = runs.map(buildRunGraph);
  const briefs = graphs.map((g, i) => renderBriefText(buildRunBrief(runs[i], g)));
  // Evidence = the measured analysis (identities + per-agent fits), not heuristics.
  const a = analyzeAgent(agent, runs);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const evidence = [
    `SPEND over these ${runs.length} runs: $${a.costUsd.toFixed(2)} — re-reading context $${a.spend.cacheReadUsd.toFixed(2)}, writing context $${(a.spend.cacheWriteUsd + a.spend.uncachedUsd).toFixed(2)}, side model/advisor $${a.spend.sideModelUsd.toFixed(2)}, generating $${(a.spend.outputUsd + a.spend.thinkingUsd).toFixed(2)}. (Rent identity ${a.calibration.toFixed(3)}; CLAUDE.md ${Math.round(a.instructionsTokens / 1000)}k tokens.)`,
    `REQUESTS WERE FOR: ${a.laws.reasons.map((r) => `${r.reason} ${pct(r.share)} at ~${Math.round(r.avgContext / 1000)}k context`).join('; ')}.`,
    a.laws.law ? `SESSION LAW: cost ≈ read·(B·N + d·N²/2) + write·(B + d·N), fit R² ${a.laws.law.fitR2.toFixed(2)}; B=${Math.round(a.laws.law.baseTokens / 1000)}k, d=${a.laws.law.depositPerRequest} tokens/request; ${pct(a.laws.law.aboveThresholdShare)} of re-reading is above the EOQ compaction point ${Math.round(a.laws.law.eoqThreshold / 1000)}k.` : 'SESSION LAW: too few sessions to fit.',
    a.laws.drivers ? `COST DIFFERENCES BETWEEN SESSIONS: ${pct(a.laws.drivers.requests)} length, ${pct(a.laws.drivers.context)} context size, ${pct(a.laws.drivers.price)} price.` : '',
    `EXPENSIVE SESSIONS: ${a.laws.expensive.map((e) => `$${e.costUsd.toFixed(2)} "${e.title ?? e.runId}" (${e.requestsX.toFixed(1)}× requests, ${e.contextX.toFixed(1)}× context vs median; ${pct(e.topReasonShare)} ${e.topReason})`).join('; ') || 'n/a'}.`,
    `PRICED CHANGES (already computed — do not re-derive numbers): ${a.plan.map((p) => `[${p.basis}] ${p.title}${p.savingsUsd ? ` $${p.savingsUsd.low.toFixed(0)}–$${p.savingsUsd.high.toFixed(0)}` : ''}`).join('; ') || 'none'}.`,
    a.loop.length ? `CHANGES IN EFFECT: ${a.loop.map((o) => `${o.lever} since ${o.adoptedAt.slice(0, 10)}: ${o.status}`).join('; ')}.` : 'CHANGES IN EFFECT: none detected.',
  ].filter(Boolean).join('\n');

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
    '### What recurs — recurring asks or procedures in the briefs that a skill or subagent would take over; say plainly if nothing recurs.',
    '### Top 3 changes — numbered, most valuable first. Each: the change, the evidence, the estimated impact. Only changes the data supports.',
    '',
    'Rules: cite session/episode evidence for every claim ("in 4 of 12 sessions…"). Never invent runs or numbers.',
    'If evidence is thin for a section, say so plainly rather than padding. Under 450 words total.',
  ].join('\n');

  try {
    // Reason before writing: the measurements are dense and the briefs long. Claude needs
    // max_tokens above the reasoning budget, so the answer keeps ~4k tokens of room.
    const analysis = (await callOpenRouter(MODEL, prompt, {
      maxTokens: 12_000,
      timeoutMs: 110_000,
      reasoning: { max_tokens: 8_000, exclude: true },
    })).trim();
    if (!analysis) return Response.json({ error: 'model returned nothing' }, { status: 502 });
    CACHE.set(cacheKey, { at: Date.now(), analysis, runCount: runs.length });
    return Response.json({ analysis, runCount: runs.length, model: MODEL, cached: false });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'analyst failed' }, { status: 502 });
  }
}
