/**
 * Run alignment — determinism v3 stages 1–2 (docs/determinism-v3.md).
 *
 * v2 grouped runs by exact label-sequence hash (L1), which shatters real
 * histories: runs are routinely 90% similar but almost never byte-identical,
 * so most of the window contributed nothing. v3 instead:
 *
 *   1. scores pairwise similarity from BOTH views of the graph —
 *        seq  = normalized edit similarity over content-blind structLabels
 *        flow = Jaccard over the dataflow edge topology (order-insensitive:
 *               forgives benign reorderings that seq punishes)
 *        sim  = 0.7·seq + 0.3·flow
 *      This is the DAG's answer to "are these runs pretty much the same?".
 *   2. clusters runs with a deterministic complete-link leader pass, and
 *   3. aligns every run to the cluster MEDOID (Needleman-Wunsch over
 *      structLabels; mismatches score below two gaps, so a column only ever
 *      contains structurally identical steps).
 *
 * The result is COLUMNS — "the same step across runs", tolerant of inserted
 * retries/detours — which is what per-node determinism is scored on.
 */

import type { GraphNode, RunGraph, StepKind } from './types.js';

export interface RunSimilarity {
  seq: number;
  flow: number;
  combined: number;
}

/** Levenshtein distance over token arrays (two-row DP). */
export function levenshtein(a: string[], b: string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Int32Array(b.length + 1);
  let curr = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      curr[j] = Math.min(sub, prev[j] + 1, curr[j - 1] + 1);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Multiset of dataflow edges as (from → to) structLabel pairs. */
function flowPairs(g: RunGraph): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of g.edges) {
    if (e.type !== 'dataflow') continue;
    const key = `${g.nodes[e.from]?.structLabel}→${g.nodes[e.to]?.structLabel}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/** Multiset Jaccard: Σmin / Σmax. Both empty ⇒ 1 (no topology to disagree on). */
function multisetJaccard(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let min = 0;
  let max = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const va = a.get(k) ?? 0;
    const vb = b.get(k) ?? 0;
    min += Math.min(va, vb);
    max += Math.max(va, vb);
  }
  return max === 0 ? 1 : min / max;
}

export function runSimilarity(a: RunGraph, b: RunGraph): RunSimilarity {
  const sa = a.nodes.map((n) => n.structLabel);
  const sb = b.nodes.map((n) => n.structLabel);
  const maxLen = Math.max(sa.length, sb.length);
  const seq = maxLen === 0 ? 1 : 1 - levenshtein(sa, sb) / maxLen;
  const flow = multisetJaccard(flowPairs(a), flowPairs(b));
  return { seq, flow, combined: 0.7 * seq + 0.3 * flow };
}

export interface RunCluster {
  /** Stable-ish display key: agent + medoid shape hash. */
  key: string;
  agentId: string;
  runs: RunGraph[];
  medoid: RunGraph;
  /** Mean pairwise similarity of members to the medoid. */
  meanSim: number;
}

export interface AlignOptions {
  /** Combined-similarity threshold for joining a cluster (complete-link). */
  threshold?: number;
}

/**
 * Deterministic complete-link leader clustering within each agent: runs are
 * visited in (startedAt, runId) order and join the first cluster whose EVERY
 * member is ≥ threshold similar; otherwise they found a new cluster.
 */
/** Chronological sort key tolerant of Date/number/invalid startedAt values —
 *  callers (e.g. a DB layer handing back Date objects) may violate the string
 *  contract; a bad timestamp must never crash clustering. */
export function tsKey(s: unknown): string {
  if (typeof s === 'string') return s;
  if (s == null) return '';
  const d = new Date(s as string | number | Date);
  return Number.isNaN(d.getTime()) ? String(s) : d.toISOString();
}

export function clusterBySimilarity(graphs: RunGraph[], opts: AlignOptions = {}): RunCluster[] {
  const threshold = opts.threshold ?? 0.75;
  const ordered = [...graphs].sort(
    (a, b) =>
      a.agentId.localeCompare(b.agentId) ||
      tsKey(a.startedAt).localeCompare(tsKey(b.startedAt)) ||
      a.runId.localeCompare(b.runId),
  );

  const simCache = new Map<string, number>();
  const sim = (a: RunGraph, b: RunGraph): number => {
    const key = a.runId < b.runId ? `${a.runId}␟${b.runId}` : `${b.runId}␟${a.runId}`;
    let s = simCache.get(key);
    if (s === undefined) {
      s = runSimilarity(a, b).combined;
      simCache.set(key, s);
    }
    return s;
  };

  const clusters: RunGraph[][] = [];
  for (const g of ordered) {
    let placed = false;
    for (const members of clusters) {
      if (members[0].agentId !== g.agentId) continue;
      if (members.every((m) => sim(m, g) >= threshold)) {
        members.push(g);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([g]);
  }

  return clusters.map((members) => {
    let medoid = members[0];
    let best = -1;
    for (const cand of members) {
      const total = members.reduce((s, m) => (m === cand ? s : s + sim(cand, m)), 0);
      if (total > best) {
        best = total;
        medoid = cand;
      }
    }
    const meanSim =
      members.length <= 1
        ? 1
        : members.reduce((s, m) => (m === medoid ? s : s + sim(medoid, m)), 0) /
          (members.length - 1);
    return {
      key: `${medoid.agentId}:${medoid.l1.slice(0, 12)}`,
      agentId: medoid.agentId,
      runs: members,
      medoid,
      meanSim,
    };
  });
}

export interface AlignedColumn {
  /** Medoid node index — the column's identity. */
  index: number;
  structLabel: string;
  kind: StepKind;
  /** Aligned node per run (same order as cluster.runs); null = gap. */
  nodes: (GraphNode | null)[];
  /** Number of runs with a node in this column. */
  support: number;
}

export interface ClusterAlignment {
  cluster: RunCluster;
  columns: AlignedColumn[];
  /** Per run: nodes NOT aligned to any medoid column (retries, detours). */
  insertions: number[];
}

const MAX_NW_CELLS = 4_000_000; // ~2000×2000 steps; beyond that a run stays unaligned

/**
 * Needleman-Wunsch over structLabels. match +2, gap −1, mismatch −3 (worse
 * than two gaps, so unequal steps are never paired into a column). Returns,
 * for each medoid index, the matched node index in `run` or −1.
 */
function nwAlign(medoid: readonly string[], run: readonly string[]): Int32Array | null {
  const n = medoid.length;
  const m = run.length;
  if ((n + 1) * (m + 1) > MAX_NW_CELLS) return null;
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const ptr = new Uint8Array((n + 1) * W); // 1=diag 2=up(gap in run) 3=left(gap in medoid)
  for (let i = 1; i <= n; i++) {
    score[i * W] = -i;
    ptr[i * W] = 2;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = -j;
    ptr[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = score[(i - 1) * W + (j - 1)] + (medoid[i - 1] === run[j - 1] ? 2 : -3);
      const up = score[(i - 1) * W + j] - 1;
      const left = score[i * W + (j - 1)] - 1;
      // Tie-break: prefer diag (pairing), then up, then left — deterministic.
      if (diag >= up && diag >= left) {
        score[i * W + j] = diag;
        ptr[i * W + j] = 1;
      } else if (up >= left) {
        score[i * W + j] = up;
        ptr[i * W + j] = 2;
      } else {
        score[i * W + j] = left;
        ptr[i * W + j] = 3;
      }
    }
  }
  const map = new Int32Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const p = ptr[i * W + j];
    if (p === 1) {
      if (medoid[i - 1] === run[j - 1]) map[i - 1] = j - 1;
      i--;
      j--;
    } else if (p === 2) {
      i--;
    } else {
      j--;
    }
  }
  return map;
}

/** Align every member run to the medoid; build per-column node rows. */
export function alignCluster(cluster: RunCluster): ClusterAlignment {
  const { medoid, runs } = cluster;
  const medLabels = medoid.nodes.map((n) => n.structLabel);
  const columns: AlignedColumn[] = medoid.nodes.map((node) => ({
    index: node.index,
    structLabel: node.structLabel,
    kind: node.kind,
    nodes: new Array<GraphNode | null>(runs.length).fill(null),
    support: 0,
  }));
  const insertions: number[] = new Array(runs.length).fill(0);

  runs.forEach((run, ri) => {
    if (run === medoid) {
      medoid.nodes.forEach((node, i) => {
        columns[i].nodes[ri] = node;
      });
      return;
    }
    const map = nwAlign(medLabels, run.nodes.map((n) => n.structLabel));
    if (!map) {
      insertions[ri] = run.nodes.length; // too large to align — fully unmatched
      return;
    }
    let matched = 0;
    for (let i = 0; i < map.length; i++) {
      const j = map[i];
      if (j >= 0) {
        columns[i].nodes[ri] = run.nodes[j];
        matched++;
      }
    }
    insertions[ri] = run.nodes.length - matched;
  });

  for (const col of columns) {
    col.support = col.nodes.reduce((s, n) => s + (n ? 1 : 0), 0);
  }
  return { cluster, columns, insertions };
}
