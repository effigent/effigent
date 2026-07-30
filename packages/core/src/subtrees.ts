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
import type { RunGraph } from './types.js';
import { classifyNode, type StepClass } from './taxonomy.js';
import { attributeStepCosts } from './segments.js';
import { wilsonLower } from './determinism.js';

/** Depth of the rooted subtree. 2 captures a step, its consumers, and theirs. */
const DEFAULT_DEPTH = 2;
/**
 * Minimum nodes. A 3-node subtree is usually one step and two leaves — too small
 * to name as a unit of work, and it floods the ranking with near-noise.
 */
const MIN_NODES = 4;
/**
 * Minimum root-to-leaf span. A subtree can hit MIN_NODES as a flat fan (a root with
 * three leaves), which says "this step had consumers" — not actionable. Requiring a
 * path of at least two edges means the subtree carries a value from one node,
 * THROUGH another, to a third: an actual chain of work that can be extracted,
 * routed, or compiled as a unit.
 */
const MIN_SPAN = 2;
const MAX_SUBTREES = 12;

/**
 * One node of a mined subtree, in canonical position order.
 *
 * `determinism` here is PER NODE, which is what makes a rendered tree readable:
 * an aggregate score cannot say *which* steps were stable, so it cannot justify a
 * recommendation. A subtree whose root is volatile but whose two leaves are
 * constant is a different proposition from the reverse.
 */
export interface SubtreeNode {
  /** Position in canonical order; 0 is the root. Stable across occurrences. */
  position: number;
  /** Canonical position of the parent, or null for the root. */
  parent: number | null;
  /** Depth below the root (root = 0) — the render level. */
  level: number;
  structLabel: string;
  class: StepClass;
  /** 1 = this step carried byte-identical payloads in every occurrence. */
  determinism: number;
  /**
   * Wilson lower bound on this node's determinism at n = occurrences.
   *
   * Needed because raw per-node determinism is as untrustworthy on small samples as
   * the aggregate was: a subtree seen twice paints EVERY node "100% stable, 1 value",
   * which reads as "perfectly deterministic, compile it" while the verdict says
   * extract-as-sub-agent at 34% confidence. The picture and the recommendation
   * contradicted each other. Renderers must colour on this, not on `determinism`.
   */
  confidence: number;
  /** Distinct payloads seen across occurrences. 1 = constant. */
  distinctValues: number;
  /** Occurrences this node's stability was measured over — the sample size. */
  samples: number;
}

export interface MinedSubtree {
  /** Stable id: the canonical subtree hash. */
  subtreeId: string;
  /** structLabel of the root — the step whose outputs the subtree consumes. */
  rootLabel: string;
  /** Distinct structLabels in the subtree, root first, for display. */
  labels: string[];
  /** Node count of the rooted subtree. */
  nodes: number;
  /** Longest root-to-leaf edge count — the length of the node-to-node chain. */
  span: number;
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
  /**
   * Wilson lower bound on `determinism` at n = occurrences — the same honesty gate
   * the D0-D5 lattice applies.
   *
   * Raw determinism is untrustworthy on tiny samples: two occurrences that happen to
   * be identical score 1.0, which produced a real false positive — a 10-node
   * llm:assistant subtree calling AskUserQuestion, seen twice, recommended for
   * "compile". Compiling an interactive prompt flow is nonsense. Callers must gate
   * on this, not on `determinism`.
   */
  confidence: number;
  /** Share of member steps needing no intelligence (mechanical + cacheable). */
  mechanicalRatio: number;
  classes: StepClass[];
  examples: { runId: string; rootIndex: number }[];
  /**
   * The subtree itself, in canonical order, with per-node stability — enough to
   * draw it and colour each step by how deterministic it actually was.
   */
  tree: SubtreeNode[];
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

interface CanonMember {
  index: number;
  parent: number | null;
  level: number;
}

/**
 * Walk a rooted subtree in CANONICAL order: root first, then each child subtree in
 * ascending order of the child's own subtree hash.
 *
 * The ordering has to be derived from structure alone, never from graph indices or
 * emission order, or position `i` would mean a different step in each occurrence
 * and per-node stability would be meaningless. Sorting by subtree hash is the same
 * rule the identity hash uses, so any two occurrences that hash equal also
 * enumerate equal.
 *
 * `seen` guards the DAG case: a node reachable by two paths is visited once, under
 * whichever parent reaches it first in canonical order.
 */
function canonicalMembers(
  graph: RunGraph,
  kids: Map<number, number[]>,
  hashAt: string[][],
  root: number,
  depth: number,
): CanonMember[] {
  const out: CanonMember[] = [];
  const seen = new Set<number>();
  const visit = (v: number, parent: number | null, level: number, remaining: number): void => {
    if (seen.has(v)) return;
    seen.add(v);
    const position = out.length;
    out.push({ index: v, parent, level });
    if (remaining <= 0) return;
    // hashAt[remaining - 1] is the child's subtree hash at the depth it contributes.
    const table = hashAt[remaining - 1] ?? hashAt[0];
    const children = [...(kids.get(v) ?? [])].sort((a, b) => {
      const ha = table[a] ?? '';
      const hb = table[b] ?? '';
      return ha < hb ? -1 : ha > hb ? 1 : a - b;
    });
    for (const c of children) visit(c, position, level + 1, remaining - 1);
  };
  visit(root, null, 0, depth);
  return out;
}

/** Rooted-subtree hash, size, cost and members for every node, at exactly `depth`. */
function rootedSubtrees(graph: RunGraph, depth: number): Rooted & { hashAt: string[][] } {
  const kids = dataflowChildren(graph);
  const stepCost = attributeStepCosts(graph);
  const n = graph.nodes.length;

  let hash = graph.nodes.map((node) => node.structLabel);
  let size = new Array<number>(n).fill(1);
  let cost = stepCost.slice();
  let members: number[][] = graph.nodes.map((_, i) => [i]);
  // Every level is retained so canonicalMembers can sort children by the hash at
  // the depth they actually contribute.
  const hashAt: string[][] = [hash.slice()];

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
    hashAt.push(nh.slice());
  }
  return { hash, size, cost, members, hashAt };
}

export interface MineSubtreeOptions {
  depth?: number;
  minNodes?: number;
  /** Minimum root-to-leaf edge count — see {@link MIN_SPAN}. */
  minSpan?: number;
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
  const minSpan = opts.minSpan ?? MIN_SPAN;
  const minSupport = opts.minSupport ?? 2;
  if (graphs.length < minSupport) return [];

  interface Acc {
    rootLabel: string;
    labels: string[];
    nodes: number;
    span: number;
    runs: Set<string>;
    occurrences: number;
    cost: number;
    valueSigs: Set<string>;
    classes: StepClass[];
    examples: { runId: string; rootIndex: number }[];
    /** Canonical shape, from the first occurrence — identical for equal hashes. */
    shape: CanonMember[];
    shapeLabels: string[];
    /** Taxonomy per canonical position, from the real nodes (not re-derived). */
    shapeClasses: StepClass[];
    /** Per canonical position: the distinct payloads seen across occurrences. */
    valuesAt: Set<string>[];
  }
  const acc = new Map<string, Acc>();

  for (const graph of graphs) {
    const { hash, size, cost, members, hashAt } = rootedSubtrees(graph, depth);
    const kids = dataflowChildren(graph);
    for (let v = 0; v < graph.nodes.length; v++) {
      // Cheap prefilter only. `size` counts DAG paths WITH multiplicity, so it is an
      // upper bound on the deduped node count and can never drop a qualifying
      // subtree — but it is the wrong number to report, because a node reachable by
      // two paths is one node in the tree we draw.
      if (size[v] < minNodes) continue;
      const shape = canonicalMembers(graph, kids, hashAt, v, depth);
      // The authoritative size: exactly the nodes that get rendered.
      const nodeCount = shape.length;
      if (nodeCount < minNodes) continue;
      const span = Math.max(...shape.map((m) => m.level));
      // Reject flat fan-outs: without a real chain there is no node-to-node flow
      // to extract, only "this step had consumers".
      if (span < minSpan) continue;
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
          nodes: nodeCount,
          span,
          runs: new Set(),
          occurrences: 0,
          cost: 0,
          valueSigs: new Set(),
          classes: memberNodes.map((m) => classifyNode(m)),
          examples: [],
          shape,
          shapeLabels: shape.map((m) => graph.nodes[m.index].structLabel),
          shapeClasses: shape.map((m) => classifyNode(graph.nodes[m.index])),
          valuesAt: shape.map(() => new Set<string>()),
        };
        acc.set(key, rec);
      }
      rec.runs.add(graph.runId);
      rec.occurrences++;
      rec.cost += cost[v];
      // Order-independent value signature: identical across occurrences means the
      // subtree carried the same data every time, not merely the same shape.
      rec.valueSigs.add(H(memberNodes.map((m) => m.valueHash).sort().join('|')));
      // Per-position payloads. Canonical order guarantees position i is the same
      // step in every occurrence, which is what makes per-node stability real.
      shape.forEach((m, i) => rec!.valuesAt[i]?.add(graph.nodes[m.index].valueHash));
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
        span: r.span,
        depth,
        support: r.runs.size,
        runsTotal: graphs.length,
        occurrences: r.occurrences,
        totalCostUsd: r.cost,
        avgCostPerOccurrenceUsd: r.cost / Math.max(1, r.occurrences),
        // one distinct signature across N occurrences = perfectly deterministic
        determinism: r.valueSigs.size > 0 ? 1 / r.valueSigs.size : 0,
        // Wilson lower bound of "occurrences that agreed" out of all occurrences.
        // With 2/2 agreeing this lands near 0.34, well under any compile gate, which
        // is the point: identical twice is not evidence of determinism.
        confidence:
          r.occurrences > 0
            ? Math.round(
                wilsonLower(Math.round(r.occurrences / Math.max(1, r.valueSigs.size)), r.occurrences) * 100,
              ) / 100
            : 0,
        mechanicalRatio: r.classes.length
          ? Math.round((nonGenerative / r.classes.length) * 100) / 100
          : 0,
        classes: [...new Set(r.classes)],
        examples: r.examples,
        tree: r.shape.map((m, i) => {
          const distinct = r.valuesAt[i]?.size ?? 0;
          return {
            position: i,
            parent: m.parent,
            level: m.level,
            structLabel: r.shapeLabels[i] ?? '',
            class: r.shapeClasses[i] ?? 'side_effect',
            determinism: distinct > 0 ? Math.round((1 / distinct) * 100) / 100 : 0,
            confidence:
              r.occurrences > 0
                ? Math.round(
                    wilsonLower(Math.round(r.occurrences / Math.max(1, distinct)), r.occurrences) * 100,
                  ) / 100
                : 0,
            distinctValues: distinct,
            samples: r.occurrences,
          };
        }),
      };
    })
    .sort((a, b) => b.totalCostUsd * b.confidence - a.totalCostUsd * a.confidence)
    .slice(0, opts.maxSubtrees ?? MAX_SUBTREES);
}
