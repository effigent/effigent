import { describe, expect, it } from 'vitest';
import { computeLaws, requestReason } from '../src/laws.js';
import { evaluateLoop } from '../src/loop.js';
import { requestsOf } from '../src/rent.js';
import type { RawStep, Run } from '../src/types.js';

/** A session of n requests with a perfect cache: base context, +d tokens per request. */
function session(id: string, n: number, opts: { base?: number; d?: number; start?: string; tool?: (k: number) => { name: string; input: object }; error?: (k: number) => boolean } = {}): Run {
  const base = opts.base ?? 60_000, d = opts.d ?? 1_500;
  const steps: RawStep[] = [{ kind: 'model_turn', name: 'user', payload: 'do the task' }];
  let ctx = base, prev = 0;
  for (let k = 0; k < n; k++) {
    const t = opts.tool?.(k) ?? { name: 'Edit', input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } };
    steps.push({
      kind: 'tool_use', name: t.name, payload: JSON.stringify(t.input), toolUseId: `${id}-${k}`, model: 'claude-opus-5',
      tokens: { input: 0, output: 100, cacheCreation: ctx - prev, cacheCreation1h: ctx - prev, cacheRead: prev, context: ctx },
    });
    steps.push({ kind: 'tool_result', name: t.name, payload: 'ok', toolUseId: `${id}-${k}`, isError: opts.error?.(k) ?? false });
    prev = ctx; ctx += d;
  }
  const run: Run = { runId: id, agentId: 'a', startedAt: opts.start ?? '2026-09-01T00:00:00Z', models: ['claude-opus-5'], usageByModel: {}, costUsd: 0, steps };
  run.costUsd = requestsOf(run).reduce((s, r) => s + r.costUsd, 0);
  return run;
}

const bash = (command: string) => ({ name: 'Bash', input: { command } });

describe('requestReason', () => {
  it('names what a request was for', () => {
    const R = requestsOf(session('x', 7, { tool: (k) => [
      { name: 'Read', input: { file_path: '/r/a.ts' } },
      { name: 'Edit', input: { file_path: '/r/a.ts' } },
      bash('cd /r && npx tsc --noEmit 2>&1 | head'),
      bash('git add -A && git commit -m "x" && git push'),
      bash('sleep 30; gh run view 123'),
      { name: 'Agent', input: { subagent_type: 'scout', prompt: 'find x' } },
      bash('ls src'),
    ][k] }));
    expect(R.map((r, k) => requestReason(r, R[k - 1]))).toEqual(['explore', 'act', 'verify', 'deliver', 'wait', 'delegate', 'explore']);
  });

  it('marks the request after a failed call as recovery', () => {
    const R = requestsOf(session('x', 3, { error: (k) => k === 0 }));
    expect(requestReason(R[1], R[0])).toBe('recover');
  });
});

describe('computeLaws', () => {
  const runs = [20, 40, 60, 80, 120, 160, 200, 300, 400].map((n, i) => session(String(i), n));

  it('fits the quadratic session law and puts the EOQ threshold between base and peak', () => {
    const L = computeLaws(runs);
    expect(L.law).not.toBeNull();
    expect(L.law!.baseTokens).toBe(60_000);
    expect(L.law!.depositPerRequest).toBe(1_500);
    expect(L.law!.fitR2).toBeGreaterThan(0.95);
    expect(L.law!.eoqThreshold).toBeGreaterThan(60_000);
    expect(L.law!.eoqThreshold).toBeLessThan(660_000);
  });

  it('attributes cost variance to session length when only length varies', () => {
    const L = computeLaws(runs);
    expect(L.drivers!.requests).toBeGreaterThan(0.7);
    expect(L.expensive[0].runId).toBe('8');
    expect(L.expensive[0].dominant).toBe('requests');
  });
});

describe('evaluateLoop', () => {
  const day = (i: number) => `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`;
  const scoutCall = (k: number) => (k % 5 === 0 ? { name: 'Agent', input: { subagent_type: 'scout', prompt: 'look' } } : { name: 'Edit', input: { file_path: '/r/a.ts' } });

  it('reports nothing when no proposed change was adopted', () => {
    expect(evaluateLoop(Array.from({ length: 8 }, (_, i) => session(String(i), 50, { start: day(i) })))).toEqual([]);
  });

  it('confirms the scout when it is adopted and context per request falls, quality intact', () => {
    const before = Array.from({ length: 5 }, (_, i) => session(`b${i}`, 60, { start: day(i), d: 2_000 }));
    const after = Array.from({ length: 5 }, (_, i) => session(`a${i}`, 60, { start: day(i + 5), d: 800, tool: scoutCall }));
    const [o] = evaluateLoop([...before, ...after]);
    expect(o.lever).toBe('scout');
    expect(o.status).toBe('confirmed');
    expect(o.costPerRequestAfter).toBeLessThan(o.costPerRequestBefore);
  });

  it('flags a regression when errors rise after adoption, even if cost falls', () => {
    const before = Array.from({ length: 5 }, (_, i) => session(`b${i}`, 60, { start: day(i), d: 2_000 }));
    const after = Array.from({ length: 5 }, (_, i) => session(`a${i}`, 60, { start: day(i + 5), d: 800, tool: scoutCall, error: (k) => k % 3 === 0 }));
    expect(evaluateLoop([...before, ...after])[0].status).toBe('regressed');
  });

  it('does not call one manual /compact near the threshold an adoption', () => {
    const T = 200_000;
    // every session grows past T; only session 5 resets near it (a one-off manual /compact)
    const runs = Array.from({ length: 10 }, (_, i) => {
      const r = session(String(i), 120, { start: day(i), d: 2_000 });
      if (i === 5) for (const s of r.steps) if (s.tokens && s.tokens.context! > 0.95 * T) s.tokens.context = s.tokens.context! - 150_000;
      return r;
    });
    expect(evaluateLoop(runs, { threshold: T }).filter((o) => o.lever === 'compaction')).toEqual([]);
  });

  it('ignores a generic subagent that is not the proposed scout', () => {
    const runs = Array.from({ length: 8 }, (_, i) => session(String(i), 50, { start: day(i), tool: (k) => (i >= 4 && k % 5 === 0 ? { name: 'Agent', input: { subagent_type: 'general-purpose' } } : { name: 'Edit', input: {} }) }));
    expect(evaluateLoop(runs)).toEqual([]);
  });
});
