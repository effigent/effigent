// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * Per-node determinism scoring — the foundation of the optimization brain.
 *
 * v1 (`scoreDeterminism`) — kept for compatibility: exact-L1 groups, per-index
 * modal agreement of canonical values, score bands ≥90 replace / 70–89 cache
 * (grounded in the "total agreement rate" idea, arXiv:2408.04667).
 *
 * v3 (`analyzeDeterminism`) — the shipped brain (docs/determinism-v3.md):
 *   1. runs cluster by ALIGNMENT similarity (sequence + dataflow topology),
 *      not exact shape hashes — real histories are 90% similar, rarely equal;
 *   2. every run is aligned to the cluster medoid, and determinism is scored
 *      per aligned COLUMN on full-value hashes of RAW payloads (numbers kept:
 *      canonicalization would erase exactly the variance being measured);
 *   3. each column lands on a determinism lattice:
 *        D0 constant       → replace / compile (constant call)
 *        D1 derivable      → compile: template + every slot provenance-traced
 *        D2 pure           → memoize (same input ⇒ same output) or mechanical
 *        D3 parameterized  → template with unresolved slots
 *        D4 routable/cache → stable-structure LLM step / mostly-stable value
 *        D5 volatile       → keep the LLM
 *   4. confidence is a Wilson lower bound at the HONEST sample size of the
 *      winning detector (memoize: pairs inside multi-sample input groups;
 *      template: runs matching the modal token structure), and EVERY action is
 *      confidence-gated — two agreeing runs never fire anything.
 */
import type { RunGraph, StepKind } from './types.ts';
import { alignCluster, clusterBySimilarity, type AlignedColumn, type ClusterAlignment } from './align.ts';
import { normalizeWs } from './canonicalize.ts';
import { classifyNode, type StepClass } from './taxonomy.ts';
import { traceSlots, type SlotTrace } from './provenance.ts';

export type DetAction = 'replace' | 'cache' | 'keep';

export interface NodeDeterminism {
  index: number;
  label: string;
  kind: StepKind;
  /** 0–100: % of runs whose value equals the modal value at this position. */
  score: number;
  agreement: number;
  distinctValues: number;
  runCount: number;
  action: DetAction;
}

export interface ClusterDeterminism {
  l1: string;
  agentId: string;
  runCount: number;
  labelSequence: string[];
  /** Mean score over scoreable nodes — the cluster's overall determinism. */
  meanScore: number;
  nodes: NodeDeterminism[];
}

function actionFor(score: number): DetAction {
  if (score >= 90) return 'replace';
  if (score >= 70) return 'cache';
  return 'keep';
}

/**
 * v1 — score determinism per exact-L1 cluster. Only clusters with ≥ minRuns
 * (default 2) observations are scored. Kept for compatibility; the brain is
 * `analyzeDeterminism` below.
 */
export function scoreDeterminism(graphs: RunGraph[], opts: { minRuns?: number } = {}): ClusterDeterminism[] {
  const minRuns = opts.minRuns ?? 2;

  const groups = new Map<string, RunGraph[]>();
  for (const g of graphs) {
    const arr = groups.get(g.l1);
    if (arr) arr.push(g);
    else groups.set(g.l1, [g]);
  }

  const out: ClusterDeterminism[] = [];
  for (const [l1, gs] of groups) {
    const ref = gs[0];
    const n = ref.nodes.length;
    // Guard against rare L1 hash collisions: only compare same-length graphs.
    const same = gs.filter((g) => g.nodes.length === n);
    const runCount = same.length;
    if (runCount < minRuns) continue;

    const nodes: NodeDeterminism[] = [];
    let scoreSum = 0;
    let scored = 0;
    for (let i = 0; i < n; i++) {
      const { kind, label } = ref.nodes[i];
      const values = same.map((g) => g.nodes[i].canonicalValue);
      const scoreable = kind !== 'thinking' && values.some((v) => v.length > 0);

      const counts = new Map<string, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      const modal = Math.max(...counts.values());
      const agreement = modal / runCount;
      const score = Math.round(agreement * 100);

      if (scoreable) {
        scoreSum += score;
        scored += 1;
      }
      nodes.push({
        index: i,
        label,
        kind,
        score,
        agreement,
        distinctValues: counts.size,
        runCount,
        action: scoreable ? actionFor(score) : 'keep',
      });
    }

    out.push({
      l1,
      agentId: ref.agentId,
      runCount,
      labelSequence: ref.labelSequence,
      meanScore: scored ? Math.round(scoreSum / scored) : 0,
      nodes,
    });
  }

  // Most-repeated clusters first — that's where the money is.
  out.sort((a, b) => b.runCount - a.runCount);
  return out;
}

/* ------------------------------------------------------------------------- *
 * v3 — alignment-based, lattice-scored analysis
 * ------------------------------------------------------------------------- */

export type DetActionV2 = 'replace' | 'compile' | 'memoize' | 'template' | 'route' | 'cache' | 'keep';
export type DetLevel = 'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5';

export interface NodeAnalysis {
  /** Medoid column index. */
  index: number;
  label: string;
  structLabel: string;
  kind: StepKind;
  class: StepClass;
  score: number;
  /** 95% Wilson lower bound at the winning detector's honest sample size, 0–100. */
  confidence: number;
  action: DetActionV2;
  level: DetLevel;
  /** Slotted preview when a template detector won ("⟨·⟩" marks volatile slots). */
  template?: string;
  /** Template tokens (slots = '⟨·⟩') — synthesis/replay consume these. */
  templateTokens?: string[];
  /** Per-slot provenance when a template was found on a tool_use column. */
  provenance?: SlotTrace[];
  /** Cluster size (compat name). */
  runCount: number;
  /** Runs actually having this column (alignment support). */
  support: number;
  /** True when taxonomy says the step needs no intelligence (mechanical/cacheable). */
  pure: boolean;
  /** Measured mean USD per run for this column (0 when no per-step tokens). */
  estUsdPerRun: number;
  /** Total measured tokens across the column's aligned nodes. */
  estTokens: number;
}

export interface ClusterAnalysis {
  /** Cluster key — the medoid's L1 (display/stability only; members differ). */
  l1: string;
  agentId: string;
  runCount: number;
  runIds: string[];
  medoidRunId: string;
  /** Medoid label sequence (display). */
  labelSequence: string[];
  meanScore: number;
  /** Mean member similarity to the medoid (how "pretty much the same" runs are). */
  meanSim: number;
  /** Mean unaligned nodes per run ÷ medoid length — retry/detour rate. */
  insertionRate: number;
  nodes: NodeAnalysis[];
  /** Full alignment — synthesis and replay consume it (not for serialization). */
  alignment: ClusterAlignment;
}

/** 95% Wilson lower bound on a proportion — small samples score low. */
export function wilsonLower(successes: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

function modalCount(values: string[]): number {
  const counts = new Map<string, number>();
  let best = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > best) best = n;
  }
  return best;
}

/**
 * Boundary-preserving tokenizer: splits on whitespace, structural punctuation
 * (JSON braces/quotes/commas/colons) AND path/query separators (/?&=) while
 * KEEPING the separators as tokens, so `tokens.join('') === input`.
 * Space-splitting alone sees a compact JSON payload as one giant token — zero
 * template signal on exactly the payloads agents use most — and without path
 * separators a volatile id fuses with its constant directory prefix. Template,
 * synthesis, and replay must all tokenize identically.
 */
export function tokenize(s: string): string[] {
  return s.split(/([\s"{}[\],:/?&=]+)/).filter((t) => t.length > 0);
}

const SEPARATOR_RE = /^[\s"{}[\],:/?&=]+$/;
export function isSeparatorToken(t: string): boolean {
  return SEPARATOR_RE.test(t);
}

export const SLOT_MARK = '⟨·⟩';

/** Longest common prefix/suffix across a token column (non-overlapping). */
function commonAffixes(values: string[]): { prefix: string; suffix: string } {
  let prefix = values[0];
  for (const v of values) {
    let k = 0;
    while (k < prefix.length && k < v.length && prefix[k] === v[k]) k++;
    prefix = prefix.slice(0, k);
    if (!prefix) break;
  }
  const minLen = Math.min(...values.map((v) => v.length));
  let suffix = values[0];
  for (const v of values) {
    let k = 0;
    while (k < suffix.length && k < v.length && suffix[suffix.length - 1 - k] === v[v.length - 1 - k]) k++;
    suffix = suffix.slice(suffix.length - k);
    if (!suffix) break;
  }
  // Never let the affixes swallow a value whole.
  if (prefix.length + suffix.length > minLen) {
    suffix = suffix.slice(Math.min(suffix.length, prefix.length + suffix.length - minLen));
  }
  return { prefix, suffix };
}

export interface ColumnTemplate {
  /** Constant significant tokens ÷ significant tokens (separators are glue). */
  stability: number;
  /** Display string: tokens joined, slots shown as ⟨·⟩. */
  template: string;
  /** Template tokens (slots = '⟨·⟩') — replay compares against THESE. */
  tokens: string[];
  slots: number;
  /** Per input value (same order): the slot token values, or null when the
   *  value's token count differs from the modal structure. */
  slotValues: (string[] | null)[];
  /** Values matching the modal token structure — the honest template sample. */
  matching: number;
}

/** Positional token comparison → structural stability + slotted template. */
export function columnTemplate(values: (string | null)[]): ColumnTemplate | null {
  const present = values.filter((v): v is string => v !== null);
  if (present.length < 2) return null;
  const toks = present.map(tokenize);
  const lenCounts = new Map<number, number>();
  for (const t of toks) lenCounts.set(t.length, (lenCounts.get(t.length) ?? 0) + 1);
  let modalLen = 0;
  let bestN = 0;
  for (const [len, n] of lenCounts) if (n > bestN) { bestN = n; modalLen = len; }
  const sameLen = toks.filter((t) => t.length === modalLen);
  if (modalLen === 0 || sameLen.length < present.length * 0.7) return null;

  const volatile: boolean[] = new Array(modalLen).fill(false);
  const affixes: ({ prefix: string; suffix: string } | null)[] = new Array(modalLen).fill(null);
  const parts: string[] = [];
  let sigConstant = 0;
  let sigTotal = 0;
  let slots = 0;
  for (let j = 0; j < modalLen; j++) {
    const col = sameLen.map((t) => t[j]);
    if (col.every((x) => x === col[0])) {
      parts.push(col[0]);
      if (!isSeparatorToken(col[0])) {
        sigConstant += 1;
        sigTotal += 1;
      }
    } else {
      volatile[j] = true;
      slots += 1;
      sigTotal += 1; // variance is significant even at a separator position
      // Micro-template: "page_3.json" → "page_⟨·⟩.json" — the slot is only
      // the part that actually varies.
      const { prefix, suffix } = commonAffixes(col);
      affixes[j] = { prefix, suffix };
      parts.push(`${prefix}${SLOT_MARK}${suffix}`);
    }
  }
  // Slot values are the FULL volatile tokens (not the mid between affixes):
  // provenance searches upstream outputs for them and derive() must reproduce
  // them — upstream outputs contain "billing-api-service-00", not "00". The
  // affixed template token still constrains structure at replay time.
  const slotValues: (string[] | null)[] = values.map((v) => {
    if (v === null) return null;
    const t = tokenize(v);
    if (t.length !== modalLen) return null;
    return t.filter((_, j) => volatile[j]);
  });
  return {
    stability: sigTotal === 0 ? 1 : sigConstant / sigTotal,
    template: parts.join(''),
    tokens: parts,
    slots,
    slotValues,
    matching: sameLen.length,
  };
}

/**
 * Functional determinism on an aligned column: same tool input ⇒ same output?
 * Pairs each run's result with its tool_use via toolUseId (fallback: nearest
 * preceding tool_use in that run). Returns the honest evidence size — the
 * number of pairs inside multi-sample input groups — which is what confidence
 * must be computed on (NOT the cluster's run count).
 */
function memoizeColumn(
  column: AlignedColumn,
  runs: RunGraph[],
): { score: number; evidence: number; coverage: number } | null {
  const pairs: Array<{ input: string; output: string }> = [];
  for (let ri = 0; ri < runs.length; ri++) {
    const node = column.nodes[ri];
    if (!node) continue;
    const g = runs[ri];
    let use = node.toolUseId
      ? g.nodes.find((m) => m.kind === 'tool_use' && m.toolUseId === node.toolUseId)
      : undefined;
    if (!use) {
      for (let j = node.index - 1; j >= 0 && j >= node.index - 4; j--) {
        if (g.nodes[j].kind === 'tool_use') { use = g.nodes[j]; break; }
      }
    }
    if (!use) continue;
    pairs.push({ input: use.valueHash, output: node.valueHash });
  }
  if (pairs.length === 0) return null;

  const groups = new Map<string, string[]>();
  for (const p of pairs) {
    const arr = groups.get(p.input);
    if (arr) arr.push(p.output);
    else groups.set(p.input, [p.output]);
  }
  let agree = 0;
  let evidence = 0;
  for (const outs of groups.values()) {
    if (outs.length < 2) continue; // singleton inputs can't witness purity
    agree += modalCount(outs);
    evidence += outs.length;
  }
  if (evidence === 0) return null;
  return {
    score: Math.round((agree / evidence) * 100),
    evidence,
    coverage: evidence / pairs.length,
  };
}

export interface AnalyzeOptions {
  /** Minimum cluster size to analyze at all. */
  minRuns?: number;
  /** Similarity threshold for clustering (see align.ts). */
  threshold?: number;
  /** Wilson lower bound required for ANY action to fire. */
  minConfidence?: number;
}

/**
 * v3 cluster analysis over a window of runs (callers pre-slice to the most
 * recent ~40 sessions per agent). Clusters by alignment similarity, scores
 * every column of every cluster with ≥ minRuns support.
 */
export function analyzeDeterminism(graphs: RunGraph[], opts: AnalyzeOptions = {}): ClusterAnalysis[] {
  const minRuns = opts.minRuns ?? 2;
  const minConf = opts.minConfidence ?? 0.5;

  const clusters = clusterBySimilarity(graphs, { threshold: opts.threshold }).filter(
    (c) => c.runs.length >= minRuns,
  );

  const out: ClusterAnalysis[] = [];
  for (const cluster of clusters) {
    const alignment = alignCluster(cluster);
    const { medoid, runs } = cluster;
    const prompts = runs.map((r) => r.firstPrompt ?? r.canonicalFirstPrompt);

    const nodes: NodeAnalysis[] = [];
    let scoreSum = 0;
    let scored = 0;

    for (const col of alignment.columns) {
      const medoidNode = medoid.nodes[col.index];
      const cls = classifyNode(medoidNode);
      const pure = cls === 'mechanical' || cls === 'cacheable';
      const nonGap = col.nodes.filter((n): n is NonNullable<typeof n> => n !== null);
      const support = col.support;

      const base: NodeAnalysis = {
        index: col.index,
        label: medoidNode.label,
        structLabel: col.structLabel,
        kind: col.kind,
        class: cls,
        score: 0,
        confidence: 0,
        action: 'keep',
        level: pure && col.kind !== 'model_turn' ? 'D2' : 'D5',
        runCount: runs.length,
        support,
        pure,
        estUsdPerRun: support === 0 ? 0 : nonGap.reduce((s, n) => s + n.costUsd, 0) / support,
        estTokens: nonGap.reduce((s, n) => s + (n.tokensIn ?? 0) + (n.tokensOut ?? 0), 0),
      };

      const scoreable =
        support >= minRuns && col.kind !== 'thinking' && nonGap.some((n) => n.raw.length > 0);
      if (!scoreable) {
        nodes.push(base);
        continue;
      }

      // Value agreement on FULL-value hashes of raw payloads (numbers kept).
      const modal = modalCount(nonGap.map((n) => n.valueHash));
      const fullScore = Math.round((modal / support) * 100);
      const confAgree = wilsonLower(modal, support);
      base.score = fullScore;
      base.confidence = Math.round(confAgree * 100);
      scoreSum += fullScore;
      scored += 1;

      // D0 — constant value.
      if (fullScore >= 90 && confAgree >= 0.6) {
        base.level = 'D0';
        // A constant CALL is a compilable step; a constant result/output is replaceable.
        base.action = col.kind === 'tool_use' ? 'compile' : 'replace';
        nodes.push(base);
        continue;
      }

      // D2 — pure function of the input (tool results only).
      if (col.kind === 'tool_result') {
        const fn = memoizeColumn(col, runs);
        if (fn && fn.score >= 90 && fn.coverage >= 0.5) {
          const conf = wilsonLower(Math.round((fn.score / 100) * fn.evidence), fn.evidence);
          if (conf >= minConf) {
            base.action = 'memoize';
            base.level = 'D2';
            base.score = fn.score;
            base.confidence = Math.round(conf * 100);
            nodes.push(base);
            continue;
          }
        }
      }

      // D1 / D3 / D4 — template + provenance on inputs and model turns.
      // Tool inputs get a LOOSE stability gate: the safety comes from
      // slot-level provenance + replay, not from how much skeleton repeats.
      // Freeform model text keeps the strict gate.
      if (col.kind === 'tool_use' || col.kind === 'model_turn') {
        const values = col.nodes.map((n) => (n ? normalizeWs(n.raw) : null));
        const t = columnTemplate(values);
        if (t && t.slots > 0) {
          const tConf = wilsonLower(t.matching, support);
          const minStability = col.kind === 'tool_use' ? 0.5 : 0.85;
          if (t.stability >= minStability && tConf >= minConf) {
            base.score = Math.round(t.stability * 100);
            base.confidence = Math.round(tConf * 100);
            base.template = t.template;
            base.templateTokens = t.tokens;
            if (col.kind === 'tool_use') {
              const traces = traceSlots({
                columns: alignment.columns,
                colIndex: col.index,
                slotValues: t.slotValues,
                prompts,
              });
              base.provenance = traces;
              const resolved = traces.length > 0 && traces.every((tr) => tr.kind !== 'unresolved');
              base.action = resolved ? 'compile' : 'template';
              base.level = resolved ? 'D1' : 'D3';
            } else {
              base.action = 'template';
              base.level = 'D3';
            }
            nodes.push(base);
            continue;
          }
          if (col.kind === 'model_turn' && t.stability >= 0.55 && tConf >= minConf) {
            base.action = 'route';
            base.level = 'D4';
            base.score = Math.round(t.stability * 100);
            base.confidence = Math.round(tConf * 100);
            nodes.push(base);
            continue;
          }
        }
      }

      // D4 — mostly-stable value.
      if (fullScore >= 70 && confAgree >= minConf) {
        base.action = 'cache';
        base.level = pure ? 'D2' : 'D4';
      }
      nodes.push(base);
    }

    const totalInsertions = alignment.insertions.reduce((s, n) => s + n, 0);
    out.push({
      l1: medoid.l1,
      agentId: cluster.agentId,
      runCount: runs.length,
      runIds: runs.map((r) => r.runId),
      medoidRunId: medoid.runId,
      labelSequence: medoid.labelSequence,
      meanScore: scored ? Math.round(scoreSum / scored) : 0,
      meanSim: Math.round(cluster.meanSim * 100) / 100,
      insertionRate:
        medoid.nodes.length === 0
          ? 0
          : Math.round((totalInsertions / runs.length / medoid.nodes.length) * 100) / 100,
      nodes,
      alignment,
    });
  }

  out.sort((a, b) => b.runCount - a.runCount);
  return out;
}
