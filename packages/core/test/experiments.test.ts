import { describe, expect, it } from 'vitest';
import { measureEffect } from '../src/experiments.js';
import { requestsOf } from '../src/rent.js';
import type { RawStep, Run } from '../src/types.js';

/** A session of n requests; context grows by d per request, optionally capped (compaction) at `cap`. */
function session(id: string, day: number, n: number, opts: { d?: number; base?: number; cap?: number; errors?: number } = {}): Run {
  const base = opts.base ?? 60_000, d = opts.d ?? 2_000;
  const steps: RawStep[] = [];
  let ctx = base, prev = 0;
  for (let k = 0; k < n; k++) {
    if (opts.cap && ctx > opts.cap) { ctx = base + 15_000; prev = 0; }
    const read = prev && ctx > prev ? prev : 0;
    steps.push({ kind: 'tool_use', name: 'Edit', payload: '{"file_path":"/r/a.ts"}', toolUseId: `${id}-${k}`, model: 'claude-opus-5',
      tokens: { input: 0, output: 120, cacheCreation: ctx - read, cacheCreation1h: ctx - read, cacheRead: read, context: ctx } });
    steps.push({ kind: 'tool_result', name: 'Edit', payload: 'ok', toolUseId: `${id}-${k}`, isError: (opts.errors ?? 0) > 0 && k % Math.max(1, Math.round(1 / opts.errors!)) === 0 });
    prev = ctx; ctx += d;
  }
  const run: Run = { runId: id, agentId: 'a', startedAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`, models: ['claude-opus-5'], usageByModel: {}, costUsd: 0, steps };
  run.costUsd = requestsOf(run).reduce((s, r) => s + r.costUsd, 0);
  return run;
}
const lengths = [80, 120, 150, 200, 260, 90, 170, 230];
const before = lengths.map((n, i) => session(`b${i}`, 1 + i, n));
const CUT = '2026-09-15T00:00:00Z';

describe('measureEffect', () => {
  it('waits for at least 3 sessions on each side', () => {
    expect(measureEffect([...before, session('a0', 16, 100)], CUT).verdict).toBe('collecting');
  });

  it('never calls "no change" a saving', () => {
    const after = lengths.map((n, i) => session(`a${i}`, 16 + i, n));
    const e = measureEffect([...before, ...after], CUT);
    expect(e.verdict).not.toBe('confirmed');
    expect(Math.abs(e.tokensPerRequest!.changePct)).toBeLessThan(0.02);
  });

  it('does not mistake shorter sessions for a saving — the comparison is matched by position', () => {
    const shorter = lengths.map((n, i) => session(`a${i}`, 16 + i, Math.round(n / 3)));
    const e = measureEffect([...before, ...shorter], CUT);
    expect(e.verdict).not.toBe('confirmed');
    expect(Math.abs(e.tokensPerRequest!.changePct)).toBeLessThan(0.05);
  });

  it('confirms compaction: the mechanism moves and tokens per request drop', () => {
    const after = lengths.map((n, i) => session(`a${i}`, 16 + i, n, { cap: 200_000 }));
    const e = measureEffect([...before, ...after], CUT, 'compact-earlier', { threshold: 200_000 });
    expect(e.inEffect).toBe(true);
    expect(e.primary!.after).toBeLessThan(0.02);
    expect(e.tokensPerRequest!.changePct).toBeLessThan(-0.2);
    expect(e.verdict).toBe('confirmed');
    expect(e.realizedPerMonthUsd).toBeGreaterThan(0);
  });

  it('says "not in effect" when the change was marked but its mechanism did not move', () => {
    const after = lengths.map((n, i) => session(`a${i}`, 16 + i, n));
    expect(measureEffect([...before, ...after], CUT, 'compact-earlier', { threshold: 200_000 }).verdict).toBe('not-in-effect');
  });

  it('counts a saving that came with more errors as worse', () => {
    const after = lengths.map((n, i) => session(`a${i}`, 16 + i, n, { cap: 200_000, errors: 0.3 }));
    const e = measureEffect([...before, ...after], CUT, 'compact-earlier', { threshold: 200_000 });
    expect(e.quality.ok).toBe(false);
    expect(e.verdict).toBe('regressed');
  });
});
