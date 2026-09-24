// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
import type { TokenUsage } from './types.ts';

/**
 * USD per million tokens, per model family.
 *
 * Cache writes: 1.25× input for the 5-minute TTL, 2× for the 1-hour TTL
 * (Anthropic's multipliers; the split comes from `usage.cache_creation` — see
 * `cacheCreation1hInputTokens`). Cache reads: `cacheReadMult` × input, 0.1× on
 * most models, 0.025× on Fable 5.1.
 *
 * VERIFIED 2026-09 against Claude Code's own `cost-state` totals on 289 real
 * sessions: opus-5 / opus-4-8 / fable-5 / fable-5-1 reproduce to within 1–3%.
 * The previous table priced every Opus at the Opus-4.1 rate ($15/$75) and all
 * cache writes at the 5-minute multiplier, which overstated real spend 2.25×.
 *
 * Order matters: the first match wins, so specific ids precede their family.
 * Unknown models fall back to the sonnet tier so cost is never silently zero.
 */
export interface Pricing {
  inputPerM: number;
  outputPerM: number;
  /** Cache-read price as a multiple of input (default 0.1). */
  cacheReadMult?: number;
}

const PRICING_TABLE: Array<{ match: RegExp; pricing: Pricing }> = [
  { match: /fable-5-1|mythos-5-1/i, pricing: { inputPerM: 10, outputPerM: 50, cacheReadMult: 0.025 } },
  { match: /fable|mythos/i, pricing: { inputPerM: 10, outputPerM: 50 } },
  { match: /opus-5-5/i, pricing: { inputPerM: 4, outputPerM: 20, cacheReadMult: 0.05 } },
  // Opus 4.5 onward (4-5 … 4-8, 5): $5/$25. Opus 4 / 4.1 and Claude 3 Opus: $15/$75.
  { match: /opus-(5|4-[5-9])|opus-4\.[5-9]/i, pricing: { inputPerM: 5, outputPerM: 25 } },
  { match: /opus/i, pricing: { inputPerM: 15, outputPerM: 75 } },
  { match: /sonnet-5/i, pricing: { inputPerM: 2, outputPerM: 10 } },
  { match: /sonnet/i, pricing: { inputPerM: 3, outputPerM: 15 } },
  { match: /haiku-(4|5)/i, pricing: { inputPerM: 1, outputPerM: 5 } },
  { match: /haiku/i, pricing: { inputPerM: 0.8, outputPerM: 4 } },
  { match: /gpt-5.*(mini)/i, pricing: { inputPerM: 0.25, outputPerM: 2 } },
  { match: /gpt-5/i, pricing: { inputPerM: 1.25, outputPerM: 10 } },
  { match: /gpt-4o-mini/i, pricing: { inputPerM: 0.15, outputPerM: 0.6, cacheReadMult: 0.5 } },
  { match: /gpt-4o/i, pricing: { inputPerM: 2.5, outputPerM: 10, cacheReadMult: 0.5 } },
];

const FALLBACK: Pricing = { inputPerM: 3, outputPerM: 15 };

const WRITE_5M = 1.25;
const WRITE_1H = 2;

export function pricingFor(model: string): Pricing {
  for (const { match, pricing } of PRICING_TABLE) {
    if (match.test(model)) return pricing;
  }
  return FALLBACK;
}

/** Cost of the INPUT side only (uncached + cache writes + cache reads). */
export function inputSideCostUsd(model: string, usage: Omit<TokenUsage, 'outputTokens'>): number {
  const p = pricingFor(model);
  const write1h = Math.min(usage.cacheCreation1hInputTokens ?? 0, usage.cacheCreationInputTokens);
  const write5m = usage.cacheCreationInputTokens - write1h;
  return (
    (usage.inputTokens +
      write5m * WRITE_5M +
      write1h * WRITE_1H +
      usage.cacheReadInputTokens * (p.cacheReadMult ?? 0.1)) *
    p.inputPerM /
    1_000_000
  );
}

export function usageCostUsd(model: string, usage: TokenUsage): number {
  return inputSideCostUsd(model, usage) + (usage.outputTokens * pricingFor(model).outputPerM) / 1_000_000;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
  const h = (a.cacheCreation1hInputTokens ?? 0) + (b.cacheCreation1hInputTokens ?? 0);
  if (h > 0) out.cacheCreation1hInputTokens = h;
  return out;
}

/** Ratio of cache-read tokens to all input-side tokens — the "Align it" signal. */
export function cacheReadRatio(usages: TokenUsage[]): number {
  let read = 0;
  let allInput = 0;
  for (const u of usages) {
    read += u.cacheReadInputTokens;
    allInput += u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
  }
  return allInput === 0 ? 0 : read / allInput;
}

/**
 * Re-price a stored run from its own `usageByModel` with the current table —
 * independent of whatever `costUsd` was written at ingest (rows written before
 * 2026-09 carry the 2.3×-high price). Blobs from the OLD transcript parser have
 * no 5m/1h split: those writes are priced as 1h (99% of measured Claude Code
 * writes). New-parser runs stamp `tokens.context` on every request and omit the
 * 1h field only when it is zero; OTel runs (no cwd) never had the split.
 * Returns 0 when the run carries no usage (callers keep their stored value).
 */
export function runCostUsd(run: {
  usageByModel?: Record<string, TokenUsage>;
  cwd?: string;
  steps?: { tokens?: { context?: number } }[];
}): number {
  const oldTranscript = !!run.cwd && !(run.steps ?? []).some((s) => s.tokens?.context != null);
  let cost = 0;
  for (const [model, u] of Object.entries(run.usageByModel ?? {})) {
    if (model === '<synthetic>') continue;
    cost += usageCostUsd(model, {
      ...u,
      cacheCreation1hInputTokens: u.cacheCreation1hInputTokens ?? (oldTranscript ? u.cacheCreationInputTokens : 0),
    });
  }
  return cost;
}
