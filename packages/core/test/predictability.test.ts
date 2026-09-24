import { describe, expect, it } from 'vitest';
import { measurePredictability } from '../src/predictability.js';
import { parseTranscript } from '../src/transcript.js';
import type { RawStep, Run } from '../src/types.js';

/** A session whose k-th call is `tools(k)` (Bash commands), perfect cache. */
function session(id: string, day: number, n: number, tool: (k: number) => string): Run {
  const steps: RawStep[] = [];
  let ctx = 50_000, prev = 0;
  for (let k = 0; k < n; k++) {
    steps.push({ kind: 'tool_use', name: 'Bash', payload: JSON.stringify({ command: tool(k) }), toolUseId: `${id}-${k}`, model: 'claude-opus-5',
      tokens: { input: 0, output: 50, cacheCreation: ctx - prev, cacheCreation1h: ctx - prev, cacheRead: prev, context: ctx } });
    steps.push({ kind: 'tool_result', name: 'Bash', payload: 'ok', toolUseId: `${id}-${k}` });
    prev = ctx; ctx += 1_000;
  }
  return { runId: id, agentId: 'a', startedAt: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, models: ['claude-opus-5'], usageByModel: {}, costUsd: 1, steps };
}

const CYCLE = ['git status --short', 'npx tsc --noEmit', 'npm test', 'git add -A', 'git commit -m x', 'git push'];

describe('measurePredictability', () => {
  it('a scripted agent is almost fully deterministic, and says so with calibrated confidence', () => {
    const runs = Array.from({ length: 10 }, (_, i) => session(String(i), i + 1, 90, (k) => CYCLE[k % CYCLE.length]));
    const p = measurePredictability(runs, 'action')!;
    expect(p.coverage80).toBeGreaterThan(0.9);
    expect(p.precision80).toBeGreaterThan(0.95);
    expect(p.spendShare80).toBeGreaterThan(0.9);
    expect(p.explained).toBeGreaterThan(0.8);
  });

  it('an agent that picks actions at random is not', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const verbs = ['ls', 'git log', 'npm test', 'git push', 'cat a', 'grep x b', 'npx tsc', 'git diff', 'make', 'curl x'];
    const runs = Array.from({ length: 10 }, (_, i) => session(String(i), i + 1, 90, () => verbs[Math.floor(rnd() * verbs.length)]));
    const p = measurePredictability(runs, 'action')!;
    expect(p.coverage80).toBeLessThan(0.05);
    expect(p.explained).toBeLessThan(0.1);
  });

  it('refuses to measure without enough later sessions', () => {
    expect(measurePredictability([session('1', 1, 10, () => 'ls'), session('2', 2, 10, () => 'ls')])).toBeNull();
  });
});

const line = (o: object) => JSON.stringify({ sessionId: 's1', cwd: '/w/repo', timestamp: '2026-09-01T00:00:00Z', ...o });

describe('parseTranscript — outcomes, friction, subagents', () => {
  it('keeps git outcomes, denials, compactions and subagent spend', () => {
    const usage = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const jsonl = [
      line({ type: 'user', message: { role: 'user', content: 'ship it' }, promptSource: 'typed' }),
      line({ type: 'assistant', requestId: 'r1', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push' } }], usage } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(25_000) }] },
        toolUseResult: { gitOperation: { commit: { sha: 'abcdef1234567' }, push: { branch: 'main' }, pr: { number: 7, action: 'created' } } } }),
      line({ type: 'user', toolDenialKind: 'automode-blocked', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'denied' }] } }),
      line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 990_000, postTokens: 12_000 } }),
      // a subagent line appended by the CLI upload
      line({ type: 'assistant', isSidechain: true, agentId: 'agent-1', requestId: 'side-1', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'found it' }], usage: { ...usage, input_tokens: 1_000_000 } } }),
    ].join('\n');
    const run = parseTranscript(jsonl)!;
    expect(run.events!.map((e) => e.kind)).toEqual(['commit', 'push', 'pr', 'deny', 'compact']);
    expect(run.events![2].detail).toBe('created #7');
    expect(run.events![4]).toMatchObject({ detail: 'auto', preTokens: 990_000, postTokens: 12_000 });
    expect(run.subagents).toEqual({ count: 1, requests: 1, costUsd: expect.closeTo(2.001, 3) });
    expect(run.usageByModel['claude-sonnet-5'].inputTokens).toBe(1_000_000);
    // the sidechain turn is spend, not conversation
    expect(run.steps.some((s) => s.payload === 'found it')).toBe(false);
    // the real size of a truncated result survives
    expect(run.steps.find((s) => s.kind === 'tool_result')!.fullChars).toBe(25_000);
  });
});
