import { describe, expect, it } from 'vitest';
import { computeRentLedger, recommendCompaction, simulateCompaction } from '../src/rent.js';
import type { RawStep, Run } from '../src/types.js';

/**
 * A synthetic agent loop with a PERFECT cache: request k reads everything
 * request k−1 had, writes only what is new. `deposits[k]` = tokens entering
 * context after request k; `resetAt` collapses context to the base.
 */
function loop(n: number, opts: { base?: number; deposit?: (k: number) => number; resetAt?: number[]; model?: string; toolChars?: number } = {}): Run {
  const base = opts.base ?? 50_000;
  const model = opts.model ?? 'claude-opus-5';
  const steps: RawStep[] = [];
  let ctx = base;
  let prev = 0;
  for (let k = 0; k < n; k++) {
    if (opts.resetAt?.includes(k)) ctx = base;
    const read = k === 0 || opts.resetAt?.includes(k) ? 0 : prev;
    steps.push({
      kind: 'tool_use', name: 'Bash', payload: '{"command":"ls"}', toolUseId: `t${k}`, model,
      tokens: { input: 0, output: 100, cacheCreation: ctx - read, cacheCreation1h: ctx - read, cacheRead: read, context: ctx },
    });
    steps.push({ kind: 'tool_result', name: 'Bash', payload: 'x'.repeat(opts.toolChars ?? 3200), toolUseId: `t${k}` });
    prev = ctx;
    ctx += opts.deposit?.(k) ?? 1_100;
  }
  const run: Run = { runId: 'r', agentId: 'a', models: [model], usageByModel: {}, costUsd: 0, steps };
  // run cost = sum of per-request costs (no side models)
  run.costUsd = computeRentLedger({ ...run, costUsd: 0 }).spend.cacheReadUsd +
    computeRentLedger({ ...run, costUsd: 0 }).spend.cacheWriteUsd +
    computeRentLedger({ ...run, costUsd: 0 }).spend.outputUsd;
  return run;
}

describe('computeRentLedger — the identity', () => {
  it('rent + base reproduces cache-read spend exactly on a clean loop', () => {
    const l = computeRentLedger(loop(60));
    expect(l.calibration).toBeCloseTo(1, 6);
    expect(l.spend.sideModelUsd).toBeCloseTo(0, 9);
  });

  it('a deposit pays rent for exactly the requests that re-read it', () => {
    // one 10k deposit after request 0 in a 5-request loop → re-read by requests 2,3,4
    const l = computeRentLedger(loop(5, { deposit: (k) => (k === 0 ? 10_000 : 0) }));
    const read = (5 * 0.1) / 1e6; // opus-5 cache read per token
    const big = l.topDeposits[0];
    expect(big.afterRequest).toBe(0);
    expect(big.carriedFor).toBe(3);
    expect(l.rent.byKind.output + l.rent.byKind.tool_result + l.rent.byKind.harness).toBeCloseTo(10_000 * 3 * read, 9);
  });

  it('stops charging rent at a reset, and counts the new base', () => {
    const l = computeRentLedger(loop(40, { resetAt: [20], deposit: () => 5_000 }));
    expect(l.resets).toBe(1);
    expect(l.calibration).toBeCloseTo(1, 6);
  });

  it('splits a deposit: generated tokens exactly, tool output by chars, remainder to harness', () => {
    // output 100 tokens, tool result 3200 chars ≈ 1000 tokens → of an 1,100-token deposit, harness = 0
    const l = computeRentLedger(loop(10));
    expect(l.rent.byKind.harness).toBeCloseTo(0, 9);
    expect(l.rent.byTool.Bash).toBeGreaterThan(0);
    expect(l.rent.byKind.output / l.rent.byKind.tool_result).toBeCloseTo(100 / 1000, 6);
  });
});

describe('simulateCompaction — the counterfactual', () => {
  it('reproduces observed cost at the observed policy (no threshold)', () => {
    const run = loop(200);
    expect(simulateCompaction(run, Infinity).costUsd / run.costUsd).toBeCloseTo(1, 2);
  });

  it('saves on a long, heavy session and loses on a short one', () => {
    const long = loop(600, { deposit: () => 1_500 }); // grows to ~950k
    const s = simulateCompaction(long, 300_000);
    expect(s.compactions).toBeGreaterThan(0);
    expect(s.costUsd).toBeLessThan(long.costUsd);

    const short = loop(30);
    expect(simulateCompaction(short, 60_000).costUsd).toBeGreaterThan(short.costUsd);
  });

  it('recommends nothing when no threshold saves money in every scenario', () => {
    const rec = recommendCompaction([loop(20), loop(25)]);
    expect(rec.threshold).toBeNull();
    expect(rec.savingsUsd).toEqual([]);
  });

  it('recommends a threshold only when its WORST-case savings are positive', () => {
    const rec = recommendCompaction([loop(900, { deposit: () => 1_200 })]);
    expect(rec.threshold).not.toBeNull();
    expect(Math.min(...rec.savingsUsd.map((s) => s.usd))).toBeGreaterThan(0);
  });
});

describe('context series + skyline', () => {
  it('composition tracks deposits and restarts at a reset', async () => {
    const { contextSkylineSvg } = await import('../src/graph-svg.js');
    const l = computeRentLedger(loop(30, { resetAt: [15], deposit: () => 5_000 }), { series: true });
    const s = l.series!;
    expect(s).toHaveLength(30);
    expect(s[14].kinds.output + s[14].kinds.tool_result + s[14].kinds.harness).toBeGreaterThan(0);
    expect(s[15].reset).toBe(true);
    expect(Object.values(s[15].kinds).every((v) => v === 0)).toBe(true);
    // base + deposits = measured context (the 100-token output + 1,000 tool + remainder)
    const k = s[10];
    expect(k.base + Object.values(k.kinds).reduce((a, b) => a + b, 0)).toBeCloseTo(k.context, 0);
    const svg = contextSkylineSvg(s, { threshold: 60_000 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('compaction / reset');
  });
});

describe('isReadOnlyCall', () => {
  it('reads through cd prefixes, rejects in-place edits and redirects', async () => {
    const { isReadOnlyCall } = await import('../src/actions.js');
    const bash = (command: string) => ({ kind: 'tool_use' as const, name: 'Bash', payload: JSON.stringify({ command }) });
    expect(isReadOnlyCall(bash('cd /repo && sed -n 1,80p src/a.ts | head -40'))).toBe(true);
    expect(isReadOnlyCall(bash('git log --oneline -5 && git status --short'))).toBe(true);
    expect(isReadOnlyCall(bash("sed -i 's/a/b/' f.ts"))).toBe(false);
    expect(isReadOnlyCall(bash('cat a > b'))).toBe(false);
    expect(isReadOnlyCall(bash('npm run build'))).toBe(false);
    expect(isReadOnlyCall({ kind: 'tool_use', name: 'Read', payload: '{"file_path":"/a"}' })).toBe(true);
  });
});
