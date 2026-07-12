import { describe, expect, it } from 'vitest';
import {
  analyzeDeterminism,
  buildRunGraph,
  buildKnowledgeGraph,
  detectDrift,
  parseTranscript,
  replayToolSpec,
  synthesizeTools,
  tsKey,
  type RawStep,
  type Run,
} from '../src/index.js';
import { synthTranscript, type SynthRunSpec } from './helpers.js';

/**
 * Mirrors GET /api/v1/optimize's engine sequence exactly. The route wraps this
 * in a try/catch, but the CONTRACT is that the pipeline itself must never throw
 * on real-world run shapes — a single malformed run crashing analysis is the
 * bug that took the production endpoint down (unhandled 500 on a live agent).
 * These tests pin that contract so it can't silently regress.
 */
function runOptimizePipeline(runs: Run[]) {
  const graphs = runs.map(buildRunGraph);
  const analyses = analyzeDeterminism(graphs);
  const drift = detectDrift(graphs);
  const tools = synthesizeTools(analyses).map((spec) => {
    const analysis = analyses.find((a) => a.l1 === spec.clusterKey);
    return { ...spec, replay: analysis ? replayToolSpec(spec, analysis) : undefined };
  });
  const knowledge = buildKnowledgeGraph(analyses);
  return { analyses, drift, tools, knowledge };
}

/** Build a Run directly in the shape the DB/route produces (bypasses parsing). */
function mkRun(runId: string, steps: RawStep[], startedAt = '2026-07-01T10:00:00.000Z'): Run {
  return {
    runId,
    agentId: 'robustness-agent',
    startedAt,
    models: ['claude-sonnet-5'],
    usageByModel: {},
    costUsd: 0,
    steps,
  };
}
const step = (kind: RawStep['kind'], name: string, payload: string, extra: Partial<RawStep> = {}): RawStep =>
  ({ kind, name, payload, ...extra });

function deployCheckSpecs(n: number): SynthRunSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const svc = `billing-api-service-${String(i).padStart(2, '0')}`;
    return {
      sessionId: `deploy-${i}`,
      cwd: '/work/agents/deploy-check',
      prompt: 'Run the daily health check.',
      tools: [
        { name: 'Read', input: { file_path: '/app/config/service.json' }, result: `{"service":"${svc}","port":8443}` },
        { name: 'Bash', input: { command: `curl -s https://internal.example.com/health/${svc}` }, result: 'status: healthy' },
      ],
      finalText: `Service ${svc} is healthy.`,
      startedAt: `2026-07-0${(i % 5) + 1}T10:00:00.000Z`,
    };
  });
}
const runsOf = (specs: SynthRunSpec[]): Run[] =>
  specs.map((s) => {
    const r = parseTranscript(synthTranscript(s));
    if (!r) throw new Error(`fixture produced no run: ${s.sessionId}`);
    return r;
  });

describe('tsKey — Date-tolerant chronological sort key', () => {
  it('passes ISO strings through and normalizes Dates to the same key', () => {
    const iso = '2026-07-01T10:00:00.000Z';
    expect(tsKey(iso)).toBe(iso);
    expect(tsKey(new Date(iso))).toBe(iso);
    expect(tsKey(new Date(iso)).localeCompare(tsKey(iso))).toBe(0);
  });
  it('treats null/undefined/invalid as empty without throwing', () => {
    expect(tsKey(null)).toBe('');
    expect(tsKey(undefined)).toBe('');
    expect(() => tsKey('not-a-date')).not.toThrow();
  });
});

describe('optimize pipeline — happy path (exercises synthesis + replay)', () => {
  it('synthesizes at least one tool and runs replay over a clean compile-unit', () => {
    const { tools } = runOptimizePipeline(runsOf(deployCheckSpecs(12)));
    expect(tools.length).toBeGreaterThan(0);
    // replayToolSpec — the path with zero coverage in the optimize context —
    // must actually execute and produce a report.
    expect(tools[0].replay).toBeDefined();
    expect(tools[0].replay!.runsChecked).toBeGreaterThan(0);
  });
});

describe('optimize pipeline — robustness (must never throw)', () => {
  const cases: Record<string, () => Run[]> = {
    'two identical minimal runs': () => [
      mkRun('a', [step('model_turn', 'assistant', 'hello')]),
      mkRun('b', [step('model_turn', 'assistant', 'hello')]),
    ],
    'runs with empty-string payloads': () => [
      mkRun('a', [step('tool_use', 'Read', '', { toolUseId: 't1' }), step('tool_result', 'Read', '', { toolUseId: 't1' })]),
      mkRun('b', [step('tool_use', 'Read', '', { toolUseId: 't2' }), step('tool_result', 'Read', '', { toolUseId: 't2' })]),
    ],
    'derive path over NON-JSON tool output': () =>
      Array.from({ length: 12 }, (_, i) =>
        mkRun(`r${i}`, [
          step('tool_use', 'Read', JSON.stringify({ file: '/c.json' }), { toolUseId: `u${i}` }),
          // result looks parseable but is truncated/garbage — derive must not throw
          step('tool_result', 'Read', `{"svc":"s-${i}", TRUNCATED`, { toolUseId: `u${i}` }),
          step('tool_use', 'Bash', `curl https://h/s-${i}`, { toolUseId: `b${i}` }),
          step('tool_result', 'Bash', 'ok', { toolUseId: `b${i}` }),
        ], `2026-07-0${(i % 5) + 1}T10:00:00.000Z`),
      ),
    'heterogeneous shapes (no clean cluster)': () => [
      mkRun('a', [step('tool_use', 'Read', '{"x":1}', { toolUseId: 't1' }), step('tool_result', 'Read', 'a', { toolUseId: 't1' })]),
      mkRun('b', [step('thinking', 'thinking', 'hmm'), step('tool_use', 'Grep', 'foo', { toolUseId: 't2' })]),
      mkRun('c', [step('model_turn', 'assistant', 'x'), step('model_turn', 'assistant', 'y'), step('model_turn', 'assistant', 'z')]),
    ],
    // Regression: pg returns timestamp columns as Date objects, not ISO
    // strings. The engine sorts startedAt with localeCompare — a Date has none,
    // which crashed /optimize + /insights in production (the 19-run agent).
    'runs with Date startedAt (pg timestamp shape)': () =>
      Array.from({ length: 4 }, (_, i) => ({
        ...mkRun(`d${i}`, [
          step('tool_use', 'Read', `{"f":${i}}`, { toolUseId: `u${i}` }),
          step('tool_result', 'Read', `ok${i}`, { toolUseId: `u${i}` }),
        ]),
        // deliberate type violation the DB layer used to introduce:
        startedAt: new Date(Date.parse('2026-07-01T10:00:00Z') + i * 86_400_000) as unknown as string,
      })),
    'runs where every tool call errored': () =>
      Array.from({ length: 6 }, (_, i) =>
        mkRun(`e${i}`, [
          step('tool_use', 'Bash', `run ${i}`, { toolUseId: `u${i}` }),
          step('tool_result', 'Bash', 'command failed', { toolUseId: `u${i}`, isError: true }),
        ]),
      ),
    'huge + varied payloads': () =>
      Array.from({ length: 8 }, (_, i) =>
        mkRun(`h${i}`, [
          step('tool_use', 'Read', `{"path":"/f${i}"}`, { toolUseId: `u${i}` }),
          step('tool_result', 'Read', 'X'.repeat(20000) + i, { toolUseId: `u${i}` }),
        ]),
      ),
    'insertions: retries of varying length': () => [
      ...runsOf(deployCheckSpecs(6)),
      mkRun('retry', [
        step('tool_use', 'Read', '{"file_path":"/app/config/service.json"}', { toolUseId: 'x1' }),
        step('tool_result', 'Read', '{"service":"svc","port":8443}', { toolUseId: 'x1' }),
        step('tool_use', 'Bash', 'retry once', { toolUseId: 'x2' }),
        step('tool_result', 'Bash', 'transient', { toolUseId: 'x2', isError: true }),
        step('tool_use', 'Bash', 'curl -s https://internal.example.com/health/svc', { toolUseId: 'x3' }),
        step('tool_result', 'Bash', 'status: healthy', { toolUseId: 'x3' }),
      ]),
    ],
  };

  for (const [name, build] of Object.entries(cases)) {
    it(name, () => {
      expect(() => runOptimizePipeline(build())).not.toThrow();
    });
  }
});
