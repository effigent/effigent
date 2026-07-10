/**
 * Run embeddings — deterministic, local, no API (owner constraint: the engine
 * stays I/O-free and embedding-API-free).
 *
 * A run's DAG is embedded as a fixed-size vector via signed feature hashing:
 *   - SEQ block (128 dims): structLabel unigrams/bigrams/trigrams — order.
 *   - FLOW block (128 dims): dataflow edge (from→to) structLabel pairs — the
 *     DAG topology, order-insensitive.
 * Each block is L2-normalized and scaled by √0.7 / √0.3, so the cosine of two
 * embeddings = 0.7·cos(seq) + 0.3·cos(flow) — the SAME weighting align.ts
 * uses for clustering (cosine here approximates edit similarity there; the
 * two agree on ordering in practice, and drift alerts must agree with what
 * the clusterer sees).
 *
 * What embeddings buy over pairwise runSimilarity:
 *   - O(1) comparison against a stored baseline centroid (drift detection —
 *     "has this agent CHANGED?") without reloading old runs' steps,
 *   - a per-run vector that can be persisted at ingest and indexed later
 *     (cross-agent procedure search / the knowledge-graph roadmap item).
 */

import type { RunGraph } from './types.js';

export const EMBED_SEQ_DIM = 128;
export const EMBED_FLOW_DIM = 128;
export const EMBED_DIM = EMBED_SEQ_DIM + EMBED_FLOW_DIM;

const SEQ_WEIGHT = Math.sqrt(0.7);
const FLOW_WEIGHT = Math.sqrt(0.3);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Signed feature hashing: index from the low bits, sign from the top bit. */
function addFeature(vec: Float64Array, dim: number, feature: string, weight = 1): void {
  const h = fnv1a(feature);
  const sign = (h >>> 31) === 1 ? -1 : 1;
  vec[h % dim] += sign * weight;
}

function l2(vec: Float64Array): number {
  let s = 0;
  for (const v of vec) s += v * v;
  return Math.sqrt(s);
}

export function embedRunGraph(g: RunGraph): number[] {
  const labels = g.nodes.map((n) => n.structLabel);

  const seq = new Float64Array(EMBED_SEQ_DIM);
  for (let i = 0; i < labels.length; i++) {
    addFeature(seq, EMBED_SEQ_DIM, `1:${labels[i]}`);
    if (i + 1 < labels.length) addFeature(seq, EMBED_SEQ_DIM, `2:${labels[i]}→${labels[i + 1]}`);
    if (i + 2 < labels.length) {
      addFeature(seq, EMBED_SEQ_DIM, `3:${labels[i]}→${labels[i + 1]}→${labels[i + 2]}`);
    }
  }

  const flow = new Float64Array(EMBED_FLOW_DIM);
  let flowEdges = 0;
  for (const e of g.edges) {
    if (e.type !== 'dataflow') continue;
    addFeature(flow, EMBED_FLOW_DIM, `f:${labels[e.from]}⇒${labels[e.to]}`);
    flowEdges++;
  }
  // Sentinel so two runs with NO dataflow at all agree on the flow block
  // (mirrors multisetJaccard(∅,∅) = 1 in align.ts).
  if (flowEdges === 0) addFeature(flow, EMBED_FLOW_DIM, 'f:∅');

  const out = new Array<number>(EMBED_DIM).fill(0);
  const seqNorm = l2(seq);
  const flowNorm = l2(flow);
  for (let i = 0; i < EMBED_SEQ_DIM; i++) {
    out[i] = seqNorm === 0 ? 0 : (seq[i] / seqNorm) * SEQ_WEIGHT;
  }
  for (let i = 0; i < EMBED_FLOW_DIM; i++) {
    out[EMBED_SEQ_DIM + i] = flowNorm === 0 ? 0 : (flow[i] / flowNorm) * FLOW_WEIGHT;
  }
  return out;
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function centroid(vecs: number[][]): number[] {
  const out = new Array<number>(vecs[0]?.length ?? 0).fill(0);
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  for (let i = 0; i < out.length; i++) out[i] /= Math.max(1, vecs.length);
  return out;
}
