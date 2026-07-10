/**
 * Segment mining — find repeated sub-sequences ("meta-tool" candidates) across
 * runs even when whole runs never match. This is the fine-grained determinism
 * layer: a run that is 80% unique can still contain a 9-step prelude repeated
 * in every run — that segment, not the whole run, is the compile/route unit.
 *
 * Approach (profile-guided, à la agentic-workflow-optimization literature):
 *   1. attribute each run's cost to its steps (∝ payload size; generative
 *      steps carry the output-token weight),
 *   2. mine frequent label n-grams (length ≥ MIN_LEN) across runs,
 *   3. keep maximal segments (drop sub-segments with no extra support),
 *   4. score each by support × cost, measure segment-level determinism
 *      (canonical I/O equality across occurrences) and mechanical ratio
 *      (taxonomy: how much of it needs no intelligence at all).
 */

import { createHash } from 'node:crypto';
import type { RunGraph } from './types.js';
import { classifyNode, type StepClass } from './taxonomy.js';

const MIN_LEN = 3;
const MAX_LEN = 12;
const MAX_SEGMENTS = 12;

/** Approximate per-step USD attribution: run cost split ∝ step weight. */
export function attributeStepCosts(graph: RunGraph): number[] {
  const weights = graph.nodes.map((n) => {
    const size = Math.max(50, n.raw.length);
    // generative steps carry output tokens (priced ~5x input) — weight them up
    return n.kind === 'model_turn' || n.kind === 'thinking' ? size * 4 : size;
  });
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  return weights.map((w) => (graph.costUsd * w) / total);
}

export interface MinedSegment {
  /** Stable id: hash of the label n-gram. */
  segmentId: string;
  labels: string[];
  length: number;
  /** Runs containing the segment at least once / total runs. */
  support: number;
  runsTotal: number;
  occurrences: number;
  avgCostPerOccurrenceUsd: number;
  totalCostUsd: number;
  /** Canonical-I/O equality across occurrences: 1 = literally identical every time. */
  determinism: number;
  /** Share of the segment's steps that need no intelligence (mechanical+cacheable). */
  mechanicalRatio: number;
  classes: StepClass[];
  examples: { runId: string; startIndex: number }[];
  /**
   * Interface analysis (from dataflow edges of a representative occurrence):
   * how many values cross INTO the segment from earlier steps and OUT to later
   * steps. Few crossings = a clean contract = safe to extract as a sub-agent
   * or dedicated tool. internalDataflow = cohesion inside the segment.
   */
  boundaryInputs: number;
  boundaryOutputs: number;
  internalDataflow: number;
  separability: 'clean' | 'moderate' | 'entangled';
}

export function mineSegments(graphs: RunGraph[], maxSegments = MAX_SEGMENTS): MinedSegment[] {
  if (graphs.length < 2) return [];
  const stepCosts = new Map(graphs.map((g) => [g.runId, attributeStepCosts(g)]));

  interface Acc {
    labels: string[];
    runs: Set<string>;
    occurrences: { runId: string; startIndex: number; costUsd: number; valueHash: string }[];
  }
  const byKey = new Map<string, Acc>();

  for (const g of graphs) {
    const costs = stepCosts.get(g.runId)!;
    const seq = g.labelSequence;
    for (let n = MIN_LEN; n <= Math.min(MAX_LEN, seq.length); n++) {
      for (let i = 0; i + n <= seq.length; i++) {
        const labels = seq.slice(i, i + n);
        const key = createHash('sha256').update(labels.join('␞')).digest('hex').slice(0, 16);
        const acc = byKey.get(key) ?? byKey.set(key, { labels, runs: new Set(), occurrences: [] }).get(key)!;
        acc.runs.add(g.runId);
        acc.occurrences.push({
          runId: g.runId,
          startIndex: i,
          costUsd: costs.slice(i, i + n).reduce((s, c) => s + c, 0),
          valueHash: createHash('sha256')
            .update(g.nodes.slice(i, i + n).map((nd) => nd.canonicalValue).join('␟'))
            .digest('hex'),
        });
      }
    }
  }

  // Frequent = appears in ≥2 runs (or ≥30% for larger fleets).
  const minSupport = Math.max(2, Math.ceil(graphs.length * 0.3));
  let candidates = [...byKey.values()].filter((a) => a.runs.size >= minSupport);

  // Maximality: drop a segment if a strictly longer candidate with the SAME
  // support contains it (the longer one is the better compile unit).
  // Containment is checked on SEPARATOR-PADDED joins: a bare `.includes` can
  // match mid-label ("foo bar␞baz" would falsely contain "bar␞baz").
  const key = (labels: string[]) => `␞${labels.join('␞')}␞`;
  const byJoined = new Map(candidates.map((c) => [key(c.labels), c]));
  candidates = candidates.filter((c) => {
    for (const other of byJoined.values()) {
      if (other.labels.length <= c.labels.length) continue;
      if (other.runs.size < c.runs.size) continue;
      if (key(other.labels).includes(key(c.labels))) return false;
    }
    return true;
  });

  const graphById = new Map(graphs.map((g) => [g.runId, g]));
  const segments = candidates.map((c) => {
    const totalCost = c.occurrences.reduce((s, o) => s + o.costUsd, 0);
    const hashCounts = new Map<string, number>();
    for (const o of c.occurrences) hashCounts.set(o.valueHash, (hashCounts.get(o.valueHash) ?? 0) + 1);
    const modal = Math.max(...hashCounts.values());
    // Classify with the REAL nodes of a representative occurrence (bash commands
    // need the raw payload to distinguish read-only from mutating).
    const rep = c.occurrences[0];
    const repGraph = graphById.get(rep.runId)!;
    const repNodes = repGraph.nodes.slice(rep.startIndex, rep.startIndex + c.labels.length);
    const classes = repNodes.map((n) => classifyNode(n));
    const lo = rep.startIndex, hi = rep.startIndex + c.labels.length;
    let boundaryInputs = 0, boundaryOutputs = 0, internalDataflow = 0;
    for (const e of repGraph.edges) {
      if (e.type !== 'dataflow') continue;
      const fromIn = e.from >= lo && e.from < hi;
      const toIn = e.to >= lo && e.to < hi;
      if (fromIn && toIn) internalDataflow++;
      else if (!fromIn && toIn) boundaryInputs++;
      else if (fromIn && !toIn) boundaryOutputs++;
    }
    const crossings = boundaryInputs + boundaryOutputs;
    const separability: MinedSegment['separability'] =
      crossings <= 2 ? 'clean' : crossings <= 5 ? 'moderate' : 'entangled';
    const nonGenerative = classes.filter((cl) => cl === 'mechanical' || cl === 'cacheable').length;
    // dedupe example starts per run
    const seen = new Set<string>();
    const examples = c.occurrences
      .filter((o) => (seen.has(o.runId) ? false : (seen.add(o.runId), true)))
      .slice(0, 5)
      .map((o) => ({ runId: o.runId, startIndex: o.startIndex }));
    return {
      segmentId: createHash('sha256').update(key(c.labels)).digest('hex').slice(0, 12),
      labels: c.labels,
      length: c.labels.length,
      support: c.runs.size,
      runsTotal: graphs.length,
      occurrences: c.occurrences.length,
      avgCostPerOccurrenceUsd: Math.round((totalCost / c.occurrences.length) * 10000) / 10000,
      totalCostUsd: Math.round(totalCost * 100) / 100,
      determinism: Math.round((modal / c.occurrences.length) * 100) / 100,
      mechanicalRatio: Math.round((nonGenerative / classes.length) * 100) / 100,
      classes,
      examples,
      boundaryInputs,
      boundaryOutputs,
      internalDataflow,
      separability,
    };
  });

  return segments
    .sort((a, b) => b.totalCostUsd * b.support - a.totalCostUsd * a.support)
    .slice(0, maxSegments);
}
