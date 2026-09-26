/**
 * Did the change actually save tokens? — the measurement behind every result.
 *
 * Comparing raw averages before and after a change mostly measures the task mix:
 * session cost grows with the square of its length (laws.ts), so a week of short
 * tasks looks like a "saving". So every comparison here is MATCHED:
 *
 *   - requests are matched by their EXACT position in the session (request 57 of
 *     the after sessions against request 57 of the before sessions); positions are
 *     weighted by where the AFTER sessions spent their requests — "what would these
 *     sessions have cost with the old behaviour?". (Coarse buckets were tried first:
 *     inside a 51–100 bucket, shorter sessions only reach its early positions, so a
 *     shift to shorter tasks read as a saving.);
 *   - the change is reported with a 95% interval from a session-level bootstrap
 *     (sessions resampled on each side, seeded — the same data always gives the
 *     same answer);
 *   - a quality guard (tool errors per request, interruptions and denials per
 *     session) keeps a saving that made the agent worse from counting as a win.
 *
 * Two layers, because money is noisy and mechanisms are not. Validated on real
 * sessions (E26): at 6–15 sessions per side, an injected 20% cut in context came
 * back as −18…−27% but with intervals too wide to call; a change's MECHANISM
 * (share of requests above the compaction threshold, base tokens per session, …)
 * moves sharply and is detectable within a few sessions. So:
 *
 *   mechanism  did the change take effect? (lever-specific metric)
 *   money      tokens and cost per request, matched — with how many more
 *              sessions it needs before the interval excludes zero
 *
 * Verdict: `collecting` (<3 sessions on a side) · `not-in-effect` (the mechanism
 * did not move) · `working` (mechanism moved, money not yet significant) ·
 * `confirmed` (mechanism moved and the money interval is a saving, quality intact)
 * · `regressed` (quality slipped, or the money interval is entirely worse).
 * Placebo check on real data: 0 of 31 no-change dates were called a saving.
 */

import type { Run } from './types.js';
import { requestsOf, isLegacyParse, type RentRequest } from './rent.js';
import { pricingFor } from './cost.js';
import { requestReason } from './laws.js';

export interface Measured {
  before: number;
  after: number;
  /** after / before − 1 */
  changePct: number;
  /** 95% bootstrap interval of changePct. */
  ci: [number, number];
}

export interface EffectMeasurement {
  appliedAt: string;
  before: { sessions: number; requests: number };
  after: { sessions: number; requests: number };
  /** Context tokens per request, matched by position in the session. */
  tokensPerRequest: Measured | null;
  /**
   * Dollars per request — subagent and side-model spend included — matched by position
   * in the session, with BOTH sides priced at one model's prices (the after side's main
   * model): a model switch changes the bill without the change doing anything.
   */
  costPerRequest: Measured | null;
  /** Main model (most requests) on each side; `repricedAt` is the one both were priced at. */
  models: { before: string | null; after: string | null; repricedAt: string | null };
  /** The metric the change is meant to move (lever-specific). */
  primary: (Measured & { name: string }) | null;
  quality: { errorsPerRequest: [number, number]; interruptionsPerSession: [number, number]; denialsPerSession: [number, number]; ok: boolean };
  verdict: 'collecting' | 'not-in-effect' | 'working' | 'confirmed' | 'regressed' | 'inconclusive';
  /** Did the mechanism move? null for generic changes without a mechanism metric. */
  inEffect: boolean | null;
  /** Rough sessions per side needed before the money interval can exclude zero (null when already decided). */
  sessionsNeeded: number | null;
  /** (cost/request before − after) × requests per month after — only when confirmed. */
  realizedPerMonthUsd: number | null;
}

/** Positions beyond this are pooled (very long tails are sparse). */
const MAX_POSITION = 600;
const bucketOf = (k: number) => Math.min(k, MAX_POSITION);
const INTERRUPT = /\[request interrupted by user/i;
const B = 400;

/** Deterministic PRNG (mulberry32) so the bootstrap is reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Session { R: RentRequest[]; run: Run }

/** Per-bucket sums for one metric over a set of sessions. */
function bucketStats(sessions: Session[], value: (r: RentRequest, k: number, R: RentRequest[]) => number) {
  const sum = new Array<number>(MAX_POSITION + 1).fill(0), n = new Array<number>(MAX_POSITION + 1).fill(0);
  for (const s of sessions) s.R.forEach((r, k) => { const b = bucketOf(k); sum[b] += value(r, k, s.R); n[b]++; });
  return { sum, n };
}

/** Matched ratio: after vs before, weighted by the after sessions' position distribution. */
function matchedChange(before: Session[], after: Session[], value: (r: RentRequest, k: number, R: RentRequest[]) => number): { b: number; a: number } | null {
  const sb = bucketStats(before, value), sa = bucketStats(after, value);
  let wb = 0, wa = 0;
  for (let i = 0; i <= MAX_POSITION; i++) {
    if (!sb.n[i] || !sa.n[i]) continue; // compare only where both sides have requests
    const w = sa.n[i];
    wb += w * (sb.sum[i] / sb.n[i]);
    wa += w * (sa.sum[i] / sa.n[i]);
  }
  return wb > 0 ? { b: wb, a: wa } : null;
}

function measure(before: Session[], after: Session[], value: (r: RentRequest, k: number, R: RentRequest[]) => number, seed: number): Measured | null {
  const point = matchedChange(before, after, value);
  if (!point) return null;
  const rand = rng(seed);
  const draws: number[] = [];
  const pick = (xs: Session[]) => xs.map(() => xs[Math.floor(rand() * xs.length)]);
  for (let i = 0; i < B; i++) {
    const m = matchedChange(pick(before), pick(after), value);
    if (m && m.b > 0) draws.push(m.a / m.b - 1);
  }
  draws.sort((x, y) => x - y);
  const q = (p: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))] ?? 0;
  const perReqBefore = point.b / Math.max(1, after.reduce((s, x) => s + x.R.length, 0));
  const perReqAfter = point.a / Math.max(1, after.reduce((s, x) => s + x.R.length, 0));
  return { before: perReqBefore, after: perReqAfter, changePct: point.a / point.b - 1, ci: [q(0.025), q(0.975)] };
}

/** Did a per-session metric RISE by more than `tol(before)`, with 95% confidence? */
function rises(before: Session[], after: Session[], value: (s: Session) => number, tol: (b: number) => number, seed: number): boolean {
  const vb = before.map(value), va = after.map(value);
  if (vb.length < 2 || va.length < 2) return false;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const t = tol(mean(vb));
  const rand = rng(seed);
  const draws: number[] = [];
  for (let i = 0; i < B; i++) draws.push(mean(va.map(() => va[Math.floor(rand() * va.length)])) - mean(vb.map(() => vb[Math.floor(rand() * vb.length)])));
  draws.sort((x, y) => x - y);
  return draws[Math.floor(0.025 * draws.length)] > t;
}

/** Session-level metric (one value per session), bootstrapped the same way. */
function measureSessions(before: Session[], after: Session[], value: (s: Session) => number | null, seed: number): Measured | null {
  const vb = before.map(value).filter((v): v is number => v != null), va = after.map(value).filter((v): v is number => v != null);
  if (vb.length < 2 || va.length < 2) return null;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mb = mean(vb), ma = mean(va);
  if (mb <= 0) return null;
  const rand = rng(seed);
  const draws: number[] = [];
  for (let i = 0; i < B; i++) {
    const b = mean(vb.map(() => vb[Math.floor(rand() * vb.length)]));
    const a = mean(va.map(() => va[Math.floor(rand() * va.length)]));
    if (b > 0) draws.push(a / b - 1);
  }
  draws.sort((x, y) => x - y);
  const q = (p: number) => draws[Math.min(draws.length - 1, Math.floor(p * draws.length))] ?? 0;
  return { before: mb, after: ma, changePct: ma / mb - 1, ci: [q(0.025), q(0.975)] };
}

const ctxOf = (r: RentRequest) => r.context;
/**
 * Spend the main-thread requests do not carry — subagents and side models (the
 * advisor) — attributed back onto them: subagent spend to the requests that
 * delegated, the rest evenly. Without it a scout "saves" by moving lookups where
 * the per-request cost cannot see them.
 */
const offThread = new WeakMap<RentRequest, number>();
function attributeOffThread(run: Run, R: RentRequest[]): void {
  const main = R.reduce((s, r) => s + r.costUsd, 0);
  const rest = Math.max(0, run.costUsd - main);
  const sub = Math.min(rest, run.subagents?.costUsd ?? 0);
  const delegating = R.filter((r) => r.tools.some((t) => t.subagent));
  for (const r of R) offThread.set(r, (rest - (delegating.length ? sub : 0)) / R.length);
  for (const r of delegating) offThread.set(r, offThread.get(r)! + sub / delegating.length);
}
/** The request's tokens at `model`'s prices; its off-thread share scales with it. */
function pricedAt(r: RentRequest, model: string): number {
  const p = pricingFor(model);
  const main = (r.input * p.inputPerM + (r.cacheWrite - r.cacheWrite1h) * p.inputPerM * 1.25 + r.cacheWrite1h * p.inputPerM * 2
    + r.cacheRead * p.inputPerM * (p.cacheReadMult ?? 0.1) + r.output * p.outputPerM) / 1_000_000;
  return main + (offThread.get(r) ?? 0) * (r.costUsd > 0 ? main / r.costUsd : 1);
}
function mainModel(xs: Session[]): string | null {
  const n = new Map<string, number>();
  for (const s of xs) for (const r of s.R) n.set(r.model, (n.get(r.model) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The MECHANISM each change is supposed to move — lower is better for all of them. */
function mechanismFor(recId: string, threshold?: number): { name: string; kind: 'request' | 'session'; value: (...args: never[]) => number | null } | null {
  if (recId === 'shrink-instructions') return { name: 'tokens every session starts with', kind: 'session', value: ((s: Session) => s.R[0]?.context ?? null) as never };
  if (recId === 'compact-earlier') {
    const T = threshold ?? 200_000;
    return { name: `share of requests above ${Math.round(T / 1000)}k tokens`, kind: 'session', value: ((s: Session) => s.R.filter((r) => r.context > T * 1.1).length / s.R.length) as never };
  }
  if (recId === 'spill-exploration') {
    return { name: 'share of requests spent on lookups in the main thread', kind: 'session', value: ((s: Session) => s.R.filter((r) => r.tools.length > 0 && r.tools.every((t) => t.readOnly)).length / s.R.length) as never };
  }
  if (recId === 'compact-before-breaks') {
    return { name: 'context re-written after breaks, per session', kind: 'session', value: ((s: Session) => {
      let w = 0;
      for (let k = 1; k < s.R.length; k++) { const a = s.R[k - 1], b = s.R[k]; if (a.timestamp && b.timestamp && Date.parse(b.timestamp) - Date.parse(a.timestamp) > 3_300_000 && b.cacheWrite > 0.5 * a.context) w += b.cacheWrite; }
      return w;
    }) as never };
  }
  if (recId === 'ship-skill') {
    // the plan's claim: a commit/push/deploy ask takes ~13 requests improvised, ~2 with the skill
    return { name: 'requests spent per delivery (commit, push, PR)', kind: 'session', value: ((s: Session) => {
      const delivered = (s.run.events ?? []).filter((e) => e.kind === 'commit' || e.kind === 'push' || e.kind === 'pr').length;
      return delivered ? s.R.filter((r, k) => requestReason(r, s.R[k - 1]) === 'deliver').length / delivered : null;
    }) as never };
  }
  if (recId === 'verify-hook') {
    return { name: 'share of requests spent only running a check', kind: 'session', value: ((s: Session) => s.R.filter((r) => r.tools.length > 0 && r.tools.every((t) => /\b(tsc|eslint|vitest|jest|pytest)\b/.test(t.command ?? ''))).length / s.R.length) as never };
  }
  return null;
}

export function measureEffect(allRuns: Run[], appliedAt: string, recId = 'generic', opts: { threshold?: number } = {}): EffectMeasurement {
  const sessions: Session[] = allRuns
    .filter((r) => !isLegacyParse(r) && r.startedAt)
    .map((run) => ({ run, R: requestsOf(run) }))
    .filter((s) => s.R.length >= 3);
  for (const s of sessions) attributeOffThread(s.run, s.R);
  const t = Date.parse(appliedAt);
  const before = sessions.filter((s) => Date.parse(s.run.startedAt!) < t);
  const after = sessions.filter((s) => Date.parse(s.run.startedAt!) >= t);
  const reqs = (xs: Session[]) => xs.reduce((s, x) => s + x.R.length, 0);
  const perSession = (xs: Session[], f: (s: Session) => number) => (xs.length ? xs.reduce((a, s) => a + f(s), 0) / xs.length : 0);
  const errs = (xs: Session[]) => { const n = reqs(xs); return n ? xs.reduce((a, s) => a + s.R.reduce((b, r) => b + r.tools.filter((x) => x.isError).length, 0), 0) / n : 0; };
  const interrupts = (s: Session) => s.run.steps.filter((x) => x.kind === 'model_turn' && x.name === 'user' && INTERRUPT.test(x.payload)).length;
  const denials = (s: Session) => (s.run.events ?? []).filter((e) => e.kind === 'deny').length;
  const quality = {
    errorsPerRequest: [errs(before), errs(after)] as [number, number],
    interruptionsPerSession: [perSession(before, interrupts), perSession(after, interrupts)] as [number, number],
    denialsPerSession: [perSession(before, denials), perSession(after, denials)] as [number, number],
    ok: true,
  };
  // A rise counts only when its 95% interval clears the tolerance: on real sessions, point
  // estimates of these small counts (0 → 0.3 interruptions/session is one or two events)
  // tripped the guard in about a quarter of placebo cuts.
  const errOf = (s: Session) => s.R.reduce((b, r) => b + r.tools.filter((x) => x.isError).length, 0) / s.R.length;
  quality.ok = !rises(before, after, errOf, (b) => b * 0.25 + 0.005, 11)
    && !rises(before, after, interrupts, (b) => b * 0.25 + 0.25, 12)
    && !rises(before, after, denials, (b) => b * 0.25 + 0.5, 13);

  const models = { before: mainModel(before), after: mainModel(after), repricedAt: mainModel(after) ?? mainModel(before) };
  const base = { appliedAt, before: { sessions: before.length, requests: reqs(before) }, after: { sessions: after.length, requests: reqs(after) }, quality, models };
  if (before.length < 3 || after.length < 3) {
    return { ...base, tokensPerRequest: null, costPerRequest: null, primary: null, verdict: 'collecting', inEffect: null, sessionsNeeded: null, realizedPerMonthUsd: null };
  }
  const tokensPerRequest = measure(before, after, ctxOf, 1);
  const ref = models.repricedAt!;
  const costPerRequest = measure(before, after, (r) => pricedAt(r, ref), 2);
  const mech = mechanismFor(recId, opts.threshold);
  const mechM = mech
    ? (mech.kind === 'request' ? measure(before, after, mech.value as (r: RentRequest) => number, 3) : measureSessions(before, after, mech.value as (s: Session) => number | null, 3))
    : null;
  const primary = mechM && mech ? { ...mechM, name: mech.name } : null;
  // the mechanism moved when its whole interval is a drop (or it fell to ~zero from something)
  const inEffect = mech ? !!primary && (primary.ci[1] < 0 || (primary.before > 0 && primary.after <= primary.before * 0.2)) : null;
  // A scout lowers main-thread context by construction; only total spend (subagents
  // included) can say whether it saved anything.
  const money = recId === 'spill-exploration' ? costPerRequest : (tokensPerRequest ?? costPerRequest);
  const moneySaved = !!money && money.ci[1] < 0;
  const moneyWorse = !!money && money.ci[0] > 0;
  // A change whose mechanism did not move is not acting, so whatever else moved (drift:
  // sessions grow, instructions grow) is not its doing — placebo cuts on real sessions read
  // as "regressed" a third of the time when this came after the quality and money checks.
  const verdict: EffectMeasurement['verdict'] = inEffect === false ? 'not-in-effect'
    : !quality.ok ? 'regressed'
    : moneyWorse ? 'regressed'
    : moneySaved ? 'confirmed'
    : inEffect ? 'working'
    : 'inconclusive';
  // sessions per side for the money interval to exclude zero: width scales with 1/√n
  let sessionsNeeded: number | null = null;
  if (money && !moneySaved && !moneyWorse && money.changePct < 0) {
    const halfWidth = (money.ci[1] - money.ci[0]) / 2;
    const n = Math.min(before.length, after.length);
    sessionsNeeded = Math.ceil(n * (halfWidth / Math.max(0.01, Math.abs(money.changePct))) ** 2);
  }
  // realized money: the matched drop in $/request × the after sessions' request volume, per month
  let realizedPerMonthUsd: number | null = null;
  if (verdict === 'confirmed' && costPerRequest && costPerRequest.changePct < 0) {
    const starts = after.map((s) => Date.parse(s.run.startedAt!)).sort((a, b) => a - b);
    const days = Math.max(7, (starts[starts.length - 1] - starts[0]) / 86_400_000);
    realizedPerMonthUsd = (costPerRequest.before - costPerRequest.after) * reqs(after) * (30 / days);
  }
  return { ...base, tokensPerRequest, costPerRequest, primary, verdict, inEffect, sessionsNeeded, realizedPerMonthUsd };
}
