import { describe, it, expect } from 'vitest';
import type { Run, RawStep } from '../src/types.js';
import { buildRunGraph } from '../src/graph.js';
import { analyzePredictability } from '../src/entropy.js';

/** Ground-truth tests: corpora constructed so the right answer is known. */

function step(kind: RawStep['kind'], name: string, payload: string, extra: Partial<RawStep> = {}): RawStep {
  return { kind, name, payload, ...extra };
}

/** One run = one episode with a fixed 4-step workflow (thinking glue between calls). */
function ritualRun(runId: string, i: number): Run {
  return {
    runId, agentId: 'a',
    steps: [
      step('model_turn', 'user', `deploy build ${i}`),
      step('model_turn', 'assistant', 'checking out'),
      step('tool_use', 'Bash', JSON.stringify({ command: `git checkout -b b${i}` })),
      step('tool_result', 'Bash', 'ok'),
      step('model_turn', 'assistant', 'committing now'),
      step('tool_use', 'Bash', JSON.stringify({ command: `git commit -m "m${i}"` })),
      step('tool_result', 'Bash', 'ok'),
      step('model_turn', 'assistant', 'pushing'),
      step('tool_use', 'Bash', JSON.stringify({ command: `git push origin b${i}` })),
      step('tool_result', 'Bash', 'ok'),
      step('model_turn', 'assistant', 'opening pr'),
      step('tool_use', 'Bash', JSON.stringify({ command: `gh pr create --title t${i}` })),
      step('tool_result', 'Bash', 'url'),
    ],
    costUsd: 1, models: [], usageByModel: {},
  } as Run;
}

/** Unique random-ish work — nothing repeats across runs. */
function chaosRun(runId: string, i: number): Run {
  const tools = [`tool_${i}_a`, `tool_${i}_b`, `tool_${i}_c`];
  return {
    runId, agentId: 'a',
    steps: [
      step('model_turn', 'user', `do unique thing ${i}`),
      ...tools.flatMap((t) => [
        step('tool_use', t, `{"x":${i}}`),
        step('tool_result', t, 'ok'),
      ]),
    ],
    costUsd: 1, models: [], usageByModel: {},
  } as Run;
}

describe('analyzePredictability', () => {
  it('finds the ritual: later steps of a fixed workflow are predictable, LOO', () => {
    const graphs = Array.from({ length: 10 }, (_, i) => buildRunGraph(ritualRun(`r${i}`, i)));
    const rep = analyzePredictability(graphs);
    expect(rep.transitions).toBe(40); // 4 decisions × 10 runs
    // commit|checkout, push|commit, pr|push are order≥1 certain; the opener is base-rate only.
    expect(rep.predictable).toBe(30);
    expect(rep.sharePredictable).toBeGreaterThan(0.7);
    expect(rep.mechanicalGlueUsd).toBeGreaterThan(0);
    const top = rep.topPredictable[0];
    expect(top.p).toBe(1);
    expect(top.support).toBeGreaterThanOrEqual(5);
  });

  it('claims nothing on chaos: unique work is never called predictable', () => {
    const graphs = Array.from({ length: 10 }, (_, i) => buildRunGraph(chaosRun(`c${i}`, i)));
    const rep = analyzePredictability(graphs);
    expect(rep.predictable).toBe(0);
    expect(rep.mechanicalGlueUsd).toBe(0);
  });

  it('leave-one-out: a workflow seen in only ONE run cannot predict itself', () => {
    const graphs = [
      ...Array.from({ length: 9 }, (_, i) => buildRunGraph(chaosRun(`c${i}`, i))),
      buildRunGraph(ritualRun('lone', 99)), // the ritual appears exactly once
    ];
    const rep = analyzePredictability(graphs);
    // With the ritual held out of its own training set, none of its steps are predictable.
    expect(rep.predictable).toBe(0);
  });

  it('order-0 base rates never count as predictable', () => {
    // Every run: a single, always-identical FIRST action (no prior context ever).
    const mono = (runId: string) => ({
      runId, agentId: 'a',
      steps: [
        step('model_turn', 'user', 'go'),
        step('tool_use', 'Read', '{"file_path":"/a"}'),
        step('tool_result', 'Read', 'ok'),
      ],
      costUsd: 1, models: [], usageByModel: {},
    }) as Run;
    const graphs = Array.from({ length: 10 }, (_, i) => buildRunGraph(mono(`m${i}`)));
    const rep = analyzePredictability(graphs);
    // p(read | ∅) = 1.0 at order 0 — but order-0 is base rate, not determinism.
    expect(rep.scored).toBeGreaterThan(0);
    expect(rep.predictable).toBe(0);
  });

  it('returns an all-zero report when too few runs for LOO', () => {
    const graphs = [buildRunGraph(ritualRun('x', 1)), buildRunGraph(ritualRun('y', 2))];
    const rep = analyzePredictability(graphs);
    expect(rep.transitions).toBe(0);
    expect(rep.mechanicalGlueUsd).toBe(0);
  });
});
