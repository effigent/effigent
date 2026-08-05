// VENDORED from packages/core/src/ledger.ts — re-vendor after core changes (see CLAUDE.md §6)
/**
 * The waste ledger — per-run spend decomposition into ADDRESSABLE waste classes.
 *
 * Unlike the determinism lattice (which needs cross-run alignment to say anything),
 * every detector here is within-run and deterministic, so the ledger is never
 * empty: it produces a quantified decomposition from the very first captured run.
 * Detectors:
 *
 *  - DEAD CONTEXT   a large tool_result is carried through every subsequent LLM
 *                   call; from the last step that actually references its content
 *                   onward, that carriage is waste.
 *  - CACHE MISSES   input tokens re-billed at full price that a stable prompt
 *                   prefix would have served at the 0.1× cache-read rate.
 *  - ERROR LOOPS    the recovery tail after failed tool calls.
 *  - REDUNDANT CALLS a read-only call repeated within one run with an identical
 *                   answer — the repeat bought nothing.
 *
 * ANTI-OVERFITTING RULES (all deliberate, do not tune against one agent's data):
 *  1. Every threshold below was fixed a priori and is conservative — when a
 *     detector is unsure, it claims NOTHING (e.g. results with few distinctive
 *     tokens are treated as always-referenced; a repeated read whose answer
 *     changed is legitimate, not redundant).
 *  2. Token estimates come from stored text (chars/4). Stored payloads are
 *     truncated upstream, so estimates UNDERSTATE real carriage.
 *  3. Prices are measured, not assumed: carriage is priced at the run's own
 *     effective input rate (actual input-side spend / actual input-side tokens),
 *     which already reflects whatever prompt caching the agent achieved.
 *  4. Slices are independent estimates of different inefficiencies, NOT a
 *     partition of the run cost — they are individually clamped to the run's
 *     cost but must not be summed and compared to it.
 *
 * MEASURED (2026-08, 65 runs across three unrelated agents — see the
 * verification harness in the PR that added this file):
 *  - zero invariant violations; every sampled dead-context claim was confirmed
 *    by an independent substring scan;
 *  - sensitivity: MAX_DOC_FREQ barely moves results (±0–21%); MIN_OVERLAP is
 *    the sensitive knob (2→3 roughly doubles claimed dead context). The
 *    default 2 is the CONSERVATIVE side — raising it claims more, not less;
 *  - cache misses were the dominant slice on all three agents (~9–13% of
 *    spend at 97%+ hit rates); dead context was small in dollars precisely
 *    because the measured cache-blended price makes carried tokens cheap.
 *    Note the cache-miss estimate is an UPPER BOUND: a context compaction
 *    legitimately cold-starts the prefix, and this detector cannot see
 *    compaction boundaries.
 */

import type { Run, RunGraph } from './types.ts';
import { pricingFor } from './cost.ts';
import { attributeStepCosts } from './segments.ts';
import { classifyNode } from './taxonomy.ts';

// ---- fixed parameters (see anti-overfitting rules above) -----------------------
/** Results smaller than this (est. tokens) are never flagged — too small to matter. */
const MIN_RESULT_TOKENS = 500;
/** Distinctive tokens: word-ish, at least this long. */
const MIN_TOKEN_LEN = 5;
/** A token present in more than this share of the run's steps is background noise. */
const MAX_DOC_FREQ = 0.25;
/** A result with fewer distinctive tokens than this is treated as always-referenced. */
const MIN_DISTINCTIVE = 8;
/** A later step "references" a result when it contains at least this many of its distinctive tokens. */
const MIN_OVERLAP = 2;
/** Error-recovery window cap (steps) — beyond this we stop attributing cost to the error. */
const MAX_RECOVERY_STEPS = 12;
/** chars → tokens */
const CHARS_PER_TOKEN = 4;

export interface CarriageFinding {
  resultIndex: number;
  tool: string;
  estTokens: number;
  /** Last step index whose text references this result's content; null = never referenced. */
  lastReferencedAt: number | null;
  /** LLM calls that carried the result after it was last useful. */
  deadCalls: number;
  wastedUsd: number;
  preview: string;
}

export interface RedundantCall {
  structLabel: string;
  occurrences: number;
  indices: number[];
  wastedUsd: number;
  preview: string;
}

export interface ErrorLoop {
  errorIndex: number;
  tool: string;
  recoverySteps: number;
  recoveryUsd: number;
  preview: string;
}

export interface RunLedger {
  runId: string;
  costUsd: number;
  /** LLM requests observed in the run (steps carrying usage). */
  modelCalls: number;
  /** Measured effective USD per input-side token (cache-blended). */
  effInputPricePerTok: number;
  carriage: {
    /** Total estimated input-side spend on carrying tool results at all. */
    carriedUsd: number;
    /** The dead share: carried after last reference. */
    deadUsd: number;
    findings: CarriageFinding[];
  };
  cache: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    hitRate: number;
    /** True when the run shows ≥3 LLM calls and zero cache reads. */
    apparentlyDisabled: boolean;
    missedReadTokens: number;
    missedUsd: number;
  };
  errors: {
    count: number;
    recoveryUsd: number;
    loops: ErrorLoop[];
  };
  redundant: {
    wastedUsd: number;
    calls: RedundantCall[];
  };
}

const WORD_RE = /[A-Za-z0-9_./-]{2,}/g;

function tokenizeText(s: string): string[] {
  return (s.match(WORD_RE) ?? []).map((t) => t.toLowerCase());
}

function estTokens(raw: string): number {
  return Math.ceil(raw.length / CHARS_PER_TOKEN);
}

/**
 * Effective input-side price per token, measured from the run's own usage —
 * a run that caches well pays ~0.1× on most input tokens, and the carriage
 * estimates must reflect that reality rather than list price.
 */
function effectiveInputPrice(run: Run): { pricePerTok: number; modelCalls: number } {
  let usd = 0;
  let toks = 0;
  let calls = 0;
  for (const s of run.steps) {
    if (!s.tokens || !s.model) continue;
    calls++;
    const p = pricingFor(s.model);
    const cc = s.tokens.cacheCreation ?? 0;
    const cr = s.tokens.cacheRead ?? 0;
    usd += (s.tokens.input * p.inputPerM + cc * p.inputPerM * 1.25 + cr * p.inputPerM * 0.1) / 1_000_000;
    toks += s.tokens.input + cc + cr;
  }
  return { pricePerTok: toks > 0 ? usd / toks : 0, modelCalls: calls };
}

/** Per-step distinctive-token sets + run-level document frequency. */
function distinctiveSets(graph: RunGraph, maxDocFreq: number): { sets: Array<Set<string>>; background: Set<string> } {
  const perStep: string[][] = graph.nodes.map((n) => tokenizeText(n.raw));
  const df = new Map<string, number>();
  for (const toks of perStep) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const cutoff = Math.max(2, graph.nodes.length * maxDocFreq);
  const background = new Set([...df.entries()].filter(([, n]) => n > cutoff).map(([t]) => t));
  const sets = perStep.map(
    (toks) => new Set(toks.filter((t) => t.length >= MIN_TOKEN_LEN && !background.has(t))),
  );
  return { sets, background };
}

/** Overrides exist ONLY for sensitivity verification — production always uses the defaults. */
export interface LedgerOptions {
  maxDocFreq?: number;
  minOverlap?: number;
}

function detectDeadContext(
  run: Run,
  graph: RunGraph,
  pricePerTok: number,
  opts: LedgerOptions = {},
): RunLedger['carriage'] {
  const minOverlap = opts.minOverlap ?? MIN_OVERLAP;
  const { sets } = distinctiveSets(graph, opts.maxDocFreq ?? MAX_DOC_FREQ);
  // Steps that start an LLM request — the unit of "carried once more".
  const requestIdx = run.steps
    .map((s, i) => (s.tokens && s.model ? i : -1))
    .filter((i) => i >= 0);

  const findings: CarriageFinding[] = [];
  let carriedUsd = 0;
  let deadUsd = 0;

  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    if (n.kind !== 'tool_result') continue;
    const size = estTokens(n.raw);
    if (size < MIN_RESULT_TOKENS) continue;

    const callsAfterProduce = requestIdx.filter((r) => r > i).length;
    carriedUsd += size * pricePerTok * callsAfterProduce;

    const own = sets[i];
    // Too little distinctive content to track honestly → assume it stays useful.
    if (own.size < MIN_DISTINCTIVE) continue;

    let lastRef: number | null = null;
    for (let j = i + 1; j < graph.nodes.length; j++) {
      let overlap = 0;
      for (const t of sets[j]) {
        if (own.has(t) && ++overlap >= minOverlap) break;
      }
      if (overlap >= minOverlap) lastRef = j;
    }

    // The first request after the result must see it (the model had to read the
    // answer once); waste starts only after max(last reference, that first look).
    const anchor = Math.max(lastRef ?? i, i);
    const firstLook = requestIdx.find((r) => r > anchor);
    if (firstLook === undefined) continue;
    const deadCalls = requestIdx.filter((r) => r > firstLook).length;
    if (deadCalls === 0) continue;

    const wastedUsd = size * pricePerTok * deadCalls;
    deadUsd += wastedUsd;
    findings.push({
      resultIndex: i,
      tool: n.structLabel.startsWith('result:') ? n.structLabel.slice(7).split(':')[0] : n.structLabel,
      estTokens: size,
      lastReferencedAt: lastRef,
      deadCalls,
      wastedUsd,
      preview: n.raw.slice(0, 120),
    });
  }

  findings.sort((a, b) => b.wastedUsd - a.wastedUsd);
  return {
    carriedUsd: Math.min(carriedUsd, graph.costUsd),
    deadUsd: Math.min(deadUsd, graph.costUsd),
    findings: findings.slice(0, 10),
  };
}

function detectCacheMisses(run: Run): RunLedger['cache'] {
  interface Req { model: string; input: number; cc: number; cr: number }
  const reqs: Req[] = [];
  for (const s of run.steps) {
    if (!s.tokens || !s.model) continue;
    reqs.push({
      model: s.model,
      input: s.tokens.input,
      cc: s.tokens.cacheCreation ?? 0,
      cr: s.tokens.cacheRead ?? 0,
    });
  }
  let input = 0, cr = 0, cc = 0, missed = 0, missedUsd = 0;
  for (const r of reqs) { input += r.input; cr += r.cr; cc += r.cc; }

  // In an agentic loop, request N's context extends request N-1's — so N-1's
  // whole input side is cacheable prefix for N (same model only; a model switch
  // legitimately starts a cold prompt).
  for (let i = 1; i < reqs.length; i++) {
    const prev = reqs[i - 1];
    const cur = reqs[i];
    if (prev.model !== cur.model) continue;
    const prevTotal = prev.input + prev.cc + prev.cr;
    const curTotal = cur.input + cur.cc + cur.cr;
    const expectedRead = Math.min(prevTotal, curTotal);
    const m = Math.max(0, expectedRead - cur.cr);
    missed += m;
    missedUsd += (m * pricingFor(cur.model).inputPerM * 0.9) / 1_000_000;
  }

  const denom = input + cr + cc;
  return {
    inputTokens: input,
    cacheReadTokens: cr,
    cacheCreationTokens: cc,
    hitRate: denom > 0 ? cr / denom : 0,
    apparentlyDisabled: reqs.length >= 3 && cr === 0,
    missedReadTokens: missed,
    missedUsd: Math.min(missedUsd, run.costUsd ?? Number.POSITIVE_INFINITY),
  };
}

function detectErrorLoops(graph: RunGraph): RunLedger['errors'] {
  const costs = attributeStepCosts(graph);
  const inRecovery = new Set<number>();
  const loops: ErrorLoop[] = [];
  let errorCount = 0;

  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    if (n.kind !== 'tool_result' || !n.isError) continue;
    errorCount++;
    const tool = n.structLabel.startsWith('result:') ? n.structLabel.slice(7).split(':')[0] : n.structLabel;

    let end = i;
    for (let j = i + 1; j < graph.nodes.length && j <= i + MAX_RECOVERY_STEPS; j++) {
      const m = graph.nodes[j];
      // Recovered: the same tool succeeded, or the user intervened.
      if (m.kind === 'tool_result' && !m.isError && m.structLabel.includes(tool)) { end = j; break; }
      if (m.kind === 'model_turn' && m.structLabel.startsWith('llm:user')) { end = j - 1; break; }
      end = j;
    }
    let usd = 0;
    let steps = 0;
    for (let j = i; j <= end; j++) {
      if (inRecovery.has(j)) continue; // consecutive errors: never double-count a step
      inRecovery.add(j);
      usd += costs[j];
      steps++;
    }
    // A step already claimed by a previous error's recovery is never re-counted;
    // consecutive errors therefore merge into one recovery EPISODE (steps === 0
    // adds no loop entry) while `count` still reports every error event.
    if (steps > 0) loops.push({ errorIndex: i, tool, recoverySteps: steps, recoveryUsd: usd, preview: n.raw.slice(0, 120) });
  }

  loops.sort((a, b) => b.recoveryUsd - a.recoveryUsd);
  return {
    count: errorCount,
    recoveryUsd: Math.min(loops.reduce((s, l) => s + l.recoveryUsd, 0), graph.costUsd),
    loops: loops.slice(0, 10),
  };
}

function detectRedundantCalls(graph: RunGraph): RunLedger['redundant'] {
  const costs = attributeStepCosts(graph);
  // Identical read-only question asked twice in one run AND answered identically —
  // if the answer changed, the re-ask was legitimate (the world moved).
  const byPayload = new Map<string, number[]>();
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    if (n.kind !== 'tool_use') continue;
    const cls = classifyNode(n);
    if (cls !== 'mechanical' && cls !== 'cacheable') continue;
    (byPayload.get(n.valueHash) ?? byPayload.set(n.valueHash, []).get(n.valueHash)!).push(i);
  }

  const resultOf = (i: number): number | null => {
    const id = graph.nodes[i].toolUseId;
    if (!id) return graph.nodes[i + 1]?.kind === 'tool_result' ? i + 1 : null;
    for (let j = i + 1; j < Math.min(graph.nodes.length, i + 6); j++) {
      if (graph.nodes[j].kind === 'tool_result' && graph.nodes[j].toolUseId === id) return j;
    }
    return null;
  };

  const calls: RedundantCall[] = [];
  let wastedUsd = 0;
  for (const [, idxs] of byPayload) {
    if (idxs.length < 2) continue;
    const resIdx = idxs.map(resultOf);
    if (resIdx.some((r) => r === null)) continue;
    const answers = new Set(resIdx.map((r) => graph.nodes[r!].valueHash));
    if (answers.size !== 1) continue; // answer changed → legitimate re-ask

    // Everything after the first ask+answer bought nothing.
    let usd = 0;
    for (let k = 1; k < idxs.length; k++) usd += costs[idxs[k]] + costs[resIdx[k]!];
    wastedUsd += usd;
    calls.push({
      structLabel: graph.nodes[idxs[0]].structLabel,
      occurrences: idxs.length,
      indices: idxs,
      wastedUsd: usd,
      preview: graph.nodes[idxs[0]].raw.slice(0, 120),
    });
  }

  calls.sort((a, b) => b.wastedUsd - a.wastedUsd);
  return { wastedUsd: Math.min(wastedUsd, graph.costUsd), calls: calls.slice(0, 10) };
}

export function computeRunLedger(run: Run, graph: RunGraph, opts: LedgerOptions = {}): RunLedger {
  const { pricePerTok, modelCalls } = effectiveInputPrice(run);
  return {
    runId: graph.runId,
    costUsd: graph.costUsd,
    modelCalls,
    effInputPricePerTok: pricePerTok,
    carriage: detectDeadContext(run, graph, pricePerTok, opts),
    cache: detectCacheMisses(run),
    errors: detectErrorLoops(graph),
    redundant: detectRedundantCalls(graph),
  };
}

export interface AgentLedger {
  runCount: number;
  totalUsd: number;
  /** Independent per-class estimates — see the header: not a partition, do not sum. */
  slices: {
    deadContextUsd: number;
    carriedUsd: number;
    cacheMissUsd: number;
    errorRecoveryUsd: number;
    redundantUsd: number;
  };
  cacheHitRate: number;
  cacheApparentlyDisabledRuns: number;
  errorCount: number;
  topDeadContext: Array<CarriageFinding & { runId: string }>;
  topErrorLoops: Array<ErrorLoop & { runId: string }>;
  topRedundant: Array<RedundantCall & { runId: string }>;
}

export function aggregateLedgers(ledgers: RunLedger[]): AgentLedger {
  const agg: AgentLedger = {
    runCount: ledgers.length,
    totalUsd: 0,
    slices: { deadContextUsd: 0, carriedUsd: 0, cacheMissUsd: 0, errorRecoveryUsd: 0, redundantUsd: 0 },
    cacheHitRate: 0,
    cacheApparentlyDisabledRuns: 0,
    errorCount: 0,
    topDeadContext: [],
    topErrorLoops: [],
    topRedundant: [],
  };
  let cacheNum = 0;
  let cacheDen = 0;
  for (const l of ledgers) {
    agg.totalUsd += l.costUsd;
    agg.slices.deadContextUsd += l.carriage.deadUsd;
    agg.slices.carriedUsd += l.carriage.carriedUsd;
    agg.slices.cacheMissUsd += l.cache.missedUsd;
    agg.slices.errorRecoveryUsd += l.errors.recoveryUsd;
    agg.slices.redundantUsd += l.redundant.wastedUsd;
    cacheNum += l.cache.cacheReadTokens;
    cacheDen += l.cache.inputTokens + l.cache.cacheReadTokens + l.cache.cacheCreationTokens;
    if (l.cache.apparentlyDisabled) agg.cacheApparentlyDisabledRuns++;
    agg.errorCount += l.errors.count;
    agg.topDeadContext.push(...l.carriage.findings.map((f) => ({ ...f, runId: l.runId })));
    agg.topErrorLoops.push(...l.errors.loops.map((f) => ({ ...f, runId: l.runId })));
    agg.topRedundant.push(...l.redundant.calls.map((f) => ({ ...f, runId: l.runId })));
  }
  agg.cacheHitRate = cacheDen > 0 ? cacheNum / cacheDen : 0;
  agg.topDeadContext = agg.topDeadContext.sort((a, b) => b.wastedUsd - a.wastedUsd).slice(0, 10);
  agg.topErrorLoops = agg.topErrorLoops.sort((a, b) => b.recoveryUsd - a.recoveryUsd).slice(0, 10);
  agg.topRedundant = agg.topRedundant.sort((a, b) => b.wastedUsd - a.wastedUsd).slice(0, 10);
  return agg;
}
