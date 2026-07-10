import { describe, expect, it } from 'vitest';
import {
  buildRunGraph,
  cosineSim,
  detectDrift,
  embedRunGraph,
  otelToRuns,
  parseTranscript,
  runSimilarity,
  type OtlpTracesPayload,
  type Run,
} from '../src/index.js';
import { synthTranscript, type SynthRunSpec } from './helpers.js';

function runsOf(specs: SynthRunSpec[]): Run[] {
  return specs.map((s) => {
    const run = parseTranscript(synthTranscript(s));
    if (!run) throw new Error(`fixture produced no run: ${s.sessionId}`);
    return run;
  });
}

/** Shape A: Read config → curl health (the deploy-check procedure). */
function shapeA(i: number, startedAt: string): SynthRunSpec {
  const svc = `billing-api-service-${String(i).padStart(2, '0')}`;
  return {
    sessionId: `a-${i}`,
    cwd: '/work/agents/drift-agent',
    prompt: 'Run the daily health check.',
    tools: [
      { name: 'Read', input: { file_path: '/app/config/service.json' }, result: `{"service":"${svc}"}` },
      { name: 'Bash', input: { command: `curl -s https://internal.example.com/health/${svc}` }, result: 'status: healthy' },
    ],
    finalText: `Service ${svc} is healthy.`,
    startedAt,
  };
}

/** Shape B: a rewritten agent — different tools, different procedure. */
function shapeB(i: number, startedAt: string): SynthRunSpec {
  return {
    sessionId: `b-${i}`,
    cwd: '/work/agents/drift-agent',
    prompt: 'Run the daily health check.',
    tools: [
      { name: 'Grep', input: { pattern: 'service_name', path: '/app/config' }, result: `config.yaml: service_name: svc-${i}` },
      { name: 'WebFetch', input: { url: `https://status.example.com/api/v2/components/svc-${i}` }, result: '{"status":"operational"}' },
      { name: 'Write', input: { file_path: `/tmp/health-${i}.log`, content: 'operational' }, result: 'File created' },
    ],
    finalText: 'Logged component status.',
    startedAt,
  };
}

const at = (h: number) => `2026-07-01T${String(h).padStart(2, '0')}:00:00.000Z`;

describe('run embeddings', () => {
  it('identical procedures embed identically; retries stay closer than rewrites', () => {
    const [a1, a2] = runsOf([shapeA(1, at(1)), shapeA(2, at(2))]).map(buildRunGraph);
    expect(cosineSim(embedRunGraph(a1), embedRunGraph(a2))).toBeCloseTo(1, 6);

    const retrySpec = {
      ...shapeA(3, at(3)),
      sessionId: 'a-retry',
      tools: [
        shapeA(3, at(3)).tools[0],
        { name: 'Bash', input: { command: 'curl -s https://internal.example.com/health/x' }, result: 'timeout', isError: true },
        ...shapeA(3, at(3)).tools.slice(1),
      ],
    };
    const [retry] = runsOf([retrySpec]).map(buildRunGraph);
    const [b] = runsOf([shapeB(1, at(4))]).map(buildRunGraph);

    const simRetry = cosineSim(embedRunGraph(a1), embedRunGraph(retry));
    const simB = cosineSim(embedRunGraph(a1), embedRunGraph(b));
    expect(simRetry).toBeGreaterThan(simB);
    // Embedding distance agrees with the clusterer's similarity ordering.
    expect(runSimilarity(a1, retry).combined).toBeGreaterThan(runSimilarity(a1, b).combined);
  });
});

describe('drift detection (has the agent changed?)', () => {
  it('stable agent with varying inputs → no drift', () => {
    const graphs = runsOf(Array.from({ length: 15 }, (_, i) => shapeA(i, at(i)))).map(buildRunGraph);
    const report = detectDrift(graphs);
    expect(report).not.toBeNull();
    expect(report!.changed).toBe(false);
  });

  it('rewritten agent → drift flagged at the first new-shape run', () => {
    const specs = [
      ...Array.from({ length: 10 }, (_, i) => shapeA(i, at(i))),
      ...Array.from({ length: 5 }, (_, i) => shapeB(i, at(10 + i))),
    ];
    const graphs = runsOf(specs).map(buildRunGraph);
    const report = detectDrift(graphs);
    expect(report).not.toBeNull();
    expect(report!.changed).toBe(true);
    expect(report!.z).toBeGreaterThan(3);
    expect(report!.changedRunId).toBe('b-0');
    expect(report!.changedAt).toBe(at(10));
  });

  it('too little history → null (no verdict, not a false negative)', () => {
    const graphs = runsOf(Array.from({ length: 4 }, (_, i) => shapeA(i, at(i)))).map(buildRunGraph);
    expect(detectDrift(graphs)).toBeNull();
  });
});

describe('OTLP tool capture (OpenLLMetry attrs)', () => {
  it('captures tool args + SUCCESS outputs and per-step LLM usage', () => {
    const payload: OtlpTracesPayload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'py-agent' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't1',
                  name: 'chat gpt-4o',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  attributes: [
                    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                    { key: 'gen_ai.response.model', value: { stringValue: 'gpt-4o' } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: 1000 } },
                    { key: 'gen_ai.usage.output_tokens', value: { intValue: 200 } },
                    { key: 'gen_ai.completion', value: { stringValue: 'let me search the kb' } },
                  ],
                },
                {
                  traceId: 't1',
                  name: 'search_kb.tool',
                  startTimeUnixNano: '2000000000',
                  endTimeUnixNano: '2500000000',
                  attributes: [
                    { key: 'gen_ai.tool.name', value: { stringValue: 'search_kb' } },
                    { key: 'traceloop.entity.input', value: { stringValue: '{"query":"refund policy"}' } },
                    { key: 'traceloop.entity.output', value: { stringValue: 'Refunds allowed within 30 days.' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const runs = otelToRuns(payload);
    expect(runs).toHaveLength(1);
    const steps = runs[0].steps;
    expect(steps.map((s) => s.kind)).toEqual(['model_turn', 'tool_use', 'tool_result']);
    expect(steps[1].payload).toBe('{"query":"refund policy"}');
    expect(steps[2].payload).toBe('Refunds allowed within 30 days.');
    expect(steps[2].isError).toBeFalsy();
    expect(steps[0].model).toBe('gpt-4o');
    expect(steps[0].tokens).toMatchObject({ input: 1000, output: 200 });
    expect(steps[0].durationMs).toBe(1000);
    expect(runs[0].agentId).toBe('py-agent');
  });
});
