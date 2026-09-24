import { describe, expect, it } from 'vitest';
import { analyzeAgent } from '../src/plan.js';
import { summarizeAgent } from '../src/summary.js';
import { requestsOf } from '../src/rent.js';
import type { RawStep, Run } from '../src/types.js';

/** A session of n requests over `minutes`, perfect cache, with an optional break (cache expiry) at `breakAt`. */
function session(id: string, day: number, n: number, opts: { breakAt?: number; base?: number; d?: number } = {}): Run {
  const base = opts.base ?? 60_000, d = opts.d ?? 2_000;
  const steps: RawStep[] = [{ kind: 'model_turn', name: 'user', payload: 'work on the thing' }];
  let ctx = base, prev = 0;
  let t = Date.parse(`2026-09-${String(day).padStart(2, '0')}T08:00:00Z`);
  for (let k = 0; k < n; k++) {
    const cold = opts.breakAt === k;
    if (cold) t += 2 * 3_600_000; // two hours away: the 1-hour cache expired
    const read = cold || k === 0 ? 0 : prev;
    steps.push({
      kind: 'tool_use', name: 'Edit', payload: '{"file_path":"/r/a.ts"}', toolUseId: `${id}-${k}`, model: 'claude-opus-5',
      timestamp: new Date(t).toISOString(),
      tokens: { input: 0, output: 150, cacheCreation: ctx - read, cacheCreation1h: ctx - read, cacheRead: read, context: ctx },
    });
    steps.push({ kind: 'tool_result', name: 'Edit', payload: 'ok', toolUseId: `${id}-${k}` });
    prev = ctx; ctx += d; t += 20_000;
  }
  const run: Run = {
    runId: id, agentId: 'a', startedAt: new Date(Date.parse(`2026-09-${String(day).padStart(2, '0')}T08:00:00Z`)).toISOString(),
    endedAt: new Date(t).toISOString(), models: ['claude-opus-5'], usageByModel: {}, costUsd: 0, steps,
  };
  run.costUsd = requestsOf(run).reduce((s, r) => s + r.costUsd, 0);
  return run;
}

describe('summarizeAgent', () => {
  // 12 sessions over 22 days: most short, two marathons, several resumed after a break
  const runs = [
    ...[1, 3, 5, 7, 9, 11, 13, 15, 17, 19].map((day, i) => session(`s${i}`, day, 40)),
    session('m1', 21, 450, { breakAt: 200 }),
    session('m2', 23, 420, { breakAt: 150 }),
  ];
  const s = summarizeAgent(analyzeAgent('a', runs), runs);

  it('states money per month at the observed pace', () => {
    expect(s.window.days).toBeGreaterThanOrEqual(22);
    expect(Math.abs(s.window.perMonthUsd / ((s.window.spendUsd * 30) / s.window.days) - 1)).toBeLessThan(0.03); // days is rounded for display
    expect(s.headline).toMatch(/\/month at this pace/);
  });

  it('names the marathon sessions as the bill driver', () => {
    const c = s.findings.find((f) => f.id === 'concentration');
    expect(c).toBeDefined();
    expect(s.sessions[0].runId).toMatch(/^m/);
  });

  it('detects returns after the cache expired, and only those', () => {
    const b = s.findings.find((f) => f.id === 'breaks');
    expect(b).toBeUndefined(); // two breaks is below the 3-event floor — not a pattern yet
    // four more marathons, each resumed late (≈700k context) — now material
    const more = [...runs, ...[24, 25, 26, 27].map((d) => session(`b${d}`, d, 400, { breakAt: 330 }))];
    const s2 = summarizeAgent(analyzeAgent('a', more), more);
    expect(s2.findings.find((f) => f.id === 'breaks')?.sentence).toMatch(/^6 returns/);
  });

  it('ranks actions by expected monthly value and never shows a negative saving', () => {
    const mids = s.actions.filter((a) => a.perMonthUsd).map((a) => (a.perMonthUsd!.low + a.perMonthUsd!.high) / 2);
    expect(mids).toEqual([...mids].sort((x, y) => y - x));
    for (const x of s.sessions) if (x.compactionSavesUsd != null) expect(x.compactionSavesUsd).toBeGreaterThan(0);
    expect(s.actions.some((a) => a.id === 'advisor-cost')).toBe(false); // advisor is a finding, not an action
  });
});
