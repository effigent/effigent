/**
 * Cluster signals → dollar-ranked findings — spec §3.5.
 * Report = top 5 by est_monthly_saving × confidence ÷ effort.
 */

import type { Cluster, Finding, RunGraph } from './types.js';
import { pricingFor } from './cost.js';
import type { MinedSegment } from './segments.js';

const MAX_FINDINGS = 5;

export interface FindingsOptions {
  /** Observation window in days (for monthly extrapolation). */
  windowDays: number;
  maxFindings?: number;
}

function monthly(costUsd: number, windowDays: number): number {
  return costUsd * (30 / Math.max(1, windowDays));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function shortShape(seq: string[], max = 8): string[] {
  if (seq.length <= max) return seq;
  return [...seq.slice(0, max - 1), `… +${seq.length - (max - 1)} more steps`];
}

function compileFindings(clusters: Cluster[], windowDays: number): Finding[] {
  return clusters
    .filter((c) => c.metrics.determinismScore >= 0.9 && c.metrics.nRuns >= 10)
    .map((c) => {
      const saving = monthly(c.metrics.totalCostUsd, windowDays) * 0.8;
      return {
        kind: 'compile' as const,
        title: `Compile it: "${describeCluster(c)}" ran ${c.metrics.nRuns}× as the same procedure`,
        agentId: c.agentId,
        clusterIds: [c.clusterId],
        estMonthlySavingUsd: round(saving),
        confidence: round(c.metrics.determinismScore),
        effort: 3,
        score: 0,
        recommendation:
          `This shape is ${(c.metrics.determinismScore * 100).toFixed(0)}% deterministic over ` +
          `${c.metrics.nRuns} runs. Generate a script/skill with ${c.metrics.volatileSlots.length} ` +
          `parameter slot(s) (${c.metrics.volatileSlots
            .slice(0, 3)
            .map((s) => s.label.split(' ')[0])
            .join(', ')}) and replace the agent loop for this procedure. ` +
          `Estimated saving = 80% of the cluster's cost.`,
        evidenceRunIds: c.runIds.slice(0, 10),
        labelSequence: shortShape(c.labelSequence),
        details: {
          determinism: c.metrics.determinismScore,
          nRuns: c.metrics.nRuns,
          volatileSlots: c.metrics.volatileSlots.slice(0, 8),
          clusterMonthlyCostUsd: round(monthly(c.metrics.totalCostUsd, windowDays)),
        },
      };
    });
}

function cacheFindings(clusters: Cluster[], windowDays: number): Finding[] {
  return clusters
    .filter((c) => c.metrics.l0DuplicateRuns >= 5)
    .map((c) => ({
      kind: 'cache' as const,
      title: `Cache it: ${c.metrics.l0DuplicateRuns} literally identical re-runs of "${describeCluster(c)}"`,
      agentId: c.agentId,
      clusterIds: [c.clusterId],
      estMonthlySavingUsd: round(monthly(c.metrics.l0DuplicateCostUsd, windowDays)),
      confidence: 0.95,
      effort: 1,
      score: 0,
      recommendation:
        `${c.metrics.l0DuplicateRuns} runs had identical canonical inputs AND identical canonical ` +
        `graphs (equal L0). Cache the result keyed on the canonical input and skip re-execution.`,
      evidenceRunIds: c.runIds.slice(0, 10),
      labelSequence: shortShape(c.labelSequence),
      details: { duplicateRuns: c.metrics.l0DuplicateRuns, duplicateCostUsd: round(c.metrics.l0DuplicateCostUsd) },
    }));
}

function primaryModel(r: RunGraph): string | undefined {
  return r.models[0];
}

function rightsizeFindings(clusters: Cluster[], windowDays: number): Finding[] {
  const findings: Finding[] = [];
  for (const c of clusters) {
    const models = Object.keys(c.metrics.modelMix);
    if (models.length < 2) continue;
    const byModel = new Map<string, RunGraph[]>();
    for (const r of c.runs) {
      const m = primaryModel(r);
      if (!m) continue;
      (byModel.get(m) ?? byModel.set(m, []).get(m)!).push(r);
    }
    if (byModel.size < 2) continue;
    const ranked = [...byModel.entries()].sort(
      (a, b) => pricingFor(b[0]).outputPerM - pricingFor(a[0]).outputPerM,
    );
    const [bigModel, bigRuns] = ranked[0];
    const [cheapModel, cheapRuns] = ranked[ranked.length - 1];
    if (bigModel === cheapModel || cheapRuns.length < 2 || bigRuns.length < 2) continue;

    // Measured evidence: do the cheap model's output templates match the big model's modal template?
    const bigTemplates = bigRuns.map((r) => r.finalOutputTemplate ?? '');
    const modalBig = mode(bigTemplates);
    const matchRate =
      cheapRuns.filter((r) => (r.finalOutputTemplate ?? '') === modalBig).length / cheapRuns.length;
    if (matchRate < 0.6) continue;

    const avgBig = bigRuns.reduce((s, r) => s + r.costUsd, 0) / bigRuns.length;
    const avgCheap = cheapRuns.reduce((s, r) => s + r.costUsd, 0) / cheapRuns.length;
    if (avgBig <= avgCheap) continue;
    const saving = monthly((avgBig - avgCheap) * bigRuns.length, windowDays);

    findings.push({
      kind: 'rightsize',
      title: `Right-size it: "${describeCluster(c)}" already succeeds on ${shortModel(cheapModel)}`,
      agentId: c.agentId,
      clusterIds: [c.clusterId],
      estMonthlySavingUsd: round(saving),
      confidence: round(0.5 + 0.4 * matchRate),
      effort: 1,
      score: 0,
      recommendation:
        `You already ran this shape on both ${shortModel(bigModel)} (${bigRuns.length} runs, ` +
        `$${avgBig.toFixed(2)}/run) and ${shortModel(cheapModel)} (${cheapRuns.length} runs, ` +
        `$${avgCheap.toFixed(2)}/run) — a natural experiment. The cheap model's outputs are ` +
        `template-consistent with the big model's in ${(matchRate * 100).toFixed(0)}% of runs. ` +
        `Pin this procedure to ${shortModel(cheapModel)}.`,
      evidenceRunIds: [...bigRuns.slice(0, 5), ...cheapRuns.slice(0, 5)].map((r) => r.runId),
      labelSequence: shortShape(c.labelSequence),
      details: { bigModel, cheapModel, avgBigUsd: round(avgBig), avgCheapUsd: round(avgCheap), matchRate: round(matchRate) },
    });
  }
  return findings;
}

function fixFindings(clusters: Cluster[], windowDays: number): Finding[] {
  return clusters
    .filter((c) => c.metrics.retrySubchains >= 3 || (c.metrics.failureRate >= 0.3 && c.metrics.nRuns >= 5))
    .map((c) => {
      // Waste ≈ the retry share of the cluster's spend (non-final attempts).
      const retryShare = Math.min(
        0.6,
        (c.metrics.retrySubchains / Math.max(1, c.metrics.nRuns)) * 0.25 + c.metrics.failureRate * 0.3,
      );
      return {
        kind: 'fix' as const,
        title: `Fix it: failure/retry motifs inside "${describeCluster(c)}"`,
        agentId: c.agentId,
        clusterIds: [c.clusterId],
        estMonthlySavingUsd: round(monthly(c.metrics.totalCostUsd, windowDays) * retryShare),
        confidence: 0.6,
        effort: 2,
        score: 0,
        recommendation:
          `${c.metrics.retrySubchains} retry sub-chains and a ${(c.metrics.failureRate * 100).toFixed(0)}% ` +
          `failure rate inside this shape. Root-cause the failing step and add a guard; ` +
          `non-final attempts are pure re-payment.`,
        evidenceRunIds: c.runIds.slice(0, 10),
        labelSequence: shortShape(c.labelSequence),
        details: { retrySubchains: c.metrics.retrySubchains, failureRate: round(c.metrics.failureRate) },
      };
    });
}

function precomputeFindings(clusters: Cluster[], windowDays: number): Finding[] {
  // Shared shape prefix across ≥2 clusters of the same agent = exploration tax.
  const findings: Finding[] = [];
  const byAgent = new Map<string, Cluster[]>();
  for (const c of clusters) {
    (byAgent.get(c.agentId) ?? byAgent.set(c.agentId, []).get(c.agentId)!).push(c);
  }
  for (const [agentId, agentClusters] of byAgent) {
    const eligible = agentClusters.filter((c) => c.metrics.nRuns >= 2);
    if (eligible.length < 2) continue;
    // Longest common prefix across the two most expensive clusters sharing ≥4 steps.
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i].labelSequence;
        const b = eligible[j].labelSequence;
        let k = 0;
        while (k < a.length && k < b.length && a[k] === b[k]) k++;
        if (k < 4) continue;
        const prefixFrac = (k / a.length + k / b.length) / 2;
        const combined = eligible[i].metrics.totalCostUsd + eligible[j].metrics.totalCostUsd;
        findings.push({
          kind: 'precompute',
          title: `Precompute it: ${k}-step shared exploration prelude across 2 procedures`,
          agentId,
          clusterIds: [eligible[i].clusterId, eligible[j].clusterId],
          estMonthlySavingUsd: round(monthly(combined, windowDays) * prefixFrac * 0.6),
          confidence: 0.5,
          effort: 2,
          score: 0,
          recommendation:
            `Two distinct procedures start with the same ${k} steps (shared context discovery). ` +
            `Precompute that context once (e.g. a CLAUDE.md addition or a cached context artifact) ` +
            `and kill the exploration tax on every run.`,
          evidenceRunIds: [...eligible[i].runIds.slice(0, 5), ...eligible[j].runIds.slice(0, 5)],
          labelSequence: shortShape(a.slice(0, k)),
          details: { sharedPrefixSteps: k, prefixFraction: round(prefixFrac) },
        });
        break; // one precompute finding per anchor cluster is enough for top-5
      }
    }
  }
  return findings;
}

function alignFindings(clusters: Cluster[], windowDays: number): Finding[] {
  if (clusters.length === 0) return [];
  const byAgent = new Map<string, Cluster[]>();
  for (const c of clusters) {
    (byAgent.get(c.agentId) ?? byAgent.set(c.agentId, []).get(c.agentId)!).push(c);
  }
  const findings: Finding[] = [];
  for (const [agentId, agentClusters] of byAgent) {
    const totalRuns = agentClusters.reduce((s, c) => s + c.metrics.nRuns, 0);
    if (totalRuns < 10) continue;
    const totalCost = agentClusters.reduce((s, c) => s + c.metrics.totalCostUsd, 0);
    const weighted =
      agentClusters.reduce((s, c) => s + c.metrics.cacheReadRatio * c.metrics.totalCostUsd, 0) /
      Math.max(1e-9, totalCost);
    if (weighted >= 0.5) continue;
    findings.push({
      kind: 'align',
      title: `Align it: prompt-cache read ratio is only ${(weighted * 100).toFixed(0)}% for ${agentId}`,
      agentId,
      clusterIds: agentClusters.slice(0, 5).map((c) => c.clusterId),
      estMonthlySavingUsd: round(monthly(totalCost, windowDays) * (0.5 - weighted) * 0.6),
      confidence: 0.4,
      effort: 2,
      score: 0,
      recommendation:
        `Across all of ${agentId}'s clusters, only ${(weighted * 100).toFixed(0)}% of input tokens hit ` +
        `the prompt cache (healthy agents exceed 50%). Stabilize the prompt prefix (system prompt, ` +
        `CLAUDE.md, tool definitions) so it stops churning between turns; cached reads cost 10% of fresh input.`,
      evidenceRunIds: agentClusters[0]?.runIds.slice(0, 5) ?? [],
      labelSequence: [],
      details: { cacheReadRatio: round(weighted), totalRuns },
    });
  }
  return findings;
}

function describeCluster(c: Cluster): string {
  const firstTool = c.labelSequence.find((l) => l.startsWith('tool:'));
  const prompt = c.runs[0]?.firstPrompt;
  if (prompt) return prompt.slice(0, 60).replace(/\s+/g, ' ');
  if (firstTool) return firstTool.slice(0, 60);
  return c.clusterId;
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function mode(values: string[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  let best = '';
  let bestN = -1;
  for (const [v, n] of m) if (n > bestN) ((best = v), (bestN = n));
  return best;
}

/**
 * Segment-level findings — the fine-grained compile/route units. A segment that
 * repeats across otherwise-different runs, is deterministic, and is mostly
 * mechanical is the safest money in the report:
 *   determinism ≥ 0.9 + mechanicalRatio ≥ 0.6 → compile to a script (no LLM);
 *   determinism ≥ 0.7 + mostly mechanical    → route the segment to a small model.
 */
export function mapSegmentFindings(segments: MinedSegment[], windowDays: number): Finding[] {
  const findings: Finding[] = [];
  for (const seg of segments) {
    if (seg.support < 3) continue;
    const monthlyCost = monthly(seg.totalCostUsd, windowDays);
    if (seg.determinism >= 0.9 && seg.mechanicalRatio >= 0.6) {
      findings.push({
        kind: 'compile',
        title: `Compile segment: ${seg.length} steps repeated in ${seg.support}/${seg.runsTotal} runs (${(seg.mechanicalRatio * 100).toFixed(0)}% mechanical)`,
        agentId: '*',
        clusterIds: [],
        estMonthlySavingUsd: round(monthlyCost * 0.85),
        confidence: round(Math.min(0.95, seg.determinism * (0.6 + 0.4 * (seg.support / seg.runsTotal)))),
        effort: 2,
        score: 0,
        recommendation:
          `This ${seg.length}-step segment recurs in ${seg.support} of ${seg.runsTotal} runs ` +
          `(${seg.occurrences} occurrences, ~$${seg.avgCostPerOccurrenceUsd}/occurrence) and is ` +
          `${(seg.determinism * 100).toFixed(0)}% deterministic. ${(seg.mechanicalRatio * 100).toFixed(0)}% of its steps ` +
          `are mechanical/cacheable — replace the segment with a plain script (a "meta-tool") and skip the LLM for it entirely.`,
        evidenceRunIds: seg.examples.map((e) => e.runId),
        labelSequence: seg.labels,
        details: { segment: { ...seg, classes: seg.classes } },
      });
    } else if (seg.determinism >= 0.7 && seg.mechanicalRatio >= 0.5) {
      findings.push({
        kind: 'rightsize',
        title: `Route segment to a smaller model: ${seg.length} steps, ${seg.support}/${seg.runsTotal} runs`,
        agentId: '*',
        clusterIds: [],
        estMonthlySavingUsd: round(monthlyCost * 0.6),
        confidence: round(0.4 + 0.4 * seg.determinism),
        effort: 2,
        score: 0,
        recommendation:
          `This recurring segment is ${(seg.determinism * 100).toFixed(0)}% deterministic and mostly ` +
          `mechanical — not safe to fully script yet, but safe to route to a much smaller model ` +
          `(the decisions inside it are predictable) while the surrounding reasoning stays on the capable model.`,
        evidenceRunIds: seg.examples.map((e) => e.runId),
        labelSequence: seg.labels,
        details: { segment: { ...seg, classes: seg.classes } },
      });
    }
  }
  for (const f of findings) f.score = (f.estMonthlySavingUsd * f.confidence) / f.effort;
  return findings;
}

/** All finding rules, ranked, top-N. */
export function mapFindings(clusters: Cluster[], options: FindingsOptions): Finding[] {
  const { windowDays } = options;
  const all = [
    ...compileFindings(clusters, windowDays),
    ...cacheFindings(clusters, windowDays),
    ...rightsizeFindings(clusters, windowDays),
    ...fixFindings(clusters, windowDays),
    ...precomputeFindings(clusters, windowDays),
    ...alignFindings(clusters, windowDays),
  ];
  for (const f of all) {
    f.score = (f.estMonthlySavingUsd * f.confidence) / f.effort;
  }
  return all
    .filter((f) => f.estMonthlySavingUsd >= 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxFindings ?? MAX_FINDINGS);
}
