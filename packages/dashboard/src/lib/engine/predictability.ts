// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * Determinism, measured — for EVERY agent, interactive or repetitive.
 *
 * "How deterministic is this agent?" is answered the only way that can be
 * checked: learn a cheap model of its decisions from its PAST sessions and
 * score it on LATER ones. A decision the model predicts correctly at a stated
 * confidence is one deterministic code could have taken. Reported:
 *
 *   coverage@c   share of held-out decisions predicted with confidence ≥ c
 *   precision@c  how often those predictions were right (≈ c when calibrated)
 *   spendShare   cost of the requests predicted correctly at ≥ 0.8 — the ceiling
 *                on what replacing those decisions with code could touch
 *   explained    1 − log-loss / base-rate log-loss: share of the uncertainty
 *                about the next decision the agent's history removes
 *
 * Two alphabets: the REASON a request was made (explore/act/verify/…) and the
 * ACTION it took (git:commit, read, pnpm:test — no arguments). Arguments are not
 * predicted: measured at 0% on real traffic.
 *
 * Model: Witten–Bell interpolation over contexts (last two decisions + did the
 * last call fail) → (last decision + failed) → (failed) → base rate. Each level
 * trusts its counts in proportion to how often it has seen a NEW outcome, so a
 * large action vocabulary does not collapse unseen actions to ~0 probability. Measured on 13.9k
 * held-out requests, richer state (the user's ask, position in the task) added
 * nothing, and the failure flag was the only feature that helped — so it is the
 * whole state. Split: per agent by time, first 70% of sessions train, the rest
 * test, each test session added to history only after it is scored.
 *
 * On interactive coding traffic this lands near 3–6% coverage at 0.7. That is a
 * finding, not a defect: repetitive agents score far higher, and the D0–D5
 * lattice then says WHICH steps to compile.
 */

import type { Run } from './types.ts';
import { requestsOf, isLegacyParse, type RentRequest } from './rent.ts';
import { requestReason } from './laws.ts';
import { actionToken } from './actions.ts';

export type Alphabet = 'reason' | 'action';

export interface Predictability {
  alphabet: Alphabet;
  trainSessions: number;
  testSessions: number;
  testDecisions: number;
  coverage70: number;
  precision70: number;
  coverage80: number;
  precision80: number;
  /** Share of held-out spend on requests predicted correctly at ≥ 0.8. */
  spendShare80: number;
  /** Share of next-decision uncertainty removed by the agent's history (0–1). */
  explained: number;
  /**
   * True when the number can be shown as a fact: enough later sessions, and the
   * ≥0.8-confidence predictions came true at least 75% of the time. Measured on a
   * 5-session agent, stated 0.8 came true 63% — too few sessions to trust.
   */
  reliable: boolean;
  /** Stated-confidence decile → observed accuracy (calibration check). */
  calibration: { bucket: number; n: number; accuracy: number }[];
}

const TRAIN_SHARE = 0.7;
const MIN_SESSIONS = 4;
const MIN_TEST = 200;
const MIN_RELIABLE_TEST_SESSIONS = 6;
/** Prior strength added to each context's escape mass (keeps thin contexts calibrated). */
const PRIOR = 5;

function decisionOf(r: RentRequest, prev: RentRequest | undefined, alphabet: Alphabet): string {
  if (alphabet === 'reason') return requestReason(r, prev);
  if (!r.tools.length) return 'respond';
  return r.tools
    .map((t) => actionToken({ kind: 'tool_use', name: t.name, payload: t.command != null ? JSON.stringify({ command: t.command }) : t.preview }))
    .sort()
    .join('&');
}

interface Row { y: string; keys: string[]; cost: number }

function rowsOf(R: RentRequest[], alphabet: Alphabet): Row[] {
  const d = R.map((r, k) => decisionOf(r, R[k - 1], alphabet));
  return R.map((r, k) => {
    const d1 = d[k - 1] ?? 'START', d2 = d[k - 2] ?? 'START';
    const err = R[k - 1]?.tools.some((t) => t.isError) ? 'E' : 'ok';
    // back-off order: most specific context first
    return { y: d[k], keys: [`2|${d2}|${d1}|${err}`, `1|${d1}|${err}`, `0|${err}`], cost: r.costUsd };
  });
}

export function measurePredictability(allRuns: Run[], alphabet: Alphabet = 'action'): Predictability | null {
  const runs = allRuns
    .filter((r) => !isLegacyParse(r) && r.startedAt)
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  if (runs.length < MIN_SESSIONS) return null;
  const cut = Math.max(1, Math.floor(runs.length * TRAIN_SHARE));
  const table = new Map<string, Map<string, number>>();
  const prior = new Map<string, number>();
  let priorN = 0;
  const learn = (rows: Row[]) => {
    for (const x of rows) {
      prior.set(x.y, (prior.get(x.y) ?? 0) + 1); priorN++;
      for (const k of x.keys) { const m = table.get(k) ?? table.set(k, new Map()).get(k)!; m.set(x.y, (m.get(x.y) ?? 0) + 1); }
    }
  };
  for (const r of runs.slice(0, cut)) learn(rowsOf(requestsOf(r), alphabet));

  let n = 0, ll = 0, llBase = 0, cost = 0, cost80 = 0;
  let c70 = 0, ok70 = 0, c80 = 0, ok80 = 0;
  const cal = Array.from({ length: 10 }, () => ({ n: 0, ok: 0 }));
  for (const r of runs.slice(cut)) {
    const rows = rowsOf(requestsOf(r), alphabet);
    const vocab = Math.max(1, prior.size);
    for (const x of rows) {
      const base = (y: string) => ((prior.get(y) ?? 0) + 1) / (priorN + vocab + 1);
      // Witten–Bell: interpolate from the coarsest context up to the most specific.
      const levels = [...x.keys].reverse().map((k) => table.get(k));
      const p = (y: string) => {
        let q = base(y);
        for (const m of levels) {
          if (!m) continue;
          const total = [...m.values()].reduce((a, b) => a + b, 0);
          // + PRIOR: a context seen 3 times must not claim 75% confidence (measured overconfidence)
          const lambda = total / (total + m.size + PRIOR);
          q = lambda * ((m.get(y) ?? 0) / total) + (1 - lambda) * q;
        }
        return q;
      };
      const candidates = new Set<string>();
      for (const m of levels) if (m) for (const y of m.keys()) candidates.add(y);
      if (!candidates.size) for (const y of prior.keys()) candidates.add(y);
      let top = '', pTop = 0;
      for (const y of candidates) { const v = p(y); if (v > pTop) { pTop = v; top = y; } }
      const hit = top === x.y;
      n++; cost += x.cost;
      ll -= Math.log(Math.max(1e-9, p(x.y)));
      llBase -= Math.log(Math.max(1e-9, base(x.y)));
      const b = Math.min(9, Math.floor(pTop * 10)); cal[b].n++; if (hit) cal[b].ok++;
      if (pTop >= 0.7) { c70++; if (hit) ok70++; }
      if (pTop >= 0.8) { c80++; if (hit) { ok80++; cost80 += x.cost; } }
    }
    learn(rows); // strictly past-only: a session becomes history after it is scored
  }
  if (n < MIN_TEST) return null;
  return {
    alphabet,
    trainSessions: cut,
    testSessions: runs.length - cut,
    testDecisions: n,
    coverage70: c70 / n,
    precision70: c70 ? ok70 / c70 : 0,
    coverage80: c80 / n,
    precision80: c80 ? ok80 / c80 : 0,
    spendShare80: cost ? cost80 / cost : 0,
    explained: llBase > 0 ? Math.max(0, 1 - ll / llBase) : 0,
    reliable: runs.length - cut >= MIN_RELIABLE_TEST_SESSIONS && (c80 < 20 || ok80 / c80 >= 0.75),
    calibration: cal.map((c, i) => ({ bucket: i / 10, n: c.n, accuracy: c.n ? c.ok / c.n : 0 })).filter((c) => c.n > 0),
  };
}
