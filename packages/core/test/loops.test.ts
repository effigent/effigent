import { describe, expect, it } from 'vitest';
import { detectLoops, TYPECHECK_HOOK_SCRIPT } from '../src/loops.js';
import { analyzeAgent } from '../src/plan.js';
import { requestsOf } from '../src/rent.js';
import type { RawStep, Run } from '../src/types.js';

type Call = { name?: string; command?: string; file?: string; result?: string; error?: boolean };

/** One request per call, perfect cache. */
function run(id: string, calls: Call[], day = 1): Run {
  const steps: RawStep[] = [];
  let ctx = 80_000, prev = 0;
  calls.forEach((c, k) => {
    const name = c.name ?? 'Bash';
    const payload = JSON.stringify(c.command != null ? { command: c.command } : { file_path: c.file ?? '/r/src/a.ts' });
    steps.push({ kind: 'tool_use', name, payload, toolUseId: `${id}-${k}`, model: 'claude-opus-5',
      tokens: { input: 0, output: 100, cacheCreation: ctx - prev, cacheCreation1h: ctx - prev, cacheRead: prev, context: ctx } });
    steps.push({ kind: 'tool_result', name, payload: c.result ?? 'ok', toolUseId: `${id}-${k}`, isError: c.error ?? false });
    prev = ctx; ctx += 1_500;
  });
  const r: Run = { runId: id, agentId: 'a', startedAt: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, models: ['claude-opus-5'], usageByModel: {}, costUsd: 0, steps };
  r.costUsd = requestsOf(r).reduce((s, q) => s + q.costUsd, 0);
  return r;
}
const edit = (f = '/r/src/a.ts'): Call => ({ name: 'Edit', file: f });
const tsc = (result = ''): Call => ({ command: 'cd /r && npx tsc --noEmit 2>&1 | head -20', result });

describe('detectLoops', () => {
  it('finds paging, per-item collections, retries and polling', () => {
    const r = run('x', [
      { command: "sed -n '1,80p' src/orders.ts" }, { command: "sed -n '80,160p' src/orders.ts" }, { command: "sed -n '160,240p' src/orders.ts" },
      { command: 'curl -s https://api/apps/101' }, { command: 'curl -s https://api/apps/202' }, { command: 'curl -s https://api/apps/303' },
      { command: 'npm run migrate', error: true }, { command: 'npm run migrate', error: true }, { command: 'npm run migrate' },
      { command: 'sleep 30; gh run view 42' }, { command: 'sleep 30; gh run view 42' }, { command: 'sleep 30; gh run view 42' },
    ]);
    const kinds = detectLoops([r]).patterns.map((p) => p.kind).sort();
    expect(kinds).toEqual(['collection', 'paging', 'poll', 'retry']);
  });

  it('never treats a run of edits as a loop — that is the work itself', () => {
    expect(detectLoops([run('x', [edit(), edit('/r/b.ts'), edit('/r/c.ts'), edit('/r/d.ts')])]).patterns).toEqual([]);
  });

  it('counts check-only re-verifies after edits, judges clean vs failed from the output, and ignores edit&&check', () => {
    const r = run('x', [
      edit(), tsc(''), // clean
      edit(), tsc('src/a.ts(3,1): error TS2322: nope'), // found
      { command: "python3 - <<'PY'\nopen('a.ts','w').write('x')\nPY\ncd /r && npx tsc --noEmit" }, // chained — no extra request
      tsc(''), // no edit since the chained check: not a re-verify
    ]);
    const v = detectLoops([r]).verify.find((x) => x.verifier === 'tsc')!;
    expect(v).toMatchObject({ reverifies: 2, clean: 1, found: 1 });
  });

  it('generates the type-check hook only when clean re-checks are material', () => {
    const heavy = Array.from({ length: 6 }, (_, i) => run(`s${i}`, Array.from({ length: 30 }, (_, k) => (k % 2 ? tsc('') : edit())), i + 1));
    const item = analyzeAgent('a', heavy).plan.find((p) => p.id === 'verify-hook')!;
    expect(item).toBeDefined();
    expect(item.files.map((f) => f.path)).toEqual(['.claude/hooks/typecheck-after-edit.sh', '.claude/settings.json', 'CLAUDE.md']);
    expect(JSON.parse(item.files[1].content).hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit');
    const light = Array.from({ length: 6 }, (_, i) => run(`s${i}`, [edit(), tsc(''), ...Array.from({ length: 30 }, () => edit())], i + 1));
    expect(analyzeAgent('a', light).plan.find((p) => p.id === 'verify-hook')).toBeUndefined();
  });

  it('the hook is silent on clean output and returns errors with exit 2', () => {
    expect(TYPECHECK_HOOK_SCRIPT).toContain('exit 2');
    expect(TYPECHECK_HOOK_SCRIPT).toContain('error TS');
    expect(TYPECHECK_HOOK_SCRIPT.startsWith('#!/usr/bin/env bash')).toBe(true);
  });
});
