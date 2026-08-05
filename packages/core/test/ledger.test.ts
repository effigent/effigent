import { describe, it, expect } from 'vitest';
import type { Run, RawStep } from '../src/types.js';
import { buildRunGraph } from '../src/graph.js';
import { computeRunLedger, aggregateLedgers } from '../src/ledger.js';

/**
 * Ground-truth tests: every run below is CONSTRUCTED so the correct ledger is
 * known by design, not fitted to any agent's real traffic.
 */

let seq = 0;
const uid = () => `tu_${++seq}`;

/** A big tool result with trackable distinctive content. */
function bigResult(marker: string, sizeChars = 4000): string {
  const distinct = Array.from({ length: 30 }, (_, i) => `${marker}_token_${i}`).join(' ');
  return distinct + ' filler '.repeat(Math.ceil((sizeChars - distinct.length) / 8));
}

interface StepSpec {
  kind: RawStep['kind'];
  name?: string;
  payload?: string;
  isError?: boolean;
  withUsage?: { input?: number; cacheRead?: number; cacheCreation?: number; model?: string };
}

function makeRun(specs: StepSpec[], runId = `run-${++seq}`): Run {
  const steps: RawStep[] = [];
  let pendingToolUse: string | null = null;
  for (const s of specs) {
    const step: RawStep = {
      kind: s.kind,
      name: s.name ?? (s.kind === 'model_turn' ? 'assistant' : s.kind === 'thinking' ? 'assistant' : 'Read'),
      payload: s.payload ?? 'x',
      isError: s.isError,
    };
    if (s.kind === 'tool_use') { pendingToolUse = uid(); step.toolUseId = pendingToolUse; }
    if (s.kind === 'tool_result') { step.toolUseId = pendingToolUse ?? undefined; pendingToolUse = null; }
    if (s.withUsage) {
      step.model = s.withUsage.model ?? 'claude-sonnet-4';
      step.tokens = {
        input: s.withUsage.input ?? 1000,
        output: 100,
        cacheRead: s.withUsage.cacheRead ?? 0,
        cacheCreation: s.withUsage.cacheCreation ?? 0,
      };
    }
    steps.push(step);
  }
  return {
    runId,
    agentId: 'test-agent',
    steps,
    costUsd: 1,
    models: ['claude-sonnet-4'],
    usageByModel: {},
  } as Run;
}

const assistantTurn = (payload: string, usage?: StepSpec['withUsage']): StepSpec => ({
  kind: 'model_turn', name: 'assistant', payload, ...(usage ? { withUsage: usage } : {}),
});

describe('dead-context detector', () => {
  it('flags a big result never referenced again, and prices only calls after the first look', () => {
    const run = makeRun([
      assistantTurn('start'),
      { kind: 'tool_use', name: 'Read', payload: '{"file_path":"/a.ts"}' },
      { kind: 'tool_result', name: 'Read', payload: bigResult('alpha') },
      assistantTurn('ok moving on', {}),            // first look — NOT waste
      assistantTurn('unrelated step one', {}),      // dead carry 1
      assistantTurn('unrelated step two', {}),      // dead carry 2
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.carriage.findings).toHaveLength(1);
    const f = ledger.carriage.findings[0];
    expect(f.lastReferencedAt).toBeNull();
    expect(f.deadCalls).toBe(2);
    expect(f.wastedUsd).toBeGreaterThan(0);
  });

  it('claims nothing when the result is referenced by the final step', () => {
    const run = makeRun([
      assistantTurn('start'),
      { kind: 'tool_use', name: 'Read', payload: '{"file_path":"/a.ts"}' },
      { kind: 'tool_result', name: 'Read', payload: bigResult('beta') },
      assistantTurn('thinking about it', {}),
      assistantTurn('so beta_token_1 and beta_token_2 imply the fix', {}), // referenced here — last step
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.carriage.deadUsd).toBe(0);
  });

  it('ignores small results entirely', () => {
    const run = makeRun([
      assistantTurn('start'),
      { kind: 'tool_use', name: 'Read', payload: '{"file_path":"/a.ts"}' },
      { kind: 'tool_result', name: 'Read', payload: 'tiny result' },
      assistantTurn('a', {}), assistantTurn('b', {}), assistantTurn('c', {}),
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.carriage.findings).toHaveLength(0);
  });

  it('treats low-distinctive-content results as always useful (conservative)', () => {
    const run = makeRun([
      assistantTurn('start'),
      { kind: 'tool_use', name: 'Bash', payload: '{"command":"yes"}' },
      { kind: 'tool_result', name: 'Bash', payload: 'y '.repeat(3000) }, // big but no distinctive tokens
      assistantTurn('a', {}), assistantTurn('b', {}), assistantTurn('c', {}),
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.carriage.deadUsd).toBe(0);
  });
});

describe('cache-miss detector', () => {
  it('reports zero misses for a perfectly cached chain', () => {
    const run = makeRun([
      assistantTurn('a', { input: 1000, cacheRead: 0 }),
      assistantTurn('b', { input: 100, cacheRead: 1000 }),
      assistantTurn('c', { input: 100, cacheRead: 1100 }),
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.cache.missedReadTokens).toBe(0);
    expect(ledger.cache.apparentlyDisabled).toBe(false);
  });

  it('measures the miss when caching is off, and flags it', () => {
    const run = makeRun([
      assistantTurn('a', { input: 1000 }),
      assistantTurn('b', { input: 1100 }),
      assistantTurn('c', { input: 1200 }),
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    // request 2 could have read 1000, request 3 could have read 1100
    expect(ledger.cache.missedReadTokens).toBe(2100);
    expect(ledger.cache.apparentlyDisabled).toBe(true);
    expect(ledger.cache.missedUsd).toBeGreaterThan(0);
  });

  it('does not blame a model switch for a cold prompt', () => {
    const run = makeRun([
      assistantTurn('a', { input: 1000, model: 'claude-sonnet-4' }),
      assistantTurn('b', { input: 1000, model: 'claude-haiku-4' }),
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.cache.missedReadTokens).toBe(0);
  });
});

describe('error-loop detector', () => {
  it('attributes the recovery tail up to the same tool succeeding', () => {
    const run = makeRun([
      assistantTurn('start'),
      { kind: 'tool_use', name: 'Bash', payload: '{"command":"npm test"}' },
      { kind: 'tool_result', name: 'Bash', payload: 'FAIL everything broke', isError: true },
      assistantTurn('let me fix that', {}),
      { kind: 'tool_use', name: 'Bash', payload: '{"command":"npm test -- --fix"}' },
      { kind: 'tool_result', name: 'Bash', payload: 'PASS' },
      assistantTurn('done', {}),
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.errors.count).toBe(1);
    expect(ledger.errors.loops[0].recoverySteps).toBeGreaterThanOrEqual(3);
    expect(ledger.errors.recoveryUsd).toBeGreaterThan(0);
  });

  it('never double-counts overlapping recoveries of consecutive errors', () => {
    const run = makeRun([
      assistantTurn('start'),
      { kind: 'tool_use', name: 'Bash', payload: '{"command":"a"}' },
      { kind: 'tool_result', name: 'Bash', payload: 'err one', isError: true },
      { kind: 'tool_use', name: 'Bash', payload: '{"command":"b"}' },
      { kind: 'tool_result', name: 'Bash', payload: 'err two', isError: true },
      assistantTurn('fixing', {}),
      { kind: 'tool_use', name: 'Bash', payload: '{"command":"c"}' },
      { kind: 'tool_result', name: 'Bash', payload: 'ok' },
    ]);
    const graph = buildRunGraph(run);
    const ledger = computeRunLedger(run, graph);
    expect(ledger.errors.count).toBe(2);
    // Sum of loop costs must not exceed the run's whole cost (each step counted once).
    expect(ledger.errors.recoveryUsd).toBeLessThanOrEqual(graph.costUsd);
  });

  it('reports zero on an error-free run', () => {
    const run = makeRun([
      assistantTurn('start'),
      { kind: 'tool_use', name: 'Read', payload: '{"file_path":"/a"}' },
      { kind: 'tool_result', name: 'Read', payload: 'fine' },
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.errors.count).toBe(0);
    expect(ledger.errors.recoveryUsd).toBe(0);
  });
});

describe('redundant-call detector', () => {
  it('flags an identical read-only call with an identical answer', () => {
    const read = { kind: 'tool_use' as const, name: 'Read', payload: '{"file_path":"/same.ts"}' };
    const answer = { kind: 'tool_result' as const, name: 'Read', payload: 'the same content both times' };
    const run = makeRun([
      assistantTurn('start'),
      { ...read }, { ...answer },
      assistantTurn('later…', {}),
      { ...read }, { ...answer },
      assistantTurn('done', {}),
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.redundant.calls).toHaveLength(1);
    expect(ledger.redundant.calls[0].occurrences).toBe(2);
    expect(ledger.redundant.wastedUsd).toBeGreaterThan(0);
  });

  it('does NOT flag a repeat whose answer changed (the world moved)', () => {
    const read = { kind: 'tool_use' as const, name: 'Read', payload: '{"file_path":"/same.ts"}' };
    const run = makeRun([
      assistantTurn('start'),
      { ...read }, { kind: 'tool_result', name: 'Read', payload: 'version one' },
      assistantTurn('edit happened', {}),
      { ...read }, { kind: 'tool_result', name: 'Read', payload: 'version two — changed' },
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.redundant.calls).toHaveLength(0);
  });

  it('does NOT flag repeated side-effect tools even with identical payloads', () => {
    const cmd = { kind: 'tool_use' as const, name: 'Edit', payload: '{"file_path":"/a","old_string":"x","new_string":"y"}' };
    const run = makeRun([
      assistantTurn('start'),
      { ...cmd }, { kind: 'tool_result', name: 'Edit', payload: 'ok' },
      { ...cmd }, { kind: 'tool_result', name: 'Edit', payload: 'ok' },
    ]);
    const ledger = computeRunLedger(run, buildRunGraph(run));
    expect(ledger.redundant.calls).toHaveLength(0);
  });
});

describe('invariants & aggregation', () => {
  it('clamps every slice to the run cost and aggregates across runs', () => {
    const run = makeRun([
      assistantTurn('start', { input: 500 }),
      { kind: 'tool_use', name: 'Read', payload: '{"file_path":"/a.ts"}' },
      { kind: 'tool_result', name: 'Read', payload: bigResult('gamma') },
      assistantTurn('a', { input: 2000 }),
      assistantTurn('b', { input: 2500 }),
      assistantTurn('c', { input: 3000 }),
    ]);
    const graph = buildRunGraph(run);
    const l = computeRunLedger(run, graph);
    for (const v of [l.carriage.deadUsd, l.carriage.carriedUsd, l.cache.missedUsd, l.errors.recoveryUsd, l.redundant.wastedUsd]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(graph.costUsd + 1e-9);
    }
    const agg = aggregateLedgers([l, l]);
    expect(agg.runCount).toBe(2);
    expect(agg.slices.deadContextUsd).toBeCloseTo(l.carriage.deadUsd * 2, 10);
    expect(agg.topDeadContext[0]?.runId).toBe(l.runId);
  });

  it('returns an all-zero ledger for a run with no usage data (never NaN)', () => {
    const run = makeRun([
      { kind: 'model_turn', name: 'user', payload: 'hello' },
      assistantTurn('hi'),
    ]);
    const l = computeRunLedger(run, buildRunGraph(run));
    expect(l.effInputPricePerTok).toBe(0);
    expect(Number.isNaN(l.cache.hitRate)).toBe(false);
    expect(l.carriage.deadUsd).toBe(0);
  });
});
