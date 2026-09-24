/**
 * The laws of an agent's spend (docs/context-rent.md, E14–E17).
 *
 * Measured on every real agent we have: 78–84% of the variance in session cost
 * is explained by session LENGTH (requests), because context grows ~linearly
 * with requests and every request re-reads all of it:
 *
 *     cost(N) ≈ p·(B·N + d·N²/2) + w·(B + d·N)    B base context, d tokens deposited per
 *                                                request, p read / w write price per token
 *
 * — session cost is quadratic in length. Compaction is therefore an inventory
 * problem: carried tokens have a holding cost (rent), a compaction has a fixed
 * reorder cost K (read everything once, write a summary and a new prefix,
 * re-explore). The economic order quantity gives the optimal segment length in
 * closed form, L* = √(2K / (p·d)), and threshold T* = B + summary + d·L*. On
 * every agent measured, T* lands on the trace-replay simulator's optimum.
 *
 * Everything here is either an identity or a per-agent fit reported WITH its
 * fit quality — nothing is asserted without the number that supports it.
 */

import type { Run } from './types.js';
import { pricingFor } from './cost.js';
import { requestsOf, isLegacyParse, type RentRequest } from './rent.js';

// ---- why each request happened ---------------------------------------------------

export type RequestReason = 'explore' | 'act' | 'verify' | 'deliver' | 'respond' | 'recover' | 'wait' | 'delegate';

const VERIFY = /\b(tsc|jest|vitest|pytest|eslint|typecheck|mypy|ruff)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b|\bgo (test|build|vet)\b|\bcargo (test|check|build|clippy)\b/;
const DELIVER = /\bgit (commit|push)\b|\bgh pr (create|merge)\b|\b(firebase deploy|vercel( --prod)?|eas (update|build|submit)|gcloud run deploy|npm publish|docker push|kubectl apply|terraform apply)\b/;
const WAIT = /\bsleep\s+\d|\buntil\b[^;]*;\s*do\b|\bwhile\b[^;]*;\s*do\b|\bgh run (watch|view)\b|--follow\b/;

/** Classify one request by what it was FOR (the first matching reason wins). */
export function requestReason(r: RentRequest, prev?: RentRequest): RequestReason {
  if (!r.tools.length) return 'respond';
  if (r.tools.some((t) => t.name === 'Agent' || t.name === 'Task')) return 'delegate';
  if (prev?.tools.some((t) => t.isError)) return 'recover';
  const cmds = r.tools.map((t) => t.command ?? '');
  if (cmds.some((c) => WAIT.test(c))) return 'wait';
  if (cmds.some((c) => DELIVER.test(c))) return 'deliver';
  if (cmds.some((c) => VERIFY.test(c))) return 'verify';
  if (r.tools.every((t) => t.readOnly)) return 'explore';
  return 'act';
}

export interface ReasonMix {
  reason: RequestReason;
  requests: number;
  costUsd: number;
  share: number;
  /** Mean context the requests were made from — what each one paid to re-read. */
  avgContext: number;
}

// ---- the session law + EOQ ----------------------------------------------------------

export interface SessionLaw {
  /** Median first-request context (system prompt + tools + CLAUDE.md). */
  baseTokens: number;
  /** Mean tokens entering context per request. */
  depositPerRequest: number;
  /** Read price per context token per request (dominant model). */
  readPricePerToken: number;
  /** Reorder cost of one compaction at T* (p50 re-exploration). */
  compactionCostUsd: number;
  /** EOQ-optimal compaction threshold (tokens). */
  eoqThreshold: number;
  /** R² of log(session cost) against the quadratic law's prediction. */
  fitR2: number;
  /** Share of this agent's re-reading spend incurred above T* — the quadratic tax. */
  aboveThresholdShare: number;
}

export interface CostDrivers {
  /** Covariance shares of log(session cost): they sum to 1 (price is usually negative — caching). */
  requests: number;
  context: number;
  price: number;
}

export interface ExpensiveSession {
  runId: string;
  title?: string;
  startedAt?: string;
  costUsd: number;
  /** Ratio to the agent's median session. */
  requestsX: number;
  contextX: number;
  priceX: number;
  dominant: 'requests' | 'context' | 'price';
  /** The reason that consumed the most of this session's spend. */
  topReason: RequestReason;
  topReasonShare: number;
  /** Did the session deliver something observable (commit/push/PR)? */
  delivered: boolean;
}

export interface Outcomes {
  commits: number;
  pushes: number;
  prs: number;
  denials: number;
  /** Sessions that delivered something observable (commit, push or PR). */
  deliveringSessions: number;
  /** Spend per delivering session — only meaningful as a trend on the same agent. */
  costPerDeliveringSessionUsd: number | null;
  /** Share of sessions with any outcome signal — how much the numbers above can see. */
  coverage: number;
}

export interface AgentLaws {
  runs: number;
  outcomes: Outcomes;
  reasons: ReasonMix[];
  law: SessionLaw | null;
  drivers: CostDrivers | null;
  expensive: ExpensiveSession[];
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
const cov = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); return mean(a.map((x, i) => (x - ma) * (b[i] - mb))); };

const SUMMARY_TOKENS = 12_000;
const REACQ_TOKENS = 15_000;
const REACQ_REQUESTS = 8;

export function computeLaws(allRuns: Run[]): AgentLaws {
  const runs = allRuns.filter((r) => !isLegacyParse(r));
  const perRun = runs.map((run) => ({ run, R: requestsOf(run) })).filter((x) => x.R.length > 0);

  // reason mix
  const acc = new Map<RequestReason, { n: number; cost: number; ctx: number }>();
  const reasonsOf = perRun.map(({ R }) => R.map((r, k) => requestReason(r, R[k - 1])));
  let total = 0;
  perRun.forEach(({ R }, i) => R.forEach((r, k) => {
    const why = reasonsOf[i][k];
    const a = acc.get(why) ?? { n: 0, cost: 0, ctx: 0 };
    a.n++; a.cost += r.costUsd; a.ctx += r.context; total += r.costUsd;
    acc.set(why, a);
  }));
  const reasons: ReasonMix[] = [...acc.entries()]
    .map(([reason, a]) => ({ reason, requests: a.n, costUsd: a.cost, share: total ? a.cost / total : 0, avgContext: a.n ? a.ctx / a.n : 0 }))
    .sort((x, y) => y.costUsd - x.costUsd);

  // the law (needs a few sessions with real length)
  let law: SessionLaw | null = null;
  const sessions = perRun.filter(({ R }) => R.length >= 5);
  if (sessions.length >= 3) {
    const baseTokens = median(sessions.map(({ R }) => R[0].context));
    const deps: number[] = [];
    for (const { R } of sessions) for (let k = 1; k < R.length; k++) { const d = R[k].context - R[k - 1].context; if (d > 0 && d < 60_000) deps.push(d); }
    const d = mean(deps);
    const modelCounts = new Map<string, number>();
    for (const { R } of sessions) for (const r of R) modelCounts.set(r.model, (modelCounts.get(r.model) ?? 0) + 1);
    const model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const pr = pricingFor(model);
    const rp = (pr.inputPerM * (pr.cacheReadMult ?? 0.1)) / 1e6;
    const wp = (pr.inputPerM * 2) / 1e6;
    const op = pr.outputPerM / 1e6;
    const K = (T: number) => T * rp + SUMMARY_TOKENS * op + (baseTokens + SUMMARY_TOKENS + REACQ_TOKENS) * wp + REACQ_REQUESTS * ((baseTokens + SUMMARY_TOKENS) * rp + 300 * op);
    let T = 300_000;
    for (let i = 0; i < 25 && d > 0; i++) T = baseTokens + SUMMARY_TOKENS + d * Math.sqrt((2 * K(T)) / (rp * d)); // K depends on T: fixed point
    // fit quality of the quadratic law on the input side of each session
    const obs: number[] = [], pred: number[] = [];
    for (const { R } of sessions) {
      const N = R.length;
      const input = R.reduce((s, r) => s + r.costUsd - (r.output * pricingFor(r.model).outputPerM) / 1e6, 0);
      obs.push(Math.log(Math.max(1e-6, input)));
      // re-reading grows quadratically; every token is also written once (linear)
      pred.push(Math.log(Math.max(1e-6, rp * (baseTokens * N + (d * N * N) / 2) + wp * (baseTokens + d * N))));
    }
    const my = mean(obs);
    const ssTot = obs.reduce((s, y) => s + (y - my) ** 2, 0);
    const ssRes = obs.reduce((s, y, i) => s + (y - pred[i]) ** 2, 0);
    let above = 0, reads = 0;
    for (const { R } of sessions) for (const r of R) { const x = r.cacheRead * rp; reads += x; if (r.context > T) above += x * ((r.context - T) / r.context); }
    law = {
      baseTokens: Math.round(baseTokens),
      depositPerRequest: Math.round(d),
      readPricePerToken: rp,
      compactionCostUsd: K(T),
      eoqThreshold: Math.round(T / 1000) * 1000,
      fitR2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
      aboveThresholdShare: reads ? above / reads : 0,
    };
  }

  // variance drivers + expensive-session explanations
  let drivers: CostDrivers | null = null;
  const expensive: ExpensiveSession[] = [];
  const rows = perRun.map(({ run, R }, i) => {
    const N = R.length;
    const C = mean(R.map((r) => r.context)) || 1;
    const cost = R.reduce((s, r) => s + r.costUsd, 0);
    return { run, N, C, p: cost / (N * C), cost, reasons: reasonsOf[i], R };
  }).filter((x) => x.cost > 0 && x.N >= 3);
  if (rows.length >= 8) {
    const y = rows.map((r) => Math.log(r.cost));
    const vy = cov(y, y);
    if (vy > 0) {
      drivers = {
        requests: cov(rows.map((r) => Math.log(r.N)), y) / vy,
        context: cov(rows.map((r) => Math.log(r.C)), y) / vy,
        price: cov(rows.map((r) => Math.log(r.p)), y) / vy,
      };
    }
  }
  if (rows.length >= 4) {
    const mN = median(rows.map((r) => r.N)), mC = median(rows.map((r) => r.C)), mp = median(rows.map((r) => r.p));
    for (const r of [...rows].sort((a, b) => b.cost - a.cost).slice(0, 3)) {
      const f = { requests: r.N / mN, context: r.C / mC, price: r.p / mp };
      const dominant = (Object.entries(f) as [ExpensiveSession['dominant'], number][]).sort((a, b) => Math.abs(Math.log(b[1])) - Math.abs(Math.log(a[1])))[0][0];
      const byReason = new Map<RequestReason, number>();
      r.R.forEach((q, k) => byReason.set(r.reasons[k], (byReason.get(r.reasons[k]) ?? 0) + q.costUsd));
      const [topReason, topCost] = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0];
      expensive.push({
        runId: r.run.runId, title: r.run.title, startedAt: r.run.startedAt, costUsd: r.cost,
        requestsX: f.requests, contextX: f.context, priceX: f.price, dominant,
        topReason, topReasonShare: r.cost ? topCost / r.cost : 0,
        delivered: (r.run.events ?? []).some((e) => e.kind === 'commit' || e.kind === 'push' || e.kind === 'pr'),
      });
    }
  }
  // outcomes — from harness events (new-parser runs only carry them)
  const count = (k: string) => runs.reduce((s, r) => s + (r.events ?? []).filter((e) => e.kind === k).length, 0);
  const delivering = runs.filter((r) => (r.events ?? []).some((e) => e.kind === 'commit' || e.kind === 'push' || e.kind === 'pr'));
  const outcomes: Outcomes = {
    commits: count('commit'), pushes: count('push'), prs: count('pr'), denials: count('deny'),
    deliveringSessions: delivering.length,
    costPerDeliveringSessionUsd: delivering.length ? runs.reduce((s, r) => s + r.costUsd, 0) / delivering.length : null,
    coverage: runs.length ? runs.filter((r) => (r.events ?? []).length > 0).length / runs.length : 0,
  };
  return { runs: runs.length, outcomes, reasons, law, drivers, expensive };
}
