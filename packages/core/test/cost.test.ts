import { describe, expect, it } from 'vitest';
import { usageCostUsd } from '../src/cost.js';
import { parseTranscript } from '../src/transcript.js';

/**
 * Ground truth: Claude Code's own per-model `cost-state` totals from real
 * sessions (2026-09). The token counts carry no 5m/1h split, and every one of
 * these sessions wrote with the 1-hour TTL, so all cache writes are passed as 1h.
 * (Fable 5.1 is absent on purpose: its only large total mixes 5m and 1h writes,
 * which cost-state cannot separate — it is covered by the per-request check
 * instead: median ours/cost-state = 0.999 over 247 clean sessions.)
 */
const GROUND_TRUTH: Array<[string, { i: number; o: number; r: number; w: number }, number]> = [
  ['claude-opus-5', { i: 34152, o: 1604255, r: 714441291, w: 5024138 }, 447.5114],
  ['claude-fable-5', { i: 865974, o: 134970, r: 25968282, w: 909008 }, 59.5373],
  ['claude-opus-4-8', { i: 4840, o: 295916, r: 61545610, w: 421598 }, 42.3997],
];

describe('usageCostUsd — pricing against Claude Code ground truth', () => {
  for (const [model, t, truth] of GROUND_TRUTH) {
    it(`${model} reproduces cost-state within 2%`, () => {
      const cost = usageCostUsd(model, {
        inputTokens: t.i,
        outputTokens: t.o,
        cacheReadInputTokens: t.r,
        cacheCreationInputTokens: t.w,
        cacheCreation1hInputTokens: t.w,
      });
      expect(Math.abs(cost - truth) / truth).toBeLessThan(0.02);
    });
  }

  it('prices 5-minute writes at 1.25× and 1-hour writes at 2×', () => {
    const base = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1_000_000 };
    expect(usageCostUsd('claude-opus-5', base)).toBeCloseTo(6.25, 6);
    expect(usageCostUsd('claude-opus-5', { ...base, cacheCreation1hInputTokens: 1_000_000 })).toBeCloseTo(10, 6);
  });

  it('keeps the legacy Opus 4.1 tier and specific ids ahead of their family', () => {
    const out = { inputTokens: 0, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    expect(usageCostUsd('claude-opus-4-1', out)).toBe(75);
    expect(usageCostUsd('claude-opus-5-5', out)).toBe(20);
    expect(usageCostUsd('claude-sonnet-5', out)).toBe(10);
    expect(usageCostUsd('claude-sonnet-4-6', out)).toBe(15);
  });
});

const line = (o: object) => JSON.stringify({ sessionId: 's1', cwd: '/w/repo', timestamp: '2026-09-01T00:00:00Z', ...o });

describe('parseTranscript — what the harness writes beyond messages', () => {
  it('splits 1h cache writes, counts advisor iterations, and reads the true context', () => {
    const jsonl = [
      line({ type: 'user', message: { role: 'user', content: 'fix the build' }, promptSource: 'typed', origin: { kind: 'human' } }),
      line({
        type: 'assistant', requestId: 'r1',
        message: {
          role: 'assistant', model: 'claude-opus-5',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 4, output_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 200000,
            output_tokens_details: { thinking_tokens: 40 },
            cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 },
            // two sampling iterations: the top-level numbers are their SUM
            iterations: [
              { type: 'message', input_tokens: 2, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000 },
              { type: 'message', input_tokens: 2, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000 },
              { type: 'advisor_message', model: 'claude-fable-5', input_tokens: 100000, output_tokens: 1000 },
            ],
          },
        },
      }),
    ].join('\n');
    const run = parseTranscript(jsonl)!;
    const step = run.steps.find((s) => s.tokens)!;
    expect(step.tokens!.cacheCreation1h).toBe(2000);
    expect(step.tokens!.thinking).toBe(40);
    expect(step.tokens!.context).toBe(101002);
    expect(run.usageByModel['claude-fable-5'].inputTokens).toBe(100000);
    // opus: 4×5 + 2000×10 + 200000×0.5 + 100×25 (per M) ; advisor: 100000×10 + 1000×50 (per M)
    expect(run.costUsd).toBeCloseTo((20 + 20000 + 100000 + 2500) / 1e6 + (1_000_000 + 50_000) / 1e6, 6);
  });

  it('never opens an episode on harness turns: shell echoes, compaction summaries, task notifications', () => {
    const jsonl = [
      line({ type: 'user', message: { role: 'user', content: 'real ask' }, promptSource: 'typed', origin: { kind: 'human' } }),
      line({ type: 'assistant', requestId: 'r1', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      line({ type: 'user', message: { role: 'user', content: '<bash-stdout>ok</bash-stdout>' } }),
      line({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'background task done' } }),
      line({ type: 'assistant', requestId: 'r2', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 9e6, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ].join('\n');
    const run = parseTranscript(jsonl)!;
    expect(run.steps.filter((s) => s.kind === 'model_turn' && s.name === 'user').map((s) => s.payload)).toEqual(['real ask']);
    expect(run.models).toEqual(['claude-opus-5']);
    expect(run.costUsd).toBeLessThan(0.001);
  });
});
