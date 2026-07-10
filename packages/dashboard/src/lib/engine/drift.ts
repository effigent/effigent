// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * Agent drift detection — "has this agent CHANGED?"
 *
 * An agent's code/prompt changing shows up as its runs' DAGs moving away from
 * where they used to live in embedding space. This matters to the optimizer
 * beyond monitoring: synthesized tools and routing decisions were VALIDATED
 * against the old behavior — on drift they must be re-shadowed, not trusted.
 *
 * Method (deliberately simple and explainable):
 *   1. order the window's runs by time; split into BASELINE (older) and
 *      PROBE (newest k runs);
 *   2. embed every run (embed.ts), take the baseline centroid, and measure
 *      each baseline run's cosine distance to it → μ, σ (the agent's normal
 *      spread — a multi-procedure agent gets a wide σ and is judged fairly);
 *   3. the probe's mean distance is standardized: z = (probeMean − μ) / σ.
 *      changed ⇔ z ≥ zThreshold AND the absolute shift ≥ minAbsDelta (the σ
 *      floor keeps ultra-homogeneous baselines from hair-triggering).
 * `changedAt` is the first probe run that individually crosses the threshold.
 */

import type { RunGraph } from './types.ts';
import { centroid, cosineSim, embedRunGraph } from './embed.ts';

export interface DriftOptions {
  /** Minimum baseline size to judge at all. */
  minBaseline?: number;
  /** Newest runs treated as the probe window. */
  probe?: number;
  zThreshold?: number;
  /** Required absolute distance shift (guards the σ floor). */
  minAbsDelta?: number;
}

export interface DriftReport {
  agentId: string;
  runs: number;
  baselineRuns: number;
  probeRuns: number;
  baselineMeanDist: number;
  baselineStdDist: number;
  probeMeanDist: number;
  /** Standardized shift of the probe window vs the baseline spread. */
  z: number;
  changed: boolean;
  /** First probe run that individually crossed the threshold. */
  changedAt?: string;
  changedRunId?: string;
  probeRunIds: string[];
}

const SIGMA_FLOOR = 0.01;

export function detectDrift(graphs: RunGraph[], opts: DriftOptions = {}): DriftReport | null {
  const minBaseline = opts.minBaseline ?? 5;
  const probeSize = opts.probe ?? 5;
  const zThreshold = opts.zThreshold ?? 3;
  const minAbsDelta = opts.minAbsDelta ?? 0.05;

  const ordered = [...graphs].sort(
    (a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.runId.localeCompare(b.runId),
  );
  const n = ordered.length;
  const probeRuns = Math.min(probeSize, Math.floor(n / 3));
  const baselineRuns = n - probeRuns;
  if (probeRuns < 1 || baselineRuns < minBaseline) return null;

  const embeds = ordered.map(embedRunGraph);
  const base = embeds.slice(0, baselineRuns);
  const c = centroid(base);
  const dist = (v: number[]) => 1 - cosineSim(v, c);

  const baseDists = base.map(dist);
  const mean = baseDists.reduce((s, d) => s + d, 0) / baseDists.length;
  const variance = baseDists.reduce((s, d) => s + (d - mean) ** 2, 0) / baseDists.length;
  const std = Math.max(Math.sqrt(variance), SIGMA_FLOOR);

  const probe = ordered.slice(baselineRuns);
  const probeDists = embeds.slice(baselineRuns).map(dist);
  const probeMean = probeDists.reduce((s, d) => s + d, 0) / probeDists.length;

  const z = (probeMean - mean) / std;
  const changed = z >= zThreshold && probeMean - mean >= minAbsDelta;

  let changedAt: string | undefined;
  let changedRunId: string | undefined;
  if (changed) {
    for (let i = 0; i < probeDists.length; i++) {
      if (probeDists[i] >= mean + zThreshold * std && probeDists[i] - mean >= minAbsDelta) {
        changedAt = probe[i].startedAt;
        changedRunId = probe[i].runId;
        break;
      }
    }
  }

  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    agentId: ordered[0].agentId,
    runs: n,
    baselineRuns,
    probeRuns,
    baselineMeanDist: round(mean),
    baselineStdDist: round(std),
    probeMeanDist: round(probeMean),
    z: round(z),
    changed,
    changedAt,
    changedRunId,
    probeRunIds: probe.map((g) => g.runId),
  };
}
