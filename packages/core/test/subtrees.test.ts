import { describe, expect, it } from 'vitest';
import { mineSubtrees } from '../src/subtrees.js';
import type { GraphNode, RunGraph } from '../src/types.js';

/** Minimal node — only the fields subtree mining reads. */
function node(index: number, structLabel: string, value = `v${index}`): GraphNode {
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

/** `edges` as [from, to] dataflow pairs; a temporal chain is added too, to prove it is ignored. */
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

const LABELS = ['tool:Read', 'result:Read:ok', 'llm:assistant'];
// root 0 feeds 1 and 2 — a 3-node rooted subtree
const FAN: [number, number][] = [[0, 1], [0, 2]];

describe('mineSubtrees — repeated dataflow subtrees', () => {
  it('finds a subtree recurring across two runs', () => {
    const found = mineSubtrees([graph('r1', LABELS, FAN), graph('r2', LABELS, FAN)]);
    expect(found).toHaveLength(1);
    expect(found[0].nodes).toBe(3);
    expect(found[0].support).toBe(2);
    expect(found[0].runsTotal).toBe(2);
    expect(found[0].rootLabel).toBe('tool:Read');
  });

  it('is ORDER-INVARIANT — the point of hashing sorted children', () => {
    // Same root, same two children, edges declared in the opposite order and the
    // sibling labels swapped in emission order. A linear n-gram miner sees two
    // different sequences; the subtree is identical.
    const a = graph('r1', ['tool:Read', 'result:Read:ok', 'llm:assistant'], [[0, 1], [0, 2]]);
    const b = graph('r2', ['tool:Read', 'llm:assistant', 'result:Read:ok'], [[0, 2], [0, 1]]);
    const found = mineSubtrees([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0].support).toBe(2);
  });

  it('does not match when a child label differs', () => {
    const a = graph('r1', ['tool:Read', 'result:Read:ok', 'llm:assistant'], FAN);
    const b = graph('r2', ['tool:Read', 'result:Read:FAIL', 'llm:assistant'], FAN);
    expect(mineSubtrees([a, b])).toHaveLength(0);
  });

  it('ignores temporal edges — a plain chain yields no subtree', () => {
    // No dataflow edges at all: every node is its own 1-node subtree, below minNodes.
    const a = graph('r1', LABELS, []);
    const b = graph('r2', LABELS, []);
    expect(mineSubtrees([a, b])).toHaveLength(0);
  });

  it('requires support in >= 2 distinct runs, not 2 occurrences in one', () => {
    // One run containing the same subtree twice (roots 0 and 3).
    const twice = graph(
      'solo',
      [...LABELS, ...LABELS],
      [[0, 1], [0, 2], [3, 4], [3, 5]],
    );
    expect(mineSubtrees([twice, graph('other', ['llm:assistant'], [])])).toHaveLength(0);
  });

  it('scores determinism 1 only when payloads are identical every time', () => {
    const same = ['x', 'y', 'z'];
    const identical = mineSubtrees([
      graph('r1', LABELS, FAN, same),
      graph('r2', LABELS, FAN, same),
    ]);
    expect(identical[0].determinism).toBe(1);

    // Same shape, different data — the common real case: route, never compile.
    const varied = mineSubtrees([
      graph('r1', LABELS, FAN, ['a', 'b', 'c']),
      graph('r2', LABELS, FAN, ['d', 'e', 'f']),
    ]);
    expect(varied[0].determinism).toBeLessThan(1);
  });

  it('reports mechanicalRatio from the member taxonomy', () => {
    const found = mineSubtrees([graph('r1', LABELS, FAN), graph('r2', LABELS, FAN)]);
    // Read + its result are mechanical; the assistant turn is generative.
    expect(found[0].mechanicalRatio).toBeGreaterThan(0);
    expect(found[0].mechanicalRatio).toBeLessThan(1);
  });

  it('returns nothing when there are fewer runs than minSupport', () => {
    expect(mineSubtrees([graph('r1', LABELS, FAN)])).toHaveLength(0);
  });
});
