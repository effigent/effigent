/**
 * Context rent — the cost model for interactive agents (docs/context-rent.md).
 *
 * The physics: an LLM request is billed for everything in its context window,
 * every time. Measured over 38,571 real requests (9 projects, $9.4k), output
 * tokens — the model's actual reasoning — were 8.6% of spend; re-reading
 * context was 54%, writing it into the cache 19%. The money is not in what the
 * model decides, it is in what it carries while deciding.
 *
 * So account for context the way a compiler accounts for live values:
 *
 *   ctx_k   tokens request k read (last sampling iteration — see StepTokens.context)
 *   Δ_k     = ctx_{k+1} − ctx_k   what entered context between request k and k+1
 *   rent(Δ) = Δ × Σ_{j ≥ k+2, same segment} readPrice(model_j)
 *   base    = ctx_0 × Σ readPrice  (system prompt + tools + memory, re-read every request)
 *
 * A segment ends where context collapses (a compaction or clear: Δ < −40%).
 * Σ rent + base reproduces the observed cache-read spend EXACTLY (100.0% over
 * 38k requests) — so this is a decomposition, not an estimate, and every
 * dollar of it can be attributed to what was deposited: thinking and visible
 * output exactly (from usage), tool results / user text by measured chars,
 * the remainder to harness injections.
 *
 * On top of the ledger, `simulateCompaction` replays a run's OBSERVED deposits
 * under a "compact at T tokens" policy (calibration: 100.8% of observed cost at
 * the observed policy; deposit rate after real compactions is unchanged, 1,493
 * vs 1,345 tokens/request, n=25), charging each compaction its measured price:
 * the summary call, a rewritten prefix, and a re-exploration burst whose size is
 * taken from fresh-session first episodes (p50 15k tokens / 8 requests, p90
 * 37k / 17). `recommendCompaction` picks the threshold whose WORST savings
 * across those scenarios is highest — robustness over the best case.
 */

import type { Run } from './types.js';
import { pricingFor } from './cost.js';
import { isReadOnlyCall } from './actions.js';

// ---- fixed parameters (measured, see docs/context-rent.md) ---------------------
/** Context drop that marks a reset (compaction / clear). */
const RESET_DROP = 0.4;
/** A request re-WROTE the prefix (cache expired) when its writes exceed this share of the previous context. */
const COLD_WRITE_SHARE = 0.5;
const COLD_MIN_CTX = 20_000;
/** chars → tokens for tool output (code/logs measured ~3.2). Used only to SPLIT a measured Δ. */
const CHARS_PER_TOKEN = 3.2;

export interface RentRequest {
  index: number;
  model: string;
  timestamp?: string;
  context: number;
  input: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  thinking: number;
  costUsd: number;
  /** Tool calls this request issued. */
  tools: { name: string; resultChars: number; preview: string; readOnly: boolean; command?: string; isError?: boolean; subagent?: string }[];
  /** User text that arrived before the NEXT request. */
  userChars: number;
}

export type DepositKind = 'thinking' | 'output' | 'tool_result' | 'user' | 'harness';

export interface Deposit {
  /** Request after which the tokens entered context. */
  afterRequest: number;
  tokens: number;
  kind: DepositKind;
  /** Tool name for tool_result deposits. */
  tool?: string;
  /** Requests that re-read it before the next reset. */
  carriedFor: number;
  rentUsd: number;
  preview: string;
}

export interface RentLedger {
  runId: string;
  requests: number;
  costUsd: number;
  /** Observed spend by physical quantity. */
  spend: { outputUsd: number; thinkingUsd: number; cacheReadUsd: number; cacheWriteUsd: number; uncachedUsd: number; sideModelUsd: number; subagentUsd: number };
  /** The rent decomposition of cacheReadUsd. */
  rent: { baseUsd: number; byKind: Record<DepositKind, number>; byTool: Record<string, number> };
  /** modelled rent / observed cache-read spend — the identity check (≈1). */
  calibration: number;
  /** Prefix re-writes after the cache expired (idle gaps), with the penalty over a read. */
  coldRewrites: { count: number; penaltyUsd: number };
  baseContext: number;
  peakContext: number;
  resets: number;
  /** The most expensive single deposits. */
  topDeposits: Deposit[];
  /** Per-request context composition (only with `series: true`) — what the skyline draws. */
  series?: ContextPoint[];
  /** Parsed by the pre-2026-09 parser: no true context — context figures are not trustworthy. */
  legacyParse: boolean;
}

export interface ContextPoint {
  request: number;
  timestamp?: string;
  context: number;
  /** Tokens of each kind currently in context (base = what the segment started with). */
  base: number;
  kinds: Record<DepositKind, number>;
  reset: boolean;
}

function readPerToken(model: string): number {
  const p = pricingFor(model);
  return (p.inputPerM * (p.cacheReadMult ?? 0.1)) / 1_000_000;
}

function writePerToken(model: string, oneHour: boolean): number {
  return (pricingFor(model).inputPerM * (oneHour ? 2 : 1.25)) / 1_000_000;
}

/**
 * Runs parsed before 2026-09 (every row already stored in prod) carry no true
 * per-request context and no 5m/1h split. Their context would be the SUMMED
 * iterations — phantom spikes and resets — so context analysis must refuse them
 * rather than price noise. Re-uploading the session
 * re-uploading with `effigent sync --force` re-parses it; raw JSONL is not kept server-side.
 */
export function isLegacyParse(run: Pick<Run, 'steps'>): boolean {
  return run.steps.some((s) => s.tokens) && !run.steps.some((s) => s.tokens?.context != null);
}

/** Group a run's steps into LLM requests (a request starts at each step carrying usage). */
export function requestsOf(run: Run): RentRequest[] {
  const out: RentRequest[] = [];
  const legacy = isLegacyParse(run);
  const byToolUse = new Map<string, RentRequest['tools'][number]>();
  let pendingUser = 0;
  for (const s of run.steps) {
    if (s.tokens && s.model) {
      if (out.length) out[out.length - 1].userChars += pendingUser;
      pendingUser = 0;
      const t = s.tokens;
      const cw = t.cacheCreation ?? 0;
      // legacy blobs: price writes as 1h, exactly like runCostUsd, so nothing leaks into sideModelUsd
      const cw1h = Math.min(t.cacheCreation1h ?? (legacy ? cw : 0), cw);
      const cr = t.cacheRead ?? 0;
      const p = pricingFor(s.model);
      out.push({
        index: out.length,
        model: s.model,
        timestamp: s.timestamp,
        context: t.context ?? t.input + cw + cr,
        input: t.input,
        cacheWrite: cw,
        cacheWrite1h: cw1h,
        cacheRead: cr,
        output: t.output,
        thinking: Math.min(t.thinking ?? 0, t.output),
        costUsd:
          (t.input * p.inputPerM + (cw - cw1h) * p.inputPerM * 1.25 + cw1h * p.inputPerM * 2 +
            cr * p.inputPerM * (p.cacheReadMult ?? 0.1) + t.output * p.outputPerM) / 1_000_000,
        tools: [],
        userChars: 0,
      });
    }
    const cur = out[out.length - 1];
    if (!cur) continue;
    if (s.kind === 'tool_use') {
      let command: string | undefined;
      let subagent: string | undefined;
      if (s.name === 'Bash' || s.name === 'Agent' || s.name === 'Task') {
        try {
          const input = JSON.parse(s.payload) as { command?: string; subagent_type?: string };
          if (s.name === 'Bash') command = String(input.command ?? '').slice(0, 2000);
          else subagent = input.subagent_type ?? 'general-purpose';
        } catch { /* not JSON */ }
      }
      const tool: RentRequest['tools'][number] = { name: s.name, resultChars: 0, preview: s.payload.slice(0, 120), readOnly: isReadOnlyCall(s), command, subagent };
      cur.tools.push(tool);
      if (s.toolUseId) byToolUse.set(s.toolUseId, tool);
    } else if (s.kind === 'tool_result') {
      const tool = (s.toolUseId && byToolUse.get(s.toolUseId)) || cur.tools[cur.tools.length - 1];
      if (tool) { tool.resultChars += s.fullChars ?? s.payload.length; if (s.isError) tool.isError = true; }
    } else if (s.kind === 'model_turn' && s.name === 'user') {
      pendingUser += s.payload.length;
    }
  }
  return out;
}

/** Segment ends: segEnd[k] = last request index that still carries request k's context. */
function segmentEnds(R: RentRequest[]): number[] {
  const segEnd = new Array<number>(R.length);
  let end = R.length - 1;
  for (let k = R.length - 1; k >= 0; k--) {
    segEnd[k] = end;
    if (k > 0 && R[k].context < (1 - RESET_DROP) * R[k - 1].context) end = k - 1;
  }
  return segEnd;
}

export function computeRentLedger(run: Run, opts: { topN?: number; series?: boolean } = {}): RentLedger {
  const R = requestsOf(run);
  const byKind: Record<DepositKind, number> = { thinking: 0, output: 0, tool_result: 0, user: 0, harness: 0 };
  const byTool: Record<string, number> = {};
  const deposits: Deposit[] = [];
  const series: ContextPoint[] = [];
  const spend = { outputUsd: 0, thinkingUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, uncachedUsd: 0, sideModelUsd: 0, subagentUsd: run.subagents?.costUsd ?? 0 };
  let baseUsd = 0;
  let coldCount = 0;
  let coldPenalty = 0;
  let resets = 0;

  for (const r of R) {
    const p = pricingFor(r.model);
    spend.thinkingUsd += (r.thinking * p.outputPerM) / 1e6;
    spend.outputUsd += ((r.output - r.thinking) * p.outputPerM) / 1e6;
    spend.cacheReadUsd += r.cacheRead * readPerToken(r.model);
    spend.cacheWriteUsd += ((r.cacheWrite - r.cacheWrite1h) * 1.25 + r.cacheWrite1h * 2) * p.inputPerM / 1e6;
    spend.uncachedUsd += (r.input * p.inputPerM) / 1e6;
  }
  const requestUsd = R.reduce((s, r) => s + r.costUsd, 0);
  // Usage the per-request tokens do not carry: subagents (measured from their own
  // transcripts) and the rest — advisor-tool iterations, other side models.
  spend.sideModelUsd = Math.max(0, run.costUsd - requestUsd - spend.subagentUsd);

  if (R.length) {
    const segEnd = segmentEnds(R);
    const suffix = new Array<number>(R.length + 1).fill(0);
    for (let k = R.length - 1; k >= 0; k--) suffix[k] = suffix[k + 1] + readPerToken(R[k].model);
    const carry = (from: number, to: number) => (from > to ? 0 : suffix[from] - suffix[to + 1]);

    baseUsd += R[0].context * carry(1, segEnd[0]);
    for (let k = 1; k < R.length; k++) {
      if (segEnd[k - 1] === k - 1) { resets++; baseUsd += R[k].context * carry(k + 1, segEnd[k]); }
    }

    const zero = (): Record<DepositKind, number> => ({ thinking: 0, output: 0, tool_result: 0, user: 0, harness: 0 });
    /** What each step deposited, by kind — the skyline is built from these. */
    const stepSplits: [DepositKind, number][][] = [];
    for (let k = 0; k + 1 < R.length; k++) {
      const r = R[k];
      const next = R[k + 1];
      if (k > 0 && next.cacheWrite > COLD_WRITE_SHARE * r.context && r.context > COLD_MIN_CTX && next.model === r.model) {
        coldCount++;
        coldPenalty += Math.min(next.cacheWrite, r.context) *
          (writePerToken(next.model, next.cacheWrite1h > 0) - readPerToken(next.model));
      }
      if (segEnd[k] === k) continue; // context collapsed after k — nothing carried across
      const d = next.context - r.context;
      if (d <= 0) continue;
      const c = carry(k + 2, segEnd[k + 1]);
      const carriedFor = Math.max(0, segEnd[k + 1] - k - 1);

      // Exact parts first: generated tokens stay in context.
      const thinking = Math.min(r.thinking, d);
      const output = Math.min(r.output - r.thinking, d - thinking);
      let rest = d - thinking - output;
      const push = (kind: DepositKind, tokens: number, preview: string, tool?: string) => {
        if (tokens <= 0) return;
        (stepSplits[k] ??= []).push([kind, tokens]);
        const rentUsd = tokens * c;
        byKind[kind] += rentUsd;
        if (tool) byTool[tool] = (byTool[tool] ?? 0) + rentUsd;
        deposits.push({ afterRequest: k, tokens: Math.round(tokens), kind, tool, carriedFor, rentUsd, preview });
      };
      push('thinking', thinking, '');
      push('output', output, r.tools.map((t) => `${t.name} ${t.preview}`).join(' ; ').slice(0, 160));
      // Split the measured remainder by measured chars; what chars cannot explain is harness text.
      const parts = [
        ...r.tools.map((t) => ({ kind: 'tool_result' as const, chars: t.resultChars, tool: t.name, preview: t.preview })),
        { kind: 'user' as const, chars: r.userChars, tool: undefined, preview: '' },
      ].filter((x) => x.chars > 0);
      const chars = parts.reduce((s, x) => s + x.chars, 0);
      const explained = Math.min(rest, chars / CHARS_PER_TOKEN);
      for (const x of parts) push(x.kind, (explained * x.chars) / chars, x.preview, x.tool);
      rest -= explained;
      push('harness', rest, '');
    }
    if (opts.series) {
      // Rebuild the per-request series from the recorded composition steps.
      let c = { base: R[0].context, kinds: zero() };
      const perStep = stepSplits;
      series.push({ request: 0, timestamp: R[0].timestamp, context: R[0].context, base: c.base, kinds: { ...c.kinds }, reset: false });
      for (let k = 0; k + 1 < R.length; k++) {
        const reset = segEnd[k] === k;
        if (reset) c = { base: R[k + 1].context, kinds: zero() };
        else for (const [kind, t] of perStep[k] ?? []) c.kinds[kind] += t;
        series.push({ request: k + 1, timestamp: R[k + 1].timestamp, context: R[k + 1].context, base: c.base, kinds: { ...c.kinds }, reset });
      }
    }
  }

  const rentTotal = baseUsd + Object.values(byKind).reduce((s, v) => s + v, 0);
  deposits.sort((a, b) => b.rentUsd - a.rentUsd);
  return {
    runId: run.runId,
    requests: R.length,
    costUsd: run.costUsd,
    spend,
    rent: { baseUsd, byKind, byTool },
    calibration: spend.cacheReadUsd > 0 ? rentTotal / spend.cacheReadUsd : 1,
    coldRewrites: { count: coldCount, penaltyUsd: coldPenalty },
    baseContext: R[0]?.context ?? 0,
    peakContext: R.reduce((m, r) => Math.max(m, r.context), 0),
    resets,
    topDeposits: deposits.slice(0, opts.topN ?? 5),
    ...(opts.series ? { series } : {}),
    legacyParse: isLegacyParse(run),
  };
}

// ---- counterfactual: compaction policy ------------------------------------------

export interface ReacquisitionScenario {
  name: string;
  /** Tokens the agent re-reads after losing its history. */
  tokens: number;
  /** Extra requests it spends doing so. */
  requests: number;
  /** Summary the compaction call writes (becomes the new context on top of the base). */
  summaryTokens: number;
}

/** Measured on fresh-session first episodes (p50, p90) plus a 3× p90 stress case. */
export const REACQUISITION_SCENARIOS: ReacquisitionScenario[] = [
  { name: 'p50', tokens: 15_000, requests: 8, summaryTokens: 12_000 },
  { name: 'p90', tokens: 37_000, requests: 17, summaryTokens: 12_000 },
  { name: 'stress', tokens: 110_000, requests: 50, summaryTokens: 30_000 },
];

/**
 * Replay a run under "compact whenever context would exceed `threshold`".
 * With threshold = Infinity it reproduces the observed cost (the calibration).
 */
export function simulateCompaction(
  run: Run,
  threshold: number,
  scenario: ReacquisitionScenario = REACQUISITION_SCENARIOS[0],
  trace?: number[],
): { costUsd: number; compactions: number } {
  const R = requestsOf(run);
  if (!R.length) return { costUsd: run.costUsd, compactions: 0 };
  const base = R[0].context;
  let ctx = base;
  let cost = Math.max(0, run.costUsd - R.reduce((s, r) => s + r.costUsd, 0)); // side models + subagents: policy-independent
  let compactions = 0;
  let reacqLeft = 0;
  for (let k = 0; k < R.length; k++) {
    const r = R[k];
    const p = pricingFor(r.model);
    const rp = readPerToken(r.model);
    const wp = writePerToken(r.model, r.cacheWrite1h > 0);
    const op = p.outputPerM / 1e6;
    const prev = k > 0 ? R[k - 1] : undefined;
    if (prev) {
      const d = r.context - prev.context;
      // An observed reset stays a reset; otherwise the simulated context grows by the observed deposit.
      ctx = d < -RESET_DROP * prev.context ? Math.min(ctx, r.context) : Math.max(base * 0.5, ctx + d);
    }
    if (ctx > threshold) {
      compactions++;
      cost += ctx * rp + scenario.summaryTokens * op; // the compaction call reads everything once
      ctx = base + scenario.summaryTokens;
      cost += ctx * wp; // the new prefix is written
      reacqLeft = scenario.requests;
    }
    if (reacqLeft > 0) {
      const t = scenario.tokens / scenario.requests;
      cost += ctx * rp + t * wp + 300 * op;
      ctx += t;
      reacqLeft--;
    }
    const newTok = prev ? Math.max(0, r.context - prev.context) : r.context;
    const cold = prev !== undefined && r.cacheWrite > COLD_WRITE_SHARE * prev.context && prev.context > COLD_MIN_CTX;
    cost += cold ? ctx * wp : Math.max(0, ctx - newTok) * rp + newTok * wp;
    cost += r.output * op + (r.input * p.inputPerM) / 1e6;
    trace?.push(ctx);
  }
  return { costUsd: cost, compactions };
}

export interface CompactionRecommendation {
  /** Recommended threshold (tokens), or null when no threshold saves money in every scenario. */
  threshold: number | null;
  observedUsd: number;
  /** Simulator at the observed policy — must sit near observedUsd for the result to be trusted. */
  calibratedUsd: number;
  /** Savings at the recommended threshold, per re-acquisition scenario (worst case first). */
  savingsUsd: { scenario: string; usd: number }[];
  sweep: { threshold: number; savingsUsd: Record<string, number>; compactions: number }[];
}

const THRESHOLDS = [150_000, 200_000, 300_000, 400_000, 500_000, 700_000];

/** Pick the compaction threshold: never loses in any measured scenario, best expected savings. */
export function recommendCompaction(runs: Run[], candidates: number[] = []): CompactionRecommendation {
  const observedUsd = runs.reduce((s, r) => s + r.costUsd, 0);
  const calibratedUsd = runs.reduce((s, r) => s + simulateCompaction(r, Infinity).costUsd, 0);
  const thresholds = [...new Set([...THRESHOLDS, ...candidates.filter((t) => t > 50_000)])].sort((a, b) => a - b);
  const sweep = thresholds.map((threshold) => {
    const savingsUsd: Record<string, number> = {};
    let compactions = 0;
    for (const sc of REACQUISITION_SCENARIOS) {
      let c = 0;
      for (const r of runs) {
        const s = simulateCompaction(r, threshold, sc);
        c += s.costUsd;
        if (sc === REACQUISITION_SCENARIOS[0]) compactions += s.compactions;
      }
      savingsUsd[sc.name] = calibratedUsd - c;
    }
    return { threshold, savingsUsd, compactions };
  });
  // Decision rule: never lose money (worst scenario > 0), then maximize EXPECTED savings
  // under the measured scenario mix — p50 is the typical fresh start, p90 the bad tail,
  // stress a 3×p90 guard. Pure maximin over-weights the stress case and lands far above
  // the economic (EOQ) point.
  const WEIGHTS: Record<string, number> = { p50: 0.5, p90: 0.35, stress: 0.15 };
  const worst = (x: (typeof sweep)[number]) => Math.min(...Object.values(x.savingsUsd));
  const expected = (x: (typeof sweep)[number]) => Object.entries(x.savingsUsd).reduce((s, [k, v]) => s + (WEIGHTS[k] ?? 0) * v, 0);
  const best = sweep.filter((x) => worst(x) > 0).sort((a, b) => expected(b) - expected(a))[0];
  return {
    threshold: best?.threshold ?? null,
    observedUsd,
    calibratedUsd,
    savingsUsd: best
      ? Object.entries(best.savingsUsd).map(([scenario, usd]) => ({ scenario, usd })).sort((a, b) => a.usd - b.usd)
      : [],
    sweep,
  };
}
