// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * Model routing — validate that a cheaper model in the SAME provider family can
 * stand in for a step the agent runs on a bigger model, WITHOUT breaking it.
 *
 * The determinism lattice already flags routable steps (D4, `action: 'route'`).
 * This module answers the operational question: *which* smaller model, and is it
 * safe? Strategy (per the product spec):
 *   - stay inside the original model's vendor family (never cross Anthropic ↔
 *     OpenAI ↔ Google — behaviour/format differ too much);
 *   - try the SMALLEST (cheapest) candidate first, and escalate UP a tier after
 *     it fails its retries — stop at the first that reproduces the step;
 *   - a candidate must reproduce the recorded output on ≥`minSamples` runs at
 *     ≥`threshold` pass-rate to be `validated` (otherwise `unfit`).
 *
 * The actual model call is injected (`callModel`) so this is testable offline
 * and is a drop-in for a live OpenRouter client server-side.
 */

export type ModelFamily = 'anthropic' | 'openai' | 'google';

export interface ModelTier {
  /** Human tier key within the family. */
  key: string;
  /** Matches the tier inside an original model string. */
  match: RegExp;
  /** OpenRouter model id to call. NOTE: verify against OpenRouter's live model
   *  list before enabling — ids drift as vendors release versions. */
  openrouter: string;
}

/** Tiers are ordered LARGEST → smallest. Candidates are drawn from tiers below
 *  the original and tested smallest-first. */
export const MODEL_FAMILIES: Record<ModelFamily, { match: RegExp; tiers: ModelTier[] }> = {
  anthropic: {
    match: /claude|anthropic|opus|sonnet|haiku/i,
    tiers: [
      { key: 'opus', match: /opus/i, openrouter: 'anthropic/claude-opus-4.8' },
      { key: 'sonnet', match: /sonnet/i, openrouter: 'anthropic/claude-sonnet-5' },
      { key: 'haiku', match: /haiku/i, openrouter: 'anthropic/claude-haiku-4.5' },
    ],
  },
  openai: {
    match: /openai|gpt|(^|[^a-z])o[0-9]/i,
    tiers: [
      { key: 'large', match: /gpt-5(?:\.\d)?(?!-?(mini|nano))|gpt-4o(?!-?mini)|gpt-4\.1(?!-?(mini|nano))/i, openrouter: 'openai/gpt-5.4' },
      { key: 'mini', match: /mini/i, openrouter: 'openai/gpt-5.4-mini' },
      { key: 'nano', match: /nano/i, openrouter: 'openai/gpt-5.4-nano' },
    ],
  },
  google: {
    match: /google|gemini/i,
    tiers: [
      { key: 'pro', match: /pro/i, openrouter: 'google/gemini-2.5-pro' },
      { key: 'flash', match: /flash(?!-?lite)/i, openrouter: 'google/gemini-2.5-flash' },
      { key: 'flash-lite', match: /flash-?lite/i, openrouter: 'google/gemini-2.5-flash-lite' },
    ],
  },
};

/** Which family + tier an original model string belongs to. */
export function detectModel(model: string): { family: ModelFamily; tierIndex: number } | null {
  const m = model ?? '';
  for (const [family, def] of Object.entries(MODEL_FAMILIES) as [ModelFamily, (typeof MODEL_FAMILIES)[ModelFamily]][]) {
    if (!def.match.test(m)) continue;
    const idx = def.tiers.findIndex((t) => t.match.test(m));
    // Family matched but no explicit tier → assume the top tier (safest: only
    // route down from a known-large model).
    return { family, tierIndex: idx >= 0 ? idx : 0 };
  }
  return null;
}

/** Smaller-than-original candidates in the same family, ordered SMALLEST-first
 *  (cheapest first — the test order). */
export function smallerCandidates(model: string): ModelTier[] {
  const det = detectModel(model);
  if (!det) return [];
  const tiers = MODEL_FAMILIES[det.family].tiers;
  return tiers.slice(det.tierIndex + 1).reverse();
}

/** Tolerant output-equivalence: normalized token overlap (Jaccard). Reasoning
 *  text won't match verbatim, so exact-equality is too strict; this rewards
 *  reproducing the same content. */
export function outputSimilarity(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      (s ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .split(/[^a-z0-9_./:-]+/)
        .filter((t) => t.length > 0),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface RouteSample {
  /** The reconstructed input/context that produced the step. */
  input: string;
  /** The output the ORIGINAL (big) model actually produced. */
  expectedOutput: string;
  runId?: string;
}

export interface CandidateAttempt {
  tier: string;
  model: string;
  samplesTried: number;
  passed: number;
  passRate: number;
}

export interface RoutingReport {
  originalModel: string;
  family: ModelFamily | null;
  /** validated: a cheaper model reproduces the step · unfit: none did ·
   *  no-candidate: already the smallest tier · unknown-model: family unknown. */
  status: 'validated' | 'unfit' | 'no-candidate' | 'unknown-model';
  chosen?: { tier: string; model: string; passRate: number };
  /** Per-tier log, smallest-first — drives the dashboard indicator. */
  attempts: CandidateAttempt[];
}

export interface RoutingOptions {
  /** Live model call (OpenRouter server-side); injected for testability. */
  callModel: (openrouterModel: string, input: string) => Promise<string>;
  /** Samples to score per candidate. */
  minSamples?: number;
  /** Per-sample retries before the sample counts as a miss ("go up after some retries"). */
  retries?: number;
  /** Candidate pass-rate needed to validate (0–1). */
  threshold?: number;
  /** Per-sample output-similarity needed to count as a reproduction (0–1). */
  matchThreshold?: number;
}

/**
 * Try smaller same-family models cheapest-first, escalating up, and return the
 * first that reproduces the step across the sample runs.
 */
export async function evaluateRouting(
  originalModel: string,
  samples: RouteSample[],
  opts: RoutingOptions,
): Promise<RoutingReport> {
  const minSamples = opts.minSamples ?? 5;
  const retries = opts.retries ?? 2;
  const threshold = opts.threshold ?? 0.9;
  const matchThreshold = opts.matchThreshold ?? 0.8;

  const det = detectModel(originalModel);
  if (!det) return { originalModel, family: null, status: 'unknown-model', attempts: [] };
  const candidates = smallerCandidates(originalModel);
  if (candidates.length === 0) {
    return { originalModel, family: det.family, status: 'no-candidate', attempts: [] };
  }

  const use = samples.slice(0, Math.max(minSamples, 0) || samples.length);
  const attempts: CandidateAttempt[] = [];

  for (const cand of candidates) {
    let passed = 0;
    let tried = 0;
    for (const s of use) {
      tried++;
      let ok = false;
      for (let r = 0; r <= retries && !ok; r++) {
        let out: string;
        try {
          out = await opts.callModel(cand.openrouter, s.input);
        } catch {
          continue; // transient — retry
        }
        if (outputSimilarity(out, s.expectedOutput) >= matchThreshold) ok = true;
      }
      if (ok) passed++;
    }
    const passRate = tried ? Math.round((passed / tried) * 100) / 100 : 0;
    attempts.push({ tier: cand.key, model: cand.openrouter, samplesTried: tried, passed, passRate });
    if (tried > 0 && passRate >= threshold) {
      return {
        originalModel,
        family: det.family,
        status: 'validated',
        chosen: { tier: cand.key, model: cand.openrouter, passRate },
        attempts,
      };
    }
    // else escalate to the next-larger candidate
  }

  return { originalModel, family: det.family, status: 'unfit', attempts };
}
