import { describe, expect, it } from 'vitest';
import { analyzeAgent, mineRecurringCommands } from '../src/plan.js';
import { isLegacyParse, requestsOf } from '../src/rent.js';
import type { RawStep, Run } from '../src/types.js';

function run(id: string, commands: string[], opts: { legacy?: boolean; cwd?: string } = {}): Run {
  const steps: RawStep[] = [{ kind: 'model_turn', name: 'user', payload: 'commit and push' }];
  let ctx = 60_000;
  commands.forEach((command, i) => {
    steps.push({
      kind: 'tool_use', name: 'Bash', payload: JSON.stringify({ command }), toolUseId: `${id}-${i}`, model: 'claude-opus-5',
      tokens: { input: 1, output: 200, cacheCreation: 2_000, cacheRead: ctx - 2_000, ...(opts.legacy ? {} : { context: ctx, cacheCreation1h: 2_000 }) },
    });
    steps.push({ kind: 'tool_result', name: 'Bash', payload: 'ok', toolUseId: `${id}-${i}` });
    ctx += 2_000;
  });
  return { runId: id, agentId: 'a', cwd: opts.cwd ?? '/home/u/repo', models: ['claude-opus-5'], usageByModel: {}, costUsd: 1, steps };
}

const PUSH = 'gh auth switch --user someone >/dev/null 2>&1; git push origin main 2>&1 | tail -5';

describe('legacy parses', () => {
  it('are detected and excluded from every context figure', () => {
    const legacy = [run('1', [PUSH], { legacy: true }), run('2', [PUSH], { legacy: true }), run('3', [PUSH], { legacy: true })];
    expect(isLegacyParse(legacy[0])).toBe(true);
    const a = analyzeAgent('a', legacy);
    expect(a.legacyRuns).toBe(3);
    expect(a.plan.map((p) => p.id)).not.toContain('compact-earlier');
    expect(a.plan.map((p) => p.id)).not.toContain('spill-exploration');
    expect(a.plan.map((p) => p.id)).not.toContain('advisor-cost');
    expect(a.plan[0].id).toBe('recapture');
  });
});

describe('recurring commands → skills', () => {
  it('groups by short-literal template, never by a whole inline script', () => {
    const scripts = ['python3 -c "import json; print(1)"', 'python3 -c "import os; print(2)"', 'python3 -c "import re; print(3)"', 'python3 -c "import sys; print(4)"'];
    expect(mineRecurringCommands(scripts.map((c, i) => run(String(i), [c])))).toEqual([]);
    const pushes = [1, 2, 3, 4].map((i) => run(String(i), [PUSH]));
    const rc = mineRecurringCommands(pushes);
    expect(rc).toHaveLength(1);
    expect(rc[0].template).toContain('2>&1'); // redirections are not slots
  });

  it('generates skill files with valid frontmatter, no home paths, no IPs', () => {
    const cmd = 'cd /home/u/repo && ssh -o ConnectTimeout=5 ubuntu@10.1.2.3 uptime && git status --short && git diff --stat';
    const a = analyzeAgent('a', [1, 2, 3, 4].map((i) => run(String(i), [cmd])));
    const skill = a.plan.flatMap((p) => p.files).find((f) => f.path.includes('/skills/'));
    expect(skill).toBeDefined();
    expect(skill!.content.startsWith('---\nname: ')).toBe(true);
    expect(skill!.content).toMatch(/\ndescription: .+\n/);
    expect(skill!.content).not.toContain('/home/u/repo');
    expect(skill!.content).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });
});

describe('compact-earlier', () => {
  /** A long session: context grows 2k per request from 60k, with large tool results. */
  function long(id: string, day: number, n: number, capAt?: number): Run {
    const start = Date.parse(`2026-09-${String(day).padStart(2, '0')}T10:00:00Z`);
    const steps: RawStep[] = [{ kind: 'model_turn', name: 'user', payload: 'do the task' }];
    let ctx = 60_000, prev = 0;
    for (let k = 0; k < n; k++) {
      if (capAt && ctx > capAt) { ctx = 70_000; prev = 0; } // the harness's own auto-compaction
      steps.push({ kind: 'tool_use', name: k % 3 ? 'Edit' : 'Read', payload: JSON.stringify({ file_path: `/r/f${k % 7}.ts` }), toolUseId: `${id}-${k}`, model: 'claude-opus-5',
        timestamp: new Date(start + k * 60_000).toISOString(), tokens: { input: 0, output: 300, cacheCreation: ctx - prev, cacheCreation1h: ctx - prev, cacheRead: prev, context: ctx } });
      steps.push({ kind: 'tool_result', name: 'Edit', payload: 'x'.repeat(2000), toolUseId: `${id}-${k}` });
      prev = ctx; ctx += 2_000;
    }
    const r: Run = { runId: id, agentId: 'a', startedAt: new Date(start).toISOString(), models: ['claude-opus-5'], usageByModel: {}, costUsd: 0, steps };
    r.costUsd = requestsOf(r).reduce((s, x) => s + x.costUsd, 0);
    return r;
  }
  const runs = () => Array.from({ length: 12 }, (_, i) => long(`s${i}`, 1 + i, 200 + 40 * (i % 5)));

  it('is recommended for long sessions that never compact', () => {
    expect(analyzeAgent('a', runs()).plan.find((p) => p.id === 'compact-earlier')?.title).toMatch(/instead of the ~1M default/);
  });

  it('is not recommended at the point the harness already compacts at on its own', () => {
    const T = Number(analyzeAgent('a', runs()).plan.find((p) => p.id === 'compact-earlier')!.title.match(/at (\d+)k/)![1]) * 1000;
    // as on real traffic: most sessions never compact, but the harness auto-compacts some at ≈T
    // on its own — and, like real transcripts, their preTokens read ~2× the request context
    const rs = [...runs(), ...Array.from({ length: 4 }, (_, i) => long(`h${i}`, 14 + i, 320, T * 1.05))];
    for (const r of rs.slice(-4)) r.events = [{ kind: 'compact', detail: 'auto', preTokens: T * 2.2, postTokens: 30_000 }];
    const a = analyzeAgent('a', rs);
    expect(a.plan.map((p) => p.id)).not.toContain('compact-earlier');
    expect(a.loop.map((o) => o.lever)).not.toContain('compaction'); // the harness's own compactions are not an adoption
  });
});
