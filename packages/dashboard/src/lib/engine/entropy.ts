// VENDORED from packages/core/src/entropy.ts — re-vendor after core changes (see CLAUDE.md §6)
/**
 * Predictability scoring — determinism as measured information, not heuristics.
 *
 * A variable-order Markov model (probabilistic-suffix-tree style, orders 0–3)
 * is trained on an agent's action-token sequences. At every tool decision we
 * then ask: given the recent context, how predictable was the next action?
 * A transition the model predicts with near-certainty is MECHANICAL — the LLM
 * turns spent deciding it ("glue") bought no information — and their measured
 * cost is the deterministic-savings claim.
 *
 * HONESTY RULES (fixed a priori; do not tune against one agent):
 *  1. LEAVE-ONE-RUN-OUT: run i is always scored by a model trained on every
 *     run EXCEPT i. A workflow seen only once can never predict itself —
 *     memorization is structurally impossible, not just discouraged.
 *  2. A context only predicts when it has real evidence (≥ MIN_SUPPORT
 *     observations), and `predictable` additionally requires p ≥ PREDICTABLE_P.
 *  3. Order-0 (history-free marginal) predictions never count as predictable:
 *     "this agent mostly edits" is true but is base-rate, not determinism.
 *  4. Glue attribution is measured and episode-bounded: the model_turn/thinking
 *     steps between one tool call and the next are the cost of DECIDING that
 *     next call; they are claimed only when the decision was predictable.
 *
 * MEASURED (real traffic, 3 unrelated agents): only ~0.1–0.2% of decisions are
 * fully predictable — interactive agent work is genuinely high-entropy at
 * next-action granularity. That result is the point: savings claims must be
 * workflow-conditioned (suggest.ts), and this model prices the hierarchy —
 * total decision glue (ceiling) vs. strictly-mechanical decisions (floor).
 */

import type { RunGraph } from './types.ts';
import { makeVocabCanon } from './actions.ts';
import { segmentEpisodes } from './episodes.ts';
import { attributeStepCosts } from './segments.ts';

const MAX_ORDER = 3;
const MIN_SUPPORT = 5;
const PREDICTABLE_P = 0.9;
const MIN_VOCAB_FREQ = 3;
const TOP_TRANSITIONS = 10;

/** context-key → next-token counts, for all orders 0..MAX_ORDER. */
type Model = Map<string, Map<string, number>>;

const key = (ctx: string[]): string => ctx.join('→');

function train(sequences: string[][]): Model {
  const model: Model = new Map();
  for (const seq of sequences) {
    for (let i = 0; i < seq.length; i++) {
      for (let k = 0; k <= Math.min(MAX_ORDER, i); k++) {
        const ck = key(seq.slice(i - k, i));
        const dist = model.get(ck) ?? new Map<string, number>();
        dist.set(seq[i], (dist.get(seq[i]) ?? 0) + 1);
        model.set(ck, dist);
      }
    }
  }
  return model;
}

interface Prediction {
  p: number;
  support: number;
  order: number;
}

/** Longest context with enough evidence wins (PPM-style backoff). */
function predictAt(model: Model, seq: string[], i: number): Prediction | null {
  for (let k = Math.min(MAX_ORDER, i); k >= 0; k--) {
    const dist = model.get(key(seq.slice(i - k, i)));
    if (!dist) continue;
    let total = 0;
    for (const n of dist.values()) total += n;
    if (total < MIN_SUPPORT) continue;
    return { p: (dist.get(seq[i]) ?? 0) / total, support: total, order: k };
  }
  return null;
}

export interface PredictableTransition {
  /** The context that made the action certain (most recent last). */
  context: string[];
  action: string;
  p: number;
  support: number;
  occurrences: number;
  /** Measured cost of the LLM glue spent deciding these occurrences. */
  glueUsd: number;
}

export interface PredictabilityReport {
  runsScored: number;
  /** Tool-call decisions in the window. */
  transitions: number;
  /** Decisions where the model had enough evidence to say anything. */
  scored: number;
  /** Scored decisions with p ≥ 0.9 at order ≥ 1 — the mechanical ones. */
  predictable: number;
  shareScored: number;
  sharePredictable: number;
  /** Measured LLM spend on deciding predictable transitions — the savings claim. */
  mechanicalGlueUsd: number;
  /** Total glue spend on all scored transitions, for context. */
  totalGlueUsd: number;
  topPredictable: PredictableTransition[];
}

/**
 * Score every tool decision in the window, leave-one-run-out.
 * Sequences are episode action-token strings on the shared (vocab-floored)
 * alphabet, so results line up with the suggester's motifs.
 */
export function analyzePredictability(graphs: RunGraph[]): PredictabilityReport {
  const empty: PredictabilityReport = {
    runsScored: 0, transitions: 0, scored: 0, predictable: 0,
    shareScored: 0, sharePredictable: 0, mechanicalGlueUsd: 0, totalGlueUsd: 0,
    topPredictable: [],
  };
  if (graphs.length < 3) return empty; // LOO needs a real training set

  interface SeqRef { runId: string; tokens: string[]; nodes: number[]; epStart: number }
  const byRun = new Map<string, SeqRef[]>();
  const allSeqs: string[][] = [];
  for (const g of graphs) {
    const refs: SeqRef[] = [];
    for (const ep of segmentEpisodes(g)) {
      if (ep.actions.length === 0) continue;
      refs.push({ runId: g.runId, tokens: ep.actions, nodes: ep.actionNodes, epStart: ep.start });
      allSeqs.push(ep.actions);
    }
    byRun.set(g.runId, refs);
  }
  const canon = makeVocabCanon(allSeqs, MIN_VOCAB_FREQ);
  for (const refs of byRun.values()) for (const r of refs) r.tokens = r.tokens.map(canon);

  const graphById = new Map(graphs.map((g) => [g.runId, g]));
  const costsById = new Map(graphs.map((g) => [g.runId, attributeStepCosts(g)]));

  const report = { ...empty, runsScored: graphs.length };
  const agg = new Map<string, PredictableTransition>();

  for (const g of graphs) {
    // Leave-one-run-out: this run's decisions are scored by everyone else's history.
    const trainSeqs: string[][] = [];
    for (const [runId, refs] of byRun) {
      if (runId === g.runId) continue;
      for (const r of refs) trainSeqs.push(r.tokens);
    }
    const model = train(trainSeqs);

    for (const ref of byRun.get(g.runId) ?? []) {
      const costs = costsById.get(g.runId)!;
      const nodes = graphById.get(g.runId)!.nodes;
      for (let i = 0; i < ref.tokens.length; i++) {
        report.transitions++;
        const pred = predictAt(model, ref.tokens, i);
        if (!pred) continue;
        report.scored++;

        // Glue: LLM turns between the previous tool call and this one — the
        // measured cost of deciding this action. The first decision of an
        // episode starts at the EPISODE boundary, never before it.
        const from = i === 0 ? ref.epStart - 1 : ref.nodes[i - 1];
        let glue = 0;
        for (let j = from + 1; j < ref.nodes[i]; j++) {
          const k = nodes[j]?.kind;
          if (k === 'model_turn' || k === 'thinking') glue += costs[j];
        }
        report.totalGlueUsd += glue;

        const predictable = pred.order >= 1 && pred.p >= PREDICTABLE_P;
        if (!predictable) continue;
        report.predictable++;
        report.mechanicalGlueUsd += glue;

        const ctx = ref.tokens.slice(i - pred.order, i);
        const ak = `${key(ctx)}⇒${ref.tokens[i]}`;
        const t = agg.get(ak) ?? {
          context: ctx, action: ref.tokens[i], p: pred.p, support: pred.support, occurrences: 0, glueUsd: 0,
        };
        t.occurrences++;
        t.glueUsd += glue;
        if (pred.support > t.support) { t.support = pred.support; t.p = pred.p; }
        agg.set(ak, t);
      }
    }
  }

  report.shareScored = report.transitions > 0 ? report.scored / report.transitions : 0;
  report.sharePredictable = report.scored > 0 ? report.predictable / report.scored : 0;
  report.topPredictable = [...agg.values()]
    .sort((a, b) => b.glueUsd - a.glueUsd)
    .slice(0, TOP_TRANSITIONS);
  return report;
}
