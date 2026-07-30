import { describe, expect, it } from 'vitest';
import { mineSubtrees } from '../src/subtrees.js';
import type { GraphNode, RunGraph } from '../src/types.js';

/** Minimal node — only the fields subtree mining reads. */
function node(index: number, structLabel: string, value: string): GraphNode {
  return {
    index,
    kind: structLabel.startsWith('tool:') ? 'tool_use' : structLabel.startsWith('result:') ? 'tool_result' : 'model_turn',
    label: structLabel,
    structLabel,
    canonicalValue: value,
    valueHash: value,
    isError: false,
    raw: value,
    costUsd: 1,
  } as GraphNode;
}

/** `edges` are [from, to] DATAFLOW pairs; a temporal chain is always added too, to prove it is ignored. */
function graph(runId: string, labels: string[], edges: [number, number][], values?: string[]): RunGraph {
  return {
    runId,
    agentId: 'a',
    nodes: labels.map((l, i) => node(i, l, values?.[i] ?? `${runId}-v${i}`)),
    edges: [
      ...labels.slice(1).map((_, i) => ({ from: i, to: i + 1, type: 'temporal' as const })),
      ...edges.map(([from, to]) => ({ from, to, type: 'dataflow' as const })),
    ],
    l0: 'l0',
    l1: 'l1',
    labelSequence: labels,
    costUsd: labels.length,
    models: [],
    usageByModel: {},
  } as RunGraph;
}

// 4 nodes, span 2: 0 -> 1 -> 2, plus 0 -> 3. Clears minNodes=4 and minSpan=2.
const LABELS = ['tool:Read', 'result:Read:ok', 'llm:assistant', 'tool:Grep'];
const CHAIN: [number, number][] = [[0, 1], [1, 2], [0, 3]];

describe('mineSubtrees — repeated dataflow subtrees', () => {
  it('finds a subtree recurring across two runs', () => {
    const found = mineSubtrees([graph('r1', LABELS, CHAIN), graph('r2', LABELS, CHAIN)]);
    expect(found).toHaveLength(1);
    expect(found[0].nodes).toBe(4);
    expect(found[0].span).toBe(2);
    expect(found[0].support).toBe(2);
    expect(found[0].rootLabel).toBe('tool:Read');
  });

  it('is ORDER-INVARIANT — the point of hashing sorted children', () => {
    // Identical subtree; the two branches are declared in the opposite order and the
    // sibling steps are emitted in a different position. A linear n-gram miner sees
    // two different sequences.
    const a = graph('r1', ['tool:Read', 'result:Read:ok', 'llm:assistant', 'tool:Grep'], [[0, 1], [1, 2], [0, 3]]);
    const b = graph('r2', ['tool:Read', 'tool:Grep', 'result:Read:ok', 'llm:assistant'], [[0, 2], [2, 3], [0, 1]]);
    const found = mineSubtrees([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0].support).toBe(2);
  });

  it('REJECTS a flat fan-out — no node-to-node chain to act on', () => {
    // 4 nodes, but span 1: a root with three leaves only says "this step had
    // consumers". Nothing flows THROUGH anything, so there is nothing to extract.
    const fan: [number, number][] = [[0, 1], [0, 2], [0, 3]];
    expect(mineSubtrees([graph('r1', LABELS, fan), graph('r2', LABELS, fan)])).toHaveLength(0);
    // ...and it comes back once a real chain exists.
    expect(mineSubtrees([graph('r1', LABELS, CHAIN), graph('r2', LABELS, CHAIN)])).toHaveLength(1);
  });

  it('enforces the minimum tree size', () => {
    // 3-node chain: spans 2 but is below minNodes.
    const small = ['tool:Read', 'result:Read:ok', 'llm:assistant'];
    const chain: [number, number][] = [[0, 1], [1, 2]];
    expect(mineSubtrees([graph('r1', small, chain), graph('r2', small, chain)])).toHaveLength(0);
    // explicit override lets a caller opt into smaller units
    expect(
      mineSubtrees([graph('r1', small, chain), graph('r2', small, chain)], { minNodes: 3 }),
    ).toHaveLength(1);
  });

  it('does not match when a label differs', () => {
    const a = graph('r1', LABELS, CHAIN);
    const b = graph('r2', ['tool:Read', 'result:Read:FAIL', 'llm:assistant', 'tool:Grep'], CHAIN);
    expect(mineSubtrees([a, b])).toHaveLength(0);
  });

  it('ignores temporal edges — a plain chain yields no subtree', () => {
    expect(mineSubtrees([graph('r1', LABELS, []), graph('r2', LABELS, [])])).toHaveLength(0);
  });

  it('requires support in >= 2 distinct runs, not 2 occurrences in one', () => {
    const twice = graph(
      'solo',
      [...LABELS, ...LABELS],
      [[0, 1], [1, 2], [0, 3], [4, 5], [5, 6], [4, 7]],
    );
    expect(mineSubtrees([twice, graph('other', ['llm:assistant'], [])])).toHaveLength(0);
  });

  it('scores aggregate determinism 1 only when payloads are identical every time', () => {
    const same = ['w', 'x', 'y', 'z'];
    const identical = mineSubtrees([graph('r1', LABELS, CHAIN, same), graph('r2', LABELS, CHAIN, same)]);
    expect(identical[0].determinism).toBe(1);

    const varied = mineSubtrees([
      graph('r1', LABELS, CHAIN, ['a', 'b', 'c', 'd']),
      graph('r2', LABELS, CHAIN, ['e', 'f', 'g', 'h']),
    ]);
    expect(varied[0].determinism).toBeLessThan(1);
  });

  it('reports PER-NODE determinism, so a tree can show what is stable', () => {
    // Root and leaf constant; the middle two vary run to run.
    const found = mineSubtrees([
      graph('r1', LABELS, CHAIN, ['CONST', 'varies-1', 'varies-1', 'LEAF']),
      graph('r2', LABELS, CHAIN, ['CONST', 'varies-2', 'varies-2', 'LEAF']),
    ]);
    expect(found).toHaveLength(1);
    const tree = found[0].tree;
    expect(tree).toHaveLength(4);

    const byLabel = new Map(tree.map((t) => [t.structLabel, t]));
    expect(byLabel.get('tool:Read')!.determinism).toBe(1);      // constant
    expect(byLabel.get('tool:Grep')!.determinism).toBe(1);      // constant
    expect(byLabel.get('result:Read:ok')!.determinism).toBeLessThan(1);
    expect(byLabel.get('result:Read:ok')!.distinctValues).toBe(2);
  });

  it('emits a well-formed tree: root first, parents before children', () => {
    const found = mineSubtrees([graph('r1', LABELS, CHAIN), graph('r2', LABELS, CHAIN)]);
    const tree = found[0].tree;
    expect(tree[0].parent).toBeNull();
    expect(tree[0].level).toBe(0);
    for (const n of tree.slice(1)) {
      expect(n.parent).not.toBeNull();
      // a parent must already have been emitted, so levels render top-down
      expect(n.parent!).toBeLessThan(n.position);
      expect(n.level).toBe(tree[n.parent!].level + 1);
    }
  });

  it('reports LOW confidence when determinism rests on two samples', () => {
    // Two occurrences that happen to be identical score determinism 1.0. That is not
    // evidence — and unguarded it recommended "compile" for a 10-node llm:assistant
    // subtree calling AskUserQuestion. The Wilson bound at n=2 must stay well below
    // any compile gate.
    const same = ['w', 'x', 'y', 'z'];
    const found = mineSubtrees([graph('r1', LABELS, CHAIN, same), graph('r2', LABELS, CHAIN, same)]);
    expect(found[0].determinism).toBe(1);
    expect(found[0].occurrences).toBe(2);
    expect(found[0].confidence).toBeLessThan(0.6);
  });

  it('confidence rises as agreeing occurrences accumulate', () => {
    const same = ['w', 'x', 'y', 'z'];
    const many = Array.from({ length: 12 }, (_, i) => graph(`r${i}`, LABELS, CHAIN, same));
    const found = mineSubtrees(many);
    expect(found[0].occurrences).toBe(12);
    expect(found[0].confidence).toBeGreaterThan(0.6);
  });

  it('returns nothing when there are fewer runs than minSupport', () => {
    expect(mineSubtrees([graph('r1', LABELS, CHAIN)])).toHaveLength(0);
  });
});
