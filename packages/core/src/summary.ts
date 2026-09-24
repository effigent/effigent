/**
 * The agent summary — the analysis turned into what a person reads first.
 *
 * analyzeAgent (plan.ts) measures; this module decides what is WORTH SAYING and
 * says it in plain language, in dollars per month, in priority order:
 *
 *   headline   one sentence: spend, pace, and whether it is getting worse (and why)
 *   actions    the priced changes, ranked by expected monthly value
 *   findings   3–6 cards, each one number + one sentence, only when material
 *   sessions   the most expensive sessions, and what the top fix would have saved
 *   trend      weekly cost per request and base context, with the cause of a change
 *
 * Rules: a finding appears only if it moves ≥3% of spend or is a ≥1.5× shift;
 * money is always per month at the observed pace (window spend × 30 / window
 * days, window ≥7 days); every number comes from the analysis — nothing here
 * measures anything new except breaks and the weekly trend, which are
 * identities over the same requests.
 */

import type { Run } from './types.js';
import { pricingFor } from './cost.js';
import { requestsOf, isLegacyParse, simulateCompaction, REACQUISITION_SCENARIOS } from './rent.js';
import type { AgentAnalysis, PlanItem } from './plan.js';

export interface SummaryAction {
  id: string;
  title: string;
  /** Plain one-line reason. */
  why: string;
  perMonthUsd: { low: number; high: number } | null;
  basis: PlanItem['basis'];
  files: PlanItem['files'];
}

export interface AgentFinding {
  id: 'concentration' | 'breaks' | 'context-creep' | 'instructions' | 'long-sessions' | 'verify-loop' | 'loops' | 'exploration' | 'advisor' | 'delivery';
  title: string;
  /** The one number, pre-formatted ("56%", "$143/mo", "2.3×"). */
  value: string;
  sentence: string;
  severity: 'high' | 'medium' | 'info';
  perMonthUsd?: number;
}

export interface SessionStory {
  runId: string;
  title?: string;
  startedAt?: string;
  costUsd: number;
  requestsX: number;
  peakContext: number;
  delivered: boolean;
  /** What compacting at the recommended threshold would have saved on this session. */
  compactionSavesUsd: number | null;
}

export interface WeekPoint { week: string; sessions: number; costUsd: number; costPerRequest: number; baseTokens: number }

export interface AgentSummary {
  window: { from?: string; to?: string; days: number; sessions: number; spendUsd: number; perMonthUsd: number };
  /** Sessions that committed, pushed or opened a PR (null when the capture has no outcome signals). */
  delivered: { sessions: number; commits: number; pushes: number; prs: number; costPerSessionUsd: number | null } | null;
  headline: string;
  actions: SummaryAction[];
  findings: AgentFinding[];
  sessions: SessionStory[];
  trend: { weeks: WeekPoint[]; costPerRequestChange: number | null; baseTokensChange: number | null; older?: { costPerRequest: number; baseTokens: number }; newer?: { costPerRequest: number; baseTokens: number } };
}

const MATERIAL = 0.03;
const BREAK_SECONDS = 3300; // the 1-hour cache TTL, minus slack
const BREAK_MIN_CONTEXT = 150_000;

const money = (v: number) => (v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

function weekOf(ts: string): string {
  const d = new Date(ts);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/** Returns to a long session after the cache expired, and what compacting before the break would have saved. */
function breaks(runs: Run[], compactionUsd: (context: number, model: string, base: number) => number) {
  let count = 0, paid = 0, avoidable = 0;
  for (const run of runs) {
    const R = requestsOf(run);
    const base = R[0]?.context ?? 0;
    for (let k = 1; k < R.length; k++) {
      const r = R[k], q = R[k - 1];
      if (!r.timestamp || !q.timestamp || r.model !== q.model) continue;
      const gap = (Date.parse(r.timestamp) - Date.parse(q.timestamp)) / 1000;
      if (gap < BREAK_SECONDS || q.context < BREAK_MIN_CONTEXT || r.cacheWrite < 0.5 * q.context) continue;
      const p = pricingFor(r.model);
      const wp = (p.inputPerM * (r.cacheWrite1h > 0 ? 2 : 1.25)) / 1e6;
      count++;
      paid += q.context * wp;
      // compacting first: pay the compaction, then re-warm only the small new prefix
      avoidable += Math.max(0, q.context * wp - compactionUsd(q.context, r.model, base) - (base + 12_000) * wp);
    }
  }
  return { count, paid, avoidable };
}

export function summarizeAgent(a: AgentAnalysis, allRuns: Run[]): AgentSummary {
  const runs = allRuns.filter((r) => !isLegacyParse(r));
  const starts = runs.map((r) => r.startedAt).filter((x): x is string => !!x).sort();
  const ends = runs.map((r) => r.endedAt ?? r.startedAt).filter((x): x is string => !!x).sort();
  const from = starts[0], to = ends[ends.length - 1];
  const days = from && to ? Math.max(7, (Date.parse(to) - Date.parse(from)) / 86_400_000) : 30;
  const perMonth = 30 / days;
  const spend = a.costUsd;
  const monthly = (v: number) => v * perMonth;

  // ---- trend (weekly) ----------------------------------------------------------------
  const wk = new Map<string, { sessions: number; cost: number; requests: number; base: number[] }>();
  for (const run of runs) {
    if (!run.startedAt) continue;
    const R = requestsOf(run);
    if (!R.length) continue;
    const w = wk.get(weekOf(run.startedAt)) ?? { sessions: 0, cost: 0, requests: 0, base: [] };
    w.sessions++; w.cost += run.costUsd; w.requests += R.length; w.base.push(R[0].context);
    wk.set(weekOf(run.startedAt), w);
  }
  const weeks: WeekPoint[] = [...wk.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([week, w]) => ({
    week, sessions: w.sessions, costUsd: w.cost, costPerRequest: w.requests ? w.cost / w.requests : 0, baseTokens: Math.round(mean(w.base)),
  }));
  // Older half vs newer half of the sessions: steadier than comparing single weeks,
  // whose cost per request swings with whichever sessions happened to land in them.
  const ordered = runs.filter((r) => r.startedAt).sort((x, y) => x.startedAt!.localeCompare(y.startedAt!));
  const half = (list: Run[]) => {
    const Rs = list.map((r) => requestsOf(r)).filter((R) => R.length);
    const req = Rs.reduce((s, R) => s + R.length, 0);
    return {
      since: list[0]?.startedAt?.slice(0, 10) ?? '',
      costPerRequest: req ? list.reduce((s, r) => s + r.costUsd, 0) / req : 0,
      baseTokens: Math.round(mean(Rs.map((R) => R[0].context))),
    };
  };
  const enough = ordered.length >= 8;
  const first = enough ? half(ordered.slice(0, Math.floor(ordered.length / 2))) : null;
  const last = enough ? half(ordered.slice(Math.floor(ordered.length / 2))) : null;
  const cprChange = first && last && first.costPerRequest > 0 ? last.costPerRequest / first.costPerRequest - 1 : null;
  const baseChange = first && last && first.baseTokens > 0 ? last.baseTokens / first.baseTokens - 1 : null;

  // ---- findings ---------------------------------------------------------------------
  const findings: AgentFinding[] = [];
  const costs = runs.map((r) => ({ r, c: r.costUsd })).sort((x, y) => y.c - x.c);
  if (costs.length >= 10) {
    const n = Math.ceil(costs.length * 0.1);
    const share = costs.slice(0, n).reduce((s, x) => s + x.c, 0) / Math.max(1e-9, spend);
    if (share >= 0.3) findings.push({
      id: 'concentration', title: 'A few long sessions drive the bill', value: pct(share), severity: share >= 0.5 ? 'high' : 'medium',
      sentence: `The ${n} most expensive of ${costs.length} sessions cost ${pct(share)} of the total. A session's cost grows with the square of its length.`,
    });
  }
  const law = a.laws.law;
  if (law) {
    const K = (ctx: number, model: string, base: number) => {
      const p = pricingFor(model); const rp = (p.inputPerM * (p.cacheReadMult ?? 0.1)) / 1e6, wp = (p.inputPerM * 2) / 1e6, op = p.outputPerM / 1e6;
      return ctx * rp + 12_000 * op + (base + 27_000) * wp + 8 * ((base + 12_000) * rp + 300 * op);
    };
    const b = breaks(runs, K);
    if (b.count >= 3 && b.paid >= MATERIAL * spend) findings.push({
      id: 'breaks', title: 'Breaks re-buy the whole conversation', value: `${money(monthly(b.paid))}/mo`, severity: b.avoidable >= MATERIAL * spend ? 'high' : 'medium',
      perMonthUsd: monthly(b.avoidable),
      sentence: `${b.count} returns to a 150k+ session after an hour away re-wrote its whole context (${money(b.paid)} here). Compacting first would have avoided ${money(b.avoidable)} of it.`,
    });
    if (law.aboveThresholdShare >= 0.15) findings.push({
      id: 'long-sessions', title: 'Sessions run past the point where compacting pays', value: pct(law.aboveThresholdShare), severity: law.aboveThresholdShare >= 0.4 ? 'high' : 'medium',
      sentence: `${pct(law.aboveThresholdShare)} of re-reading happened above ${Math.round(law.eoqThreshold / 1000)}k tokens, where one compaction (≈${money(law.compactionCostUsd)}) is cheaper than carrying the history.`,
    });
  }
  if (baseChange != null && baseChange >= 0.5 && first && last) {
    // every request re-reads the base: added tokens × the agent's measured read price
    const extraPerRequest = (last.baseTokens - first.baseTokens) * (a.laws.law?.readPricePerToken ?? 0);
    const reqPerMonth = monthly(runs.reduce((s, r) => s + requestsOf(r).length, 0));
    const instr = runs.map((r) => ({ t: r.startedAt ?? '', c: (r.instructions ?? []).reduce((s, f) => s + f.chars, 0) })).filter((x) => x.c > 0).sort((x, y) => x.t.localeCompare(y.t));
    const grew = instr.length >= 2 && instr[instr.length - 1].c > 1.5 * instr[0].c;
    findings.push({
      id: 'context-creep', title: 'Every request now starts with more context', value: `${(last.baseTokens / first.baseTokens).toFixed(1)}×`, severity: 'high',
      perMonthUsd: extraPerRequest * reqPerMonth,
      sentence: `Sessions now start at ${Math.round(last.baseTokens / 1000)}k tokens, up from ${Math.round(first.baseTokens / 1000)}k${grew ? `; CLAUDE.md grew from ${Math.round(instr[0].c / 1000)}k to ${Math.round(instr[instr.length - 1].c / 1000)}k characters` : ''}. That adds ${money(extraPerRequest)} to every request (≈${money(extraPerRequest * reqPerMonth)}/month).`,
    });
  }
  // CLAUDE.md & memory are re-read on every request: price them from the rent of the base
  if (!findings.some((f) => f.id === 'context-creep') && a.instructionsTokens > 0) {
    let rent = 0;
    for (const run of runs) {
      const t = (run.instructions ?? []).reduce((s2, f) => s2 + f.chars, 0) / 3.6;
      if (!t) continue;
      for (const r of requestsOf(run)) { const p = pricingFor(r.model); rent += (t * p.inputPerM * (p.cacheReadMult ?? 0.1)) / 1e6; }
    }
    const share = rent / Math.max(1e-9, spend);
    if (share >= 0.05) findings.push({
      id: 'instructions', title: 'CLAUDE.md is re-read on every request', value: `${Math.round(a.instructionsTokens / 1000)}k tokens`,
      severity: share >= 0.1 ? 'high' : 'medium', perMonthUsd: monthly(rent),
      sentence: `Re-reading the instruction files cost ${money(monthly(rent))}/month, ${pct(share)} of spend. Most of it is guidance a given session never touches.`,
    });
  }
  // the verify rule — the deterministic loop that is actually worth money
  const clean = a.loops.verify.reduce((s2, v) => s2 + v.cleanCostUsd, 0);
  const rechecks = a.loops.verify.reduce((s2, v) => s2 + v.reverifies, 0);
  const cleanN = a.loops.verify.reduce((s2, v) => s2 + v.clean, 0);
  if (rechecks >= 10 && clean >= MATERIAL * spend) findings.push({
    id: 'verify-loop', title: 'Checks after edits mostly confirm nothing', value: pct(cleanN / rechecks),
    severity: clean >= 0.05 * spend ? 'high' : 'medium', perMonthUsd: monthly(clean),
    sentence: `${cleanN} of ${rechecks} checks the agent ran after editing came back clean — ${money(monthly(clean))}/month of requests that only confirmed "no errors". Running the check is a rule, not a decision.`,
  });
  // other procedural loops (paging, per-item commands, retries, polling) — only when material
  const loopUsd = a.loops.patterns.reduce((s2, p) => s2 + p.costUsd, 0);
  if (loopUsd >= MATERIAL * spend && a.loops.patterns[0]) {
    const top = a.loops.patterns[0];
    const label = { paging: 'reading one file in slices', collection: 'the same command for item after item', retry: 'failed commands re-run unchanged', poll: 'polling a status' }[top.kind];
    findings.push({
      id: 'loops', title: 'Repeated procedures inside sessions', value: money(monthly(loopUsd)) + '/mo', severity: 'medium', perMonthUsd: monthly(loopUsd),
      sentence: `${a.loops.patterns.reduce((s2, p) => s2 + p.loops, 0)} loops inside sessions — mostly ${label} (e.g. ${top.template.slice(0, 50)}). A script would do each in one call.`,
    });
  }
  const explore = a.laws.reasons.find((r) => r.reason === 'explore');
  const delegate = a.laws.reasons.find((r) => r.reason === 'delegate');
  if (explore && explore.share >= 0.15) findings.push({
    id: 'exploration', title: 'Lookups are made from the full conversation', value: pct(explore.share), severity: 'medium',
    sentence: `${pct(explore.share)} of spend was reads, greps and log queries, each made from ~${Math.round(explore.avgContext / 1000)}k tokens of context. ${delegate ? `Only ${delegate.requests} request${delegate.requests === 1 ? ' was' : 's were'} delegated to a subagent.` : 'None were delegated to a subagent.'}`,
  });
  const side = a.spend.sideModelUsd / Math.max(1e-9, spend);
  if (side >= 0.1) findings.push({
    id: 'advisor', title: 'Advisor calls are a large line item', value: pct(side), severity: side >= 0.2 ? 'high' : 'medium',
    sentence: `${money(monthly(a.spend.sideModelUsd))}/month goes to advisor calls, which send the transcript to a second model without caching. Keep it if the second opinion is worth it.`,
  });
  const o = a.laws.outcomes;
  if (o.coverage > 0 && o.deliveringSessions > 0 && findings.length === 0) findings.push({
    id: 'delivery', title: 'What the spend delivered', value: `${o.deliveringSessions}/${runs.length}`, severity: 'info',
    sentence: `${o.deliveringSessions} of ${runs.length} sessions committed, pushed or opened a PR (${o.commits} commits, ${o.pushes} pushes, ${o.prs} PR actions)${o.costPerDeliveringSessionUsd != null ? ` — ${money(o.costPerDeliveringSessionUsd)} of spend per delivering session` : ''}.${o.denials ? ` ${o.denials} tool calls were denied along the way.` : ''}`,
  });
  const rank = { high: 0, medium: 1, info: 2 } as const;
  findings.sort((x, y) => rank[x.severity] - rank[y.severity] || (y.perMonthUsd ?? 0) - (x.perMonthUsd ?? 0));

  // ---- actions (monthly, ranked by expected value) -------------------------------------
  const actions: SummaryAction[] = a.plan.filter((p) => p.id !== 'recapture' && p.id !== 'advisor-cost').map((p) => ({
    id: p.id,
    title: p.title,
    why: p.summary,
    perMonthUsd: p.savingsUsd ? { low: monthly(p.savingsUsd.low), high: monthly(p.savingsUsd.high) } : null,
    basis: p.basis,
    files: p.files,
  }));
  const breaksFinding = findings.find((f) => f.id === 'breaks');
  if (breaksFinding?.perMonthUsd && breaksFinding.perMonthUsd >= MATERIAL * monthly(spend)) {
    actions.push({
      id: 'compact-before-breaks',
      title: 'Run /compact before stepping away from a long session',
      why: `${breaksFinding.sentence.split(' times')[0]} returns to a long session after more than an hour re-wrote its whole context; compacting before the break would have saved about ${money(breaksFinding.perMonthUsd / perMonth)} in these ${Math.round(days)} days.`,
      perMonthUsd: { low: breaksFinding.perMonthUsd * 0.5, high: breaksFinding.perMonthUsd },
      basis: 'structural',
      files: [],
    });
  }
  const creep = findings.find((f) => f.id === 'context-creep');
  const instrAction = actions.find((x) => x.id === 'shrink-instructions');
  if (creep && instrAction) instrAction.why = creep.sentence.split(/(?<=[.!?])\s/)[0];
  const mid = (x: SummaryAction) => (x.perMonthUsd ? (x.perMonthUsd.low + x.perMonthUsd.high) / 2 : -1);
  actions.sort((x, y) => mid(y) - mid(x));

  // ---- sessions ------------------------------------------------------------------------
  const T = a.compaction.threshold;
  const sessions: SessionStory[] = a.laws.expensive.map((e) => {
    const run = runs.find((r) => r.runId === e.runId);
    const R = run ? requestsOf(run) : [];
    const peak = R.reduce((m, r) => Math.max(m, r.context), 0);
    const s = run && T && peak > T ? run.costUsd - simulateCompaction(run, T, REACQUISITION_SCENARIOS[1]).costUsd : null;
    const saves = s != null && s >= Math.max(0.5, 0.02 * e.costUsd) ? s : null;
    return { runId: e.runId, title: e.title, startedAt: e.startedAt, costUsd: e.costUsd, requestsX: e.requestsX, peakContext: peak, delivered: e.delivered, compactionSavesUsd: saves };
  });

  // ---- headline ------------------------------------------------------------------------
  const trendBit = cprChange != null && Math.abs(cprChange) >= 0.25
    ? ` Cost per request is ${cprChange > 0 ? 'up' : 'down'} ${pct(Math.abs(cprChange))} in the newer half of these sessions${creep && cprChange > 0 ? ', largely because every session now starts with more context' : ''}.`
    : '';
  const best = actions.find((x) => x.perMonthUsd);
  const headline = `${money(spend)} over ${runs.length} sessions in ${Math.round(days)} days — about ${money(monthly(spend))}/month at this pace.${trendBit}${best ? ` The biggest lever: ${best.title.charAt(0).toLowerCase()}${best.title.slice(1)} (≈${money(best.perMonthUsd!.low)}–${money(best.perMonthUsd!.high)}/month).` : ''}`;

  return {
    window: { from, to, days: Math.round(days), sessions: runs.length, spendUsd: spend, perMonthUsd: monthly(spend) },
    delivered: o.coverage > 0 ? { sessions: o.deliveringSessions, commits: o.commits, pushes: o.pushes, prs: o.prs, costPerSessionUsd: o.costPerDeliveringSessionUsd } : null,
    headline,
    actions,
    findings,
    sessions,
    trend: {
      weeks, costPerRequestChange: cprChange, baseTokensChange: baseChange,
      ...(first && last ? { older: { costPerRequest: first.costPerRequest, baseTokens: first.baseTokens }, newer: { costPerRequest: last.costPerRequest, baseTokens: last.baseTokens } } : {}),
    },
  };
}
