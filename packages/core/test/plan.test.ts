import { describe, expect, it } from 'vitest';
import { analyzeAgent, mineRecurringCommands } from '../src/plan.js';
import { isLegacyParse } from '../src/rent.js';
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
