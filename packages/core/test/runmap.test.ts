import { describe, expect, it } from 'vitest';
import { buildRunMap } from '../src/runmap.js';
import type { RawStep, Run } from '../src/types.js';

type Call = { name?: string; command?: string; file?: string; error?: boolean };
function run(calls: Call[]): Run {
  const steps: RawStep[] = [];
  let ctx = 50_000, prev = 0;
  calls.forEach((c, k) => {
    const name = c.name ?? 'Bash';
    steps.push({ kind: 'tool_use', name, payload: JSON.stringify(c.command != null ? { command: c.command } : { file_path: c.file }), toolUseId: `t${k}`, model: 'claude-opus-5',
      tokens: { input: 0, output: 50, cacheCreation: ctx - prev, cacheRead: prev, context: ctx } });
    steps.push({ kind: 'tool_result', name, payload: 'ok', toolUseId: `t${k}`, isError: c.error ?? false });
    prev = ctx; ctx += 1_000;
  });
  return { runId: 'r', agentId: 'a', models: ['claude-opus-5'], usageByModel: {}, costUsd: 1, steps };
}

describe('buildRunMap', () => {
  const fixLoop: Call[] = [];
  for (let i = 0; i < 5; i++) fixLoop.push({ name: 'Edit', file: '/r/src/cart.tsx' }, { command: 'cd /r && npx tsc --noEmit 2>&1 | head' });
  const failing: Call[] = [];
  for (let i = 0; i < 4; i++) failing.push({ command: 'npm run migrate', error: true }, { name: 'Read', file: '/r/db/schema.sql' });

  it('turns an edit ⇄ check cycle into a fix loop, and a failing cycle into an error loop', () => {
    const m = buildRunMap(run([{ name: 'Read', file: '/r/README.md' }, ...fixLoop, ...failing]));
    const kinds = m.loops.map((l) => l.kind).sort();
    expect(kinds).toEqual(['error', 'fix']);
    const fix = m.loops.find((l) => l.kind === 'fix')!;
    expect(fix.nodes.sort()).toEqual(['edit:cart.tsx', 'verify:tsc']);
    expect(fix.passes).toBeGreaterThanOrEqual(3);
    // a step visited once is on the map but in no loop
    expect(m.nodes.find((n) => n.id === 'read:README.md')!.loop).toBe(-1);
  });

  it('lays out deterministically inside the unit square', () => {
    const r = run([...fixLoop, ...failing, { command: 'git add -A && git commit -m x && git push' }]);
    const a = buildRunMap(r), b = buildRunMap(r);
    expect(a.nodes.map((n) => [n.id, n.x, n.y])).toEqual(b.nodes.map((n) => [n.id, n.x, n.y]));
    for (const n of a.nodes) { expect(n.x).toBeGreaterThanOrEqual(0); expect(n.x).toBeLessThanOrEqual(1); expect(n.y).toBeGreaterThanOrEqual(0); expect(n.y).toBeLessThanOrEqual(1); }
    expect(a.nodes.find((n) => n.kind === 'deliver')).toBeDefined();
  });

  it('folds rare steps on huge sessions so the map stays readable', () => {
    const calls: Call[] = Array.from({ length: 400 }, (_, i) => ({ name: 'Read', file: `/r/src/file${i}.ts` }));
    const m = buildRunMap(run(calls));
    expect(m.nodes.length).toBeLessThanOrEqual(140);
    expect(m.folded).toBeGreaterThan(0);
  });
});
