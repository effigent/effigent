/**
 * Clustering + per-cluster metrics — spec §3.4.
 *
 * Runs group by (agentId, L1). L2 families connect near-miss shapes; the
 * determinism score is (share of the family's runs on the modal L1 path) ×
 * (output consistency: exact canonical-output equality where inputs are equal,
 * template consistency otherwise).
 */

import type { Cluster, ClusterMetrics, RunGraph, VolatileSlot } from './types.js';
import { cacheReadRatio } from './cost.js';
import { clusterFamilies } from './l2.js';
import { normalizeWs } from './canonicalize.js';
import { columnTemplate } from './determinism.js';

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function outputConsistency(runs: RunGraph[]): number {
  // Exact check: runs whose canonical *inputs* match must produce equal
  // canonical outputs. Group by canonical first prompt.
  const byInput = new Map<string, RunGraph[]>();
  for (const r of runs) {
    const key = r.canonicalFirstPrompt ?? '';
    (byInput.get(key) ?? byInput.set(key, []).get(key)!).push(r);
  }
  let checked = 0;
  let consistent = 0;
  for (const group of byInput.values()) {
    if (group.length < 2) continue;
    const outputs = new Set(group.map((r) => r.canonicalFinalOutput ?? ''));
    checked += group.length;
    if (outputs.size === 1) consistent += group.length;
    else consistent += Math.max(...countBy(group.map((r) => r.canonicalFinalOutput ?? '')));
  }
  if (checked > 0) return consistent / checked;

  // Template fallback (L1-level consistency): modal share of output templates.
  const templates = runs.map((r) => r.finalOutputTemplate ?? '');
  const modal = Math.max(...countBy(templates));
  return runs.length === 0 ? 0 : modal / runs.length;
}

function countBy(values: string[]): number[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m.size === 0 ? [0] : [...m.values()];
}

function retrySubchains(run: RunGraph): number {
  // Loop motif: a tool_use repeated with the same label after an error result,
  // or immediately repeated identical tool_use labels.
  let count = 0;
  const nodes = run.nodes;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].kind !== 'tool_use') continue;
    for (let j = i + 1; j < Math.min(nodes.length, i + 4); j++) {
      if (nodes[j].kind === 'tool_use' && nodes[j].label === nodes[i].label) {
        const between = nodes.slice(i + 1, j);
        if (between.some((n) => n.isError) || between.length === 0) count += 1;
        break;
      }
    }
  }
  return count;
}

function volatileSlots(runs: RunGraph[]): VolatileSlot[] {
  if (runs.length < 2) return [];
  const len = runs[0].nodes.length;
  const slots: VolatileSlot[] = [];
  for (let i = 0; i < len; i++) {
    if (runs[0].nodes[i].kind !== 'tool_use' && runs[0].nodes[i].kind !== 'model_turn') continue;
    const values = runs.map((r) => (r.nodes[i] ? normalizeWs(r.nodes[i].raw) : null));
    // Token-level: report only the tokens that actually vary (a timestamp in
    // an otherwise-constant payload is one slot, not a whole-value mismatch).
    const t = columnTemplate(values);
    if (t && t.slots > 0) {
      const tuples = new Set<string>();
      const examples: string[] = [];
      for (const sv of t.slotValues) {
        if (!sv) continue;
        const tuple = sv.join(' · ');
        if (!tuples.has(tuple)) {
          tuples.add(tuple);
          if (examples.length < 3) examples.push(tuple.slice(0, 120));
        }
      }
      if (tuples.size > 1) {
        slots.push({
          nodeIndex: i,
          label: runs[0].nodes[i].label.slice(0, 120),
          distinctValues: tuples.size,
          examples,
        });
      }
      continue;
    }
    // Structure itself varies — fall back to whole-value counting.
    const distinct = new Set<string>();
    const examples: string[] = [];
    for (const v of values) {
      if (v === null || distinct.has(v)) continue;
      distinct.add(v);
      if (examples.length < 3) examples.push(v.slice(0, 120));
    }
    if (distinct.size > 1) {
      slots.push({
        nodeIndex: i,
        label: runs[0].nodes[i].label.slice(0, 120),
        distinctValues: distinct.size,
        examples,
      });
    }
  }
  return slots;
}

function computeMetrics(runs: RunGraph[], modalPathFraction: number): ClusterMetrics {
  const costs = runs.map((r) => r.costUsd).sort((a, b) => a - b);
  const dates = runs.map((r) => r.startedAt).filter((d): d is string => !!d).sort();

  const byL0 = new Map<string, RunGraph[]>();
  for (const r of runs) {
    (byL0.get(r.l0) ?? byL0.set(r.l0, []).get(r.l0)!).push(r);
  }
  let dupRuns = 0;
  let dupCost = 0;
  for (const group of byL0.values()) {
    if (group.length > 1) {
      dupRuns += group.length - 1;
      dupCost += group
        .slice()
        .sort((a, b) => a.costUsd - b.costUsd)
        .slice(0, -1) // everything but the most expensive one is re-payment
        .reduce((s, r) => s + r.costUsd, 0);
    }
  }

  const modelMix: Record<string, number> = {};
  for (const r of runs) {
    for (const m of r.models) modelMix[m] = (modelMix[m] ?? 0) + 1;
  }

  const failures = runs.filter((r) => r.nodes.some((n) => n.isError)).length;
  const retries = runs.reduce((s, r) => s + retrySubchains(r), 0);

  return {
    nRuns: runs.length,
    totalCostUsd: costs.reduce((s, c) => s + c, 0),
    costP50Usd: percentile(costs, 50),
    costP95Usd: percentile(costs, 95),
    firstSeen: dates[0],
    lastSeen: dates[dates.length - 1],
    // Procedure stability only. Task-mix concentration is pathShare — mixing
    // the two punished agents that legitimately run several procedures.
    determinismScore: Math.max(0, Math.min(1, outputConsistency(runs))),
    pathShare: Math.max(0, Math.min(1, modalPathFraction)),
    failureRate: runs.length === 0 ? 0 : failures / runs.length,
    retrySubchains: retries,
    modelMix,
    volatileSlots: volatileSlots(runs),
    l0DuplicateRuns: dupRuns,
    l0DuplicateCostUsd: dupCost,
    cacheReadRatio: cacheReadRatio(
      runs.flatMap((r) => Object.values(r.usageByModel)),
    ),
  };
}

/** Cluster all runs of all agents. Returns clusters sorted by total cost desc. */
export function clusterRuns(graphs: RunGraph[]): Cluster[] {
  const byAgent = new Map<string, RunGraph[]>();
  for (const g of graphs) {
    (byAgent.get(g.agentId) ?? byAgent.set(g.agentId, []).get(g.agentId)!).push(g);
  }

  const clusters: Cluster[] = [];
  for (const [agentId, runs] of byAgent) {
    const byL1 = new Map<string, RunGraph[]>();
    for (const r of runs) {
      (byL1.get(r.l1) ?? byL1.set(r.l1, []).get(r.l1)!).push(r);
    }

    // L2 families over this agent's distinct shapes.
    const shapes = [...byL1.entries()].map(([l1, rs]) => ({
      l1,
      labelSequence: rs[0].labelSequence,
    }));
    const familyOf = clusterFamilies(shapes);

    // Family stats to compute modal-path fraction.
    const familyRunCounts = new Map<string, number>();
    const familyModalRuns = new Map<string, number>();
    for (const [l1, rs] of byL1) {
      const fam = familyOf.get(l1)!;
      familyRunCounts.set(fam, (familyRunCounts.get(fam) ?? 0) + rs.length);
      familyModalRuns.set(fam, Math.max(familyModalRuns.get(fam) ?? 0, rs.length));
    }

    for (const [l1, rs] of byL1) {
      const fam = familyOf.get(l1)!;
      const modalPathFraction =
        (familyModalRuns.get(fam) ?? rs.length) / (familyRunCounts.get(fam) ?? rs.length);
      clusters.push({
        clusterId: `cl_${agentId.replace(/[^\w-]/g, '_')}_${l1.slice(0, 12)}`,
        agentId,
        l1,
        familyId: fam,
        labelSequence: rs[0].labelSequence,
        runIds: rs.map((r) => r.runId),
        runs: rs,
        metrics: computeMetrics(rs, modalPathFraction),
      });
    }
  }

  return clusters.sort((a, b) => b.metrics.totalCostUsd - a.metrics.totalCostUsd);
}
