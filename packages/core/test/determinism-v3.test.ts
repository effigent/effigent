import { describe, expect, it } from 'vitest';
import {
  analyzeDeterminism,
  buildRunGraph,
  clusterBySimilarity,
  columnTemplate,
  parseTranscript,
  replayToolSpec,
  runSimilarity,
  synthesizeTools,
  tokenize,
  wilsonLower,
  type Run,
  type ToolSpec,
} from '../src/index.js';
import { synthTranscript, type SynthRunSpec } from './helpers.js';

function runsOf(specs: SynthRunSpec[]): Run[] {
  return specs.map((s) => {
    const run = parseTranscript(synthTranscript(s));
    if (!run) throw new Error(`fixture produced no run: ${s.sessionId}`);
    return run;
  });
}

/** Fixture A — "deploy-check": constant Read, Bash arg DERIVED from the Read's
 *  JSON output, constant final check. The clean compile-unit case. */
function deployCheckSpecs(n: number): SynthRunSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const svc = `billing-api-service-${String(i).padStart(2, '0')}`;
    return {
      sessionId: `deploy-${i}`,
      cwd: '/work/agents/deploy-check',
      prompt: 'Run the daily health check.',
      tools: [
        {
          name: 'Read',
          input: { file_path: '/app/config/service.json' },
          result: `{"service":"${svc}","port":8443}`,
        },
        {
          name: 'Bash',
          input: { command: `curl -s https://internal.example.com/health/${svc}` },
          result: 'status: healthy',
        },
      ],
      finalText: `Service ${svc} is healthy.`,
      startedAt: `2026-07-0${(i % 5) + 1}T10:00:00.000Z`,
    };
  });
}

describe('tokenize', () => {
  it('preserves the input exactly and splits compact JSON', () => {
    const s = '{"url":"https://api.example.com/data?page=3","limit":20}';
    expect(tokenize(s).join('')).toBe(s);
    expect(tokenize(s).length).toBeGreaterThan(3);
  });

  it('columnTemplate finds slots inside compact JSON payloads', () => {
    const t = columnTemplate([
      '{"a":"x-value-1","b":"const"}',
      '{"a":"x-value-2","b":"const"}',
      '{"a":"x-value-3","b":"const"}',
    ]);
    expect(t).not.toBeNull();
    expect(t!.slots).toBe(1);
    expect(t!.template).toContain('⟨·⟩');
    expect(t!.slotValues[0]).toEqual(['x-value-1']);
  });
});

describe('alignment clustering (v3 stage 1–2)', () => {
  it('identical-shape runs have similarity 1', () => {
    const [a, b] = runsOf(deployCheckSpecs(2)).map(buildRunGraph);
    expect(runSimilarity(a, b).combined).toBeCloseTo(1, 5);
  });

  it('clusters runs WITH an inserted retry into the same cluster (v2 split them)', () => {
    const base = deployCheckSpecs(6);
    const retries: SynthRunSpec[] = deployCheckSpecs(3).map((s, i) => ({
      ...s,
      sessionId: `deploy-retry-${i}`,
      tools: [
        s.tools[0],
        { name: 'Bash', input: { command: 'curl -s https://internal.example.com/health/x' }, result: 'timeout', isError: true },
        ...s.tools.slice(1),
      ],
    }));
    const graphs = runsOf([...base, ...retries]).map(buildRunGraph);

    // Exact-shape grouping would see 2 distinct L1s…
    expect(new Set(graphs.map((g) => g.l1)).size).toBe(2);
    // …but alignment clustering sees one procedure.
    const clusters = clusterBySimilarity(graphs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].runs).toHaveLength(9);

    // And every run — including the retry variants — supports the Read column.
    const analyses = analyzeDeterminism(graphs);
    expect(analyses).toHaveLength(1);
    const readUse = analyses[0].nodes.find((n) => n.structLabel.startsWith('tool:Read'));
    expect(readUse?.support).toBe(9);
    expect(analyses[0].insertionRate).toBeGreaterThan(0);
  });
});

describe('determinism lattice (v3 stage 3)', () => {
  const analyses = analyzeDeterminism(runsOf(deployCheckSpecs(12)).map(buildRunGraph));
  const nodes = analyses[0].nodes;

  it('D0: a constant tool call compiles; a constant result is replaceable', () => {
    const readUse = nodes.find((n) => n.structLabel.startsWith('tool:Read'));
    expect(readUse?.level).toBe('D0');
    expect(readUse?.action).toBe('compile');

    const bashResult = nodes.find((n) => n.structLabel === 'result:Bash:ok');
    expect(bashResult?.level).toBe('D0');
    expect(bashResult?.action).toBe('replace');
  });

  it('D1: a templated call with a provenance-derived slot compiles', () => {
    const bashUse = nodes.find((n) => n.structLabel.startsWith('tool:Bash'));
    expect(bashUse?.action).toBe('compile');
    expect(bashUse?.level).toBe('D1');
    expect(bashUse?.template).toContain('⟨·⟩');
    expect(bashUse?.provenance?.[0].kind).toBe('derived');
    expect(bashUse?.provenance?.[0].method).toBe('json:service');
  });

  it('scores on RAW values: numeric variation is not determinism', () => {
    const specs = Array.from({ length: 8 }, (_, i) => ({
      sessionId: `rows-${i}`,
      cwd: '/work/agents/rows-agent',
      prompt: 'Count the rows.',
      tools: [
        { name: 'Bash', input: { command: 'wc -l /data/table.csv' }, result: `processed ${i * 7 + 3} rows` },
      ],
      finalText: 'Done.',
    }));
    const a = analyzeDeterminism(runsOf(specs).map(buildRunGraph));
    const result = a[0].nodes.find((n) => n.structLabel === 'result:Bash:ok');
    // canonicalValue would be 'processed <NUM> rows' — identical, falsely 100.
    expect(result?.action).not.toBe('replace');
    expect(result?.score).toBeLessThan(90);
  });

  it('gates every action on confidence: 2 runs fire nothing', () => {
    const specs = deployCheckSpecs(2);
    const a = analyzeDeterminism(runsOf(specs).map(buildRunGraph));
    const bashUse = a[0].nodes.find((n) => n.structLabel.startsWith('tool:Bash'));
    // Template stability is high, but Wilson(2,2)=0.34 < 0.5 — keep.
    expect(bashUse?.action).toBe('keep');
  });

  it('memoize confidence uses the HONEST evidence size, not the run count', () => {
    // 8 runs over 4 urls: u1×3, u2×3, u3, u4 — evidence = 6 pairs in
    // multi-sample groups. Honest Wilson(6,6)=61; run-count Wilson(8,8)=68.
    const urls = ['u-alpha', 'u-alpha', 'u-alpha', 'u-beta', 'u-beta', 'u-beta', 'u-gamma', 'u-delta'];
    const specs = urls.map((u, i) => ({
      sessionId: `fetch-${i}`,
      cwd: '/work/agents/fetcher',
      prompt: `Fetch https://api.example.com/data/${u} and summarize.`,
      tools: [
        {
          name: 'WebFetch',
          input: { url: `https://api.example.com/data/${u}` },
          result: `payload-for-${u}`,
        },
      ],
      finalText: 'Summarized.',
    }));
    const a = analyzeDeterminism(runsOf(specs).map(buildRunGraph));
    const result = a[0].nodes.find((n) => n.structLabel === 'result:WebFetch:ok');
    expect(result?.action).toBe('memoize');
    expect(result?.confidence).toBe(Math.round(wilsonLower(6, 6) * 100)); // 61
    expect(result?.confidence).not.toBe(Math.round(wilsonLower(8, 8) * 100)); // NOT 68
  });
});

describe('tool synthesis + replay (v3 stages 4–6)', () => {
  const graphs = runsOf(deployCheckSpecs(12)).map(buildRunGraph);
  const analyses = analyzeDeterminism(graphs);
  const specs = synthesizeTools(analyses);

  it('emits a ToolSpec for the compile unit with a derived substitution', () => {
    expect(specs.length).toBeGreaterThanOrEqual(1);
    const spec = specs[0];
    expect(spec.agentId).toBe('deploy-check');
    expect(spec.body.map((b) => b.tool)).toEqual(['Read', 'Bash']);
    const bash = spec.body[1];
    expect(bash.argTemplate).toContain('${derive(c2.json:service)}');
    expect(bash.substitutions[0]).toMatchObject({ kind: 'derive', sourceColumn: 2, method: 'json:service' });
    expect(spec.postcondition).toBe('status: healthy');
    expect(spec.savings.perRunUsd).toBeGreaterThan(0);
    expect(spec.separability).not.toBe('entangled');
  });

  it('replay validates the spec against every mined run → ready', () => {
    const report = replayToolSpec(specs[0], analyses[0]);
    expect(report.runsChecked).toBe(12);
    expect(report.passRate).toBe(1);
    expect(report.status).toBe('ready');
  });

  it('replay catches a wrong derivation → shadow', () => {
    const corrupted: ToolSpec = JSON.parse(JSON.stringify(specs[0]));
    const bash = corrupted.body[1];
    bash.substitutions[0] = { ...bash.substitutions[0], method: 'json:port' };
    const report = replayToolSpec(corrupted, analyses[0]);
    expect(report.passRate).toBe(0);
    expect(report.status).toBe('shadow');
    expect(report.failures[0]?.reason).toBe('arg-derive');
  });

  it('ToolSpec ids are stable across windows (same unit ⇒ same id)', () => {
    const again = synthesizeTools(analyzeDeterminism(runsOf(deployCheckSpecs(9)).map(buildRunGraph)));
    expect(again[0]?.id).toBe(specs[0].id);
  });
});

describe('per-step usage attribution', () => {
  it('attaches model+tokens once per request; node costs sum to the run cost', () => {
    const run = runsOf(deployCheckSpecs(1))[0];
    const withTokens = run.steps.filter((s) => s.tokens);
    // One usage record per API request (2 tool calls + final text = 3).
    expect(withTokens).toHaveLength(3);
    expect(run.steps.filter((s) => s.kind === 'tool_use').every((s) => s.model)).toBe(true);

    const g = buildRunGraph(run);
    const nodeSum = g.nodes.reduce((s, n) => s + n.costUsd, 0);
    expect(nodeSum).toBeCloseTo(run.costUsd, 10);
    expect(nodeSum).toBeGreaterThan(0);
  });
});
