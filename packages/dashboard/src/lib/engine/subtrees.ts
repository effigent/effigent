// VENDORED from packages/core/src/subtrees.ts — do not edit here (re-vendor after core changes).
/**
 * Subtree mining — find repeated DATAFLOW subtrees across runs.
 *
 * The third granularity of determinism, below whole runs and beside segments:
 *
 *   - `align.ts` asks "are two whole runs the same shape?" Long interactive
 *     sessions never are (measured: pairwise similarity peaks ~0.58 against a
 *     0.75 threshold), so that layer stays silent on them.
 *   - `segments.ts` asks "does the same LINEAR label n-gram recur?" That finds
 *     contiguous motifs, but it reads a run as a flat sequence — so a motif whose
 *     steps interleave with unrelated work, or whose siblings execute in a
 *     different order, is invisible to it.
 *   - here we ask "does the same SUBTREE of the dataflow graph recur?" Values
 *     flowing from a step to its consumers form a rooted tree, and that tree is
 *     the unit of work regardless of the order the steps were emitted in.
 *
 * Method: Merkle / Weisfeiler-Lehman rooted-subtree hashing.
 *
 *     h0(v) = structLabel(v)
 *     hd(v) = H( structLabel(v) + sorted([ h{d-1}(c) for c in children(v) ]) )
 *
 * Sorting the child hashes is what makes this order-invariant: the same subtree
 * matches even when its branches interleave differently. Equal hash at depth d
 * means an isomorphic labelled rooted subtree of depth d.
 *
 * Only `dataflow` edges are followed. Temporal edges chain every step to its
 * neighbour, so including them would make every subtree a path and reduce this to
 * a worse segment miner.
 *
 * Exact hashing is deliberately strict — one differing leaf breaks the whole hash
 * — so frequent subtrees are SMALL (3-6 nodes in practice) while large ones show
 * up in only a couple of runs. Ranking is therefore by measured cost, which is
 * size x frequency x price, rather than by size.
 */

import { createHash } from 'node:crypto';
import type { RunGraph } from './types.ts';
import { classifyNode, type StepClass } from './taxonomy.ts';
import { attributeStepCosts } from './segments.ts';

/** Depth of the rooted subtree. 2 captures a step, its consumers, and theirs. */
const DEFAULT_DEPTH = 2;
/** Below this a "subtree" is a node or a pair — not a unit of work worth naming. */
const MIN_NODES = 3;
const MAX_SUBTREES = 12;

export interface MinedSubtree {
  /** Stable id: the canonical subtree hash. */
  subtreeId: string;
  /** structLabel of the root — the step whose outputs the subtree consumes. */
  rootLabel: string;
  /** Distinct structLabels in the subtree, root first, for display. */
  labels: string[];
  /** Node count of the rooted subtree. */
  nodes: number;
  depth: number;
  /** Runs containing it at least once, and the window size. */
  support: number;
  runsTotal: number;
  occurrences: number;
  totalCostUsd: number;
  avgCostPerOccurrenceUsd: number;
  /**
   * Value equality across occurrences: 1 = every occurrence carried byte-identical
   * payloads. Structural recurrence with LOW determinism is the common case — same
   * procedure, different data — and means route/extract, never compile.
   */
  determinism: number;
  /** Share of member steps needing no intelligence (mechanical + cacheable). */
  mechanicalRatio: number;
  classes: StepClass[];
  examples: { runId: string; rootIndex: number }[];
}

const H = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Adjacency over dataflow edges only. */
function dataflowChildren(graph: RunGraph): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  for (const e of graph.edges) {
    if (e.type !== 'dataflow') continue;
    const list = kids.get(e.from);
    if (list) list.push(e.to);
    else kids.set(e.from, [e.to]);
  }
  return kids;
}

interface Rooted {
  hash: string[];
  size: number[];
  cost: number[];
  members: number[][];
}

/** Rooted-subtree hash, size, cost and members for every node, at exactly `depth`. */
function rootedSubtrees(graph: RunGraph, depth: number): Rooted {
  const kids = dataflowChildren(graph);
  const stepCost = attributeStepCosts(graph);
  const n = graph.nodes.length;

  let hash = graph.nodes.map((node) => node.structLabel);
  let size = new Array<number>(n).fill(1);
  let cost = stepCost.slice();
  let members: number[][] = graph.nodes.map((_, i) => [i]);

  for (let d = 1; d <= depth; d++) {
    const nh = new Array<string>(n);
    const ns = new Array<number>(n);
    const nc = new Array<number>(n);
    const nm: number[][] = new Array(n);
    for (let v = 0; v < n; v++) {
      const cs = kids.get(v) ?? [];
      nh[v] = H(`${graph.nodes[v].structLabel}(${cs.map((c) => hash[c]).sort().join(',')})`);
      ns[v] = 1 + cs.reduce((s, c) => s + size[c], 0);
      nc[v] = stepCost[v] + cs.reduce((s, c) => s + cost[c], 0);
      // A DAG can reach the same node by two paths; it is still one member.
      nm[v] = [...new Set([v, ...cs.flatMap((c) => members[c])])];
    }
    hash = nh;
    size = ns;
    cost = nc;
    members = nm;
  }
  return { hash, size, cost, members };
}

export interface MineSubtreeOptions {
  depth?: number;
  minNodes?: number;
  maxSubtrees?: number;
  /** Minimum distinct runs a subtree must appear in. */
  minSupport?: number;
}

/**
 * Mine repeated dataflow subtrees across a window of runs (all one agent).
 * Returns the highest-cost recurring subtrees, most expensive first.
 */
export function mineSubtrees(graphs: RunGraph[], opts: MineSubtreeOptions = {}): MinedSubtree[] {
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const minNodes = opts.minNodes ?? MIN_NODES;
  const minSupport = opts.minSupport ?? 2;
  if (graphs.length < minSupport) return [];

  interface Acc {
    rootLabel: string;
    labels: string[];
    nodes: number;
    runs: Set<string>;
    occurrences: number;
    cost: number;
    valueSigs: Set<string>;
    classes: StepClass[];
    examples: { runId: string; rootIndex: number }[];
  }
  const acc = new Map<string, Acc>();

  for (const graph of graphs) {
    const { hash, size, cost, members } = rootedSubtrees(graph, depth);
    for (let v = 0; v < graph.nodes.length; v++) {
      if (size[v] < minNodes) continue;
      const key = hash[v];
      const memberNodes = members[v].map((i) => graph.nodes[i]);
      const rootLabel = graph.nodes[v].structLabel;
      let rec = acc.get(key);
      if (!rec) {
        rec = {
          rootLabel,
          labels: [
            rootLabel,
            ...[...new Set(memberNodes.map((m) => m.structLabel))].filter((l) => l !== rootLabel),
          ],
          nodes: size[v],
          runs: new Set(),
          occurrences: 0,
          cost: 0,
          valueSigs: new Set(),
          classes: memberNodes.map((m) => classifyNode(m)),
          examples: [],
        };
        acc.set(key, rec);
      }
      rec.runs.add(graph.runId);
      rec.occurrences++;
      rec.cost += cost[v];
      // Order-independent value signature: identical across occurrences means the
      // subtree carried the same data every time, not merely the same shape.
      rec.valueSigs.add(H(memberNodes.map((m) => m.valueHash).sort().join('|')));
      if (rec.examples.length < 3) rec.examples.push({ runId: graph.runId, rootIndex: v });
    }
  }

  const recurring = [...acc.entries()].filter(([, r]) => r.runs.size >= minSupport);

  // Maximality: when two subtrees share a root and have identical support AND
  // occurrence counts, they are almost certainly the same motif observed at
  // different depths — keep the larger and drop the rest instead of padding the list.
  const bySignature = new Map<string, { key: string; nodes: number }>();
  for (const [key, r] of recurring) {
    const sig = `${r.runs.size}|${r.occurrences}|${r.rootLabel}`;
    const prev = bySignature.get(sig);
    if (!prev || r.nodes > prev.nodes) bySignature.set(sig, { key, nodes: r.nodes });
  }
  const keep = new Set([...bySignature.values()].map((v) => v.key));

  return recurring
    .filter(([key]) => keep.has(key))
    .map(([subtreeId, r]) => {
      const nonGenerative = r.classes.filter((c) => c === 'mechanical' || c === 'cacheable').length;
      return {
        subtreeId,
        rootLabel: r.rootLabel,
        labels: r.labels.slice(0, 6),
        nodes: r.nodes,
        depth,
        support: r.runs.size,
        runsTotal: graphs.length,
        occurrences: r.occurrences,
        totalCostUsd: r.cost,
        avgCostPerOccurrenceUsd: r.cost / Math.max(1, r.occurrences),
        // one distinct signature across N occurrences = perfectly deterministic
        determinism: r.valueSigs.size > 0 ? 1 / r.valueSigs.size : 0,
        mechanicalRatio: r.classes.length
          ? Math.round((nonGenerative / r.classes.length) * 100) / 100
          : 0,
        classes: [...new Set(r.classes)],
        examples: r.examples,
      };
    })
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, opts.maxSubtrees ?? MAX_SUBTREES);
}
