// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * The feedback loop — what makes a recommendation a hypothesis instead of a
 * claim. Every lever in plan.ts leaves a fingerprint in the transcripts once it
 * is adopted, so Effigent can DETECT adoption itself (no "mark as done" button)
 * and compare the sessions before and after on the metric the lever is supposed
 * to move — with a quality guard, so a change that saves money by making the
 * agent worse is caught:
 *
 *   scout        the generated `scout` subagent is called  → context per request ↓
 *   compaction   resets happen near the recommended T      → context per request ↓
 *   instructions CLAUDE.md shrinks ≥25%                    → base context ↓
 *
 * Detectors must be SPECIFIC to the change Effigent proposed: measured on real
 * traffic, a generic signal ("any skill was used", "any reset below 700k") fired
 * on unrelated behaviour and produced confident, wrong verdicts. And adoption must
 * be SUSTAINED: one manual /compact near T stamped a false "applied" date, so the
 * fingerprint has to hold in at least half (and ≥2) of the sessions after it that
 * could show it (for compaction: the ones that grew to near T). Skills are not
 * in the loop yet — their effect is per episode, not per session.
 *
 *   quality guard: tool errors per request, user interruptions and denied tool
 *   calls per session must not rise by more than 25%. Deliveries (commits,
 *   pushes, PRs) per session are reported alongside, not gated — they swing
 *   with the task mix, not with the change.
 *
 * Before/after is observational, not an experiment: other things change too.
 * So a verdict needs ≥3 sessions on each side and reports the sizes; it says
 * "consistent with", never "caused by".
 */

import type { Run } from './types.ts';
import { requestsOf, isLegacyParse } from './rent.ts';

export type Lever = 'scout' | 'compaction' | 'instructions';

export interface RunFeatures {
  runId: string;
  startedAt: string;
  requests: number;
  costUsd: number;
  costPerRequest: number;
  meanContext: number;
  baseContext: number;
  /** Share of requests that delegate to the named scout subagent. */
  delegatedShare: number;
  /** Largest context a reset happened at (0 = no reset). */
  resetAt: number;
  /** Largest context any request carried. */
  peakContext: number;
  instructionsTokens: number;
  errorsPerRequest: number;
  interruptions: number;
  /** Denied tool calls (blocked by auto-mode, rejected by the user, permission rules). */
  denials: number;
  /** Commits + pushes + PRs in the session. */
  deliveries: number;
}

export interface LeverOutcome {
  lever: Lever;
  /** First session where the lever is in effect. */
  adoptedAt: string;
  before: number;
  after: number;
  metric: string;
  metricBefore: number;
  metricAfter: number;
  costPerRequestBefore: number;
  costPerRequestAfter: number;
  qualityOk: boolean;
  /** Deliveries (commit/push/PR) per session, before → after — shown, not gated (task mix varies). */
  deliveriesBefore: number;
  deliveriesAfter: number;
  status: 'confirmed' | 'no-effect' | 'regressed' | 'pending';
  /** (cost/request before − after) × requests after — realized, observational. */
  realizedUsd: number;
}

const INTERRUPT = /\[request interrupted by user/i;
const MIN_SIDE = 3;
const WINDOW = 20;

export function runFeatures(run: Run, scoutName = 'scout'): RunFeatures {
  const R = requestsOf(run);
  const n = Math.max(1, R.length);
  let resetAt = 0;
  for (let k = 1; k < R.length; k++) if (R[k].context < 0.6 * R[k - 1].context) resetAt = Math.max(resetAt, R[k - 1].context);
  const tools = R.flatMap((r) => r.tools);
  return {
    runId: run.runId,
    startedAt: run.startedAt ?? '',
    requests: R.length,
    costUsd: run.costUsd,
    costPerRequest: run.costUsd / n,
    meanContext: R.reduce((s, r) => s + r.context, 0) / n,
    baseContext: R[0]?.context ?? 0,
    delegatedShare: R.filter((r) => r.tools.some((t) => t.subagent === scoutName)).length / n,
    resetAt,
    peakContext: R.reduce((m, r) => Math.max(m, r.context), 0),
    instructionsTokens: Math.round((run.instructions ?? []).reduce((s, f) => s + f.chars, 0) / 3.6),
    errorsPerRequest: tools.filter((t) => t.isError).length / n,
    interruptions: run.steps.filter((s) => s.kind === 'model_turn' && s.name === 'user' && INTERRUPT.test(s.payload)).length,
    denials: (run.events ?? []).filter((e) => e.kind === 'deny').length,
    deliveries: (run.events ?? []).filter((e) => e.kind === 'commit' || e.kind === 'push' || e.kind === 'pr').length,
  };
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

/**
 * Index of the first session where `on` holds while it held in at most 1 of the
 * sessions before — and keeps holding in at least half (≥2) of the eligible
 * sessions from there on.
 */
function changePoint(F: RunFeatures[], on: (f: RunFeatures, i: number) => boolean, eligible: (f: RunFeatures) => boolean = () => true): number {
  for (let i = MIN_SIDE; i < F.length; i++) {
    if (!on(F[i], i)) continue;
    const start = Math.max(0, i - WINDOW);
    const before = F.slice(start, i).filter((f, j) => on(f, start + j)).length; // absolute index into F
    if (before > 1) continue;
    let could = 0, did = 0;
    for (let j = i; j < Math.min(F.length, i + WINDOW); j++) if (eligible(F[j])) { could++; if (on(F[j], j)) did++; }
    if (did >= 2 && did >= could / 2) return i;
  }
  return -1;
}

interface LoopOptions {
  /** The compaction threshold Effigent recommended (tokens). */
  threshold?: number;
  scoutName?: string;
}

function detectors(opts: LoopOptions): { lever: Lever; metric: string; on: (F: RunFeatures[]) => (f: RunFeatures, i: number) => boolean; eligible?: (f: RunFeatures) => boolean; value: (f: RunFeatures) => number }[] {
  const T = opts.threshold;
  return [
    { lever: 'scout', metric: 'mean context per request', on: () => (f) => f.delegatedShare >= 0.02, value: (f) => f.meanContext },
    ...(T ? [{
      lever: 'compaction' as const, metric: 'mean context per request',
      on: () => (f: RunFeatures) => f.resetAt >= 0.8 * T && f.resetAt <= 1.25 * T,
      eligible: (f: RunFeatures) => f.peakContext >= 0.8 * T,
      value: (f: RunFeatures) => f.meanContext,
    }] : []),
    {
      lever: 'instructions', metric: 'base context (tokens)',
      on: (F) => (f, i) => { const prior = median(F.slice(Math.max(0, i - WINDOW), i).map((x) => x.instructionsTokens).filter((x) => x > 0)); return prior > 0 && f.instructionsTokens > 0 && f.instructionsTokens < 0.75 * prior; },
      value: (f) => f.baseContext,
    },
  ];
}

/** Detect which levers were adopted in this window and how the sessions after compare. */
export function evaluateLoop(allRuns: Run[], opts: LoopOptions = {}): LeverOutcome[] {
  const F = allRuns
    .filter((r) => !isLegacyParse(r) && r.startedAt)
    .map((r) => runFeatures(r, opts.scoutName))
    .filter((f) => f.requests >= 3)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const out: LeverOutcome[] = [];
  for (const d of detectors(opts)) {
    const i = changePoint(F, d.on(F), d.eligible);
    if (i < 0) continue;
    const before = F.slice(Math.max(0, i - WINDOW), i);
    const after = F.slice(i, i + WINDOW);
    const mb = mean(before.map(d.value)), ma = mean(after.map(d.value));
    const cb = mean(before.map((f) => f.costPerRequest)), ca = mean(after.map((f) => f.costPerRequest));
    const eb = mean(before.map((f) => f.errorsPerRequest)), ea = mean(after.map((f) => f.errorsPerRequest));
    const ib = mean(before.map((f) => f.interruptions)), ia = mean(after.map((f) => f.interruptions));
    const db = mean(before.map((f) => f.denials)), da = mean(after.map((f) => f.denials));
    const qualityOk = ea <= eb * 1.25 + 0.005 && ia <= ib * 1.25 + 0.25 && da <= db * 1.25 + 0.5;
    const improved = ma < mb * 0.95; // every metric here is lower-is-better
    const status: LeverOutcome['status'] = after.length < MIN_SIDE ? 'pending' : !qualityOk ? 'regressed' : improved ? 'confirmed' : 'no-effect';
    out.push({
      lever: d.lever,
      adoptedAt: F[i].startedAt,
      before: before.length,
      after: after.length,
      metric: d.metric,
      metricBefore: mb,
      metricAfter: ma,
      costPerRequestBefore: cb,
      costPerRequestAfter: ca,
      qualityOk,
      deliveriesBefore: mean(before.map((f) => f.deliveries)),
      deliveriesAfter: mean(after.map((f) => f.deliveries)),
      status,
      realizedUsd: (cb - ca) * after.reduce((s, f) => s + f.requests, 0),
    });
  }
  return out;
}
