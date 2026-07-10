// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
import type { TokenUsage } from './types.ts';

/**
 * USD per million tokens. Cache write priced at 1.25× input, cache read at 0.1× input
 * (Anthropic's standard multipliers). Unknown models fall back to the sonnet tier so
 * cost is never silently zero.
 */
interface Pricing {
  inputPerM: number;
  outputPerM: number;
}

const PRICING_TABLE: Array<{ match: RegExp; pricing: Pricing }> = [
  { match: /fable/i, pricing: { inputPerM: 25, outputPerM: 125 } },
  { match: /opus/i, pricing: { inputPerM: 15, outputPerM: 75 } },
  { match: /sonnet/i, pricing: { inputPerM: 3, outputPerM: 15 } },
  { match: /haiku/i, pricing: { inputPerM: 0.8, outputPerM: 4 } },
  { match: /gpt-4o-mini/i, pricing: { inputPerM: 0.15, outputPerM: 0.6 } },
  { match: /gpt-4o/i, pricing: { inputPerM: 2.5, outputPerM: 10 } },
];

const FALLBACK: Pricing = { inputPerM: 3, outputPerM: 15 };

export function pricingFor(model: string): Pricing {
  for (const { match, pricing } of PRICING_TABLE) {
    if (match.test(model)) return pricing;
  }
  return FALLBACK;
}

export function usageCostUsd(model: string, usage: TokenUsage): number {
  const p = pricingFor(model);
  return (
    (usage.inputTokens * p.inputPerM +
      usage.cacheCreationInputTokens * p.inputPerM * 1.25 +
      usage.cacheReadInputTokens * p.inputPerM * 0.1 +
      usage.outputTokens * p.outputPerM) /
    1_000_000
  );
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
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
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
