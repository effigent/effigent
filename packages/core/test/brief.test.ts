import { describe, it, expect } from 'vitest';
import type { Run, RawStep } from '../src/types.js';
import { buildRunGraph } from '../src/graph.js';
import { buildRunBrief, renderBriefText } from '../src/brief.js';

function step(kind: RawStep['kind'], name: string, payload: string, extra: Partial<RawStep> = {}): RawStep {
  return { kind, name, payload, ...extra };
}

const run: Run = {
  runId: 'r1',
  agentId: 'a1',
  steps: [
    step('model_turn', 'user', 'fix the failing build in the tracking module please'),
    step('model_turn', 'assistant', 'looking into it'),
    step('tool_use', 'Bash', '{"command":"pnpm build"}'),
    step('tool_result', 'Bash', 'error TS2345: nope', { isError: true }),
    step('tool_use', 'Edit', '{"file_path":"/src/t.ts","old_string":"a","new_string":"b"}'),
    step('tool_result', 'Edit', 'ok'),
    step('model_turn', 'user', 'now create a pr'),
    step('tool_use', 'Bash', '{"command":"gh pr create --title x"}'),
    step('tool_result', 'Bash', 'https://github.com/o/r/pull/42'),
    step('model_turn', 'assistant', 'Done — PR opened: https://github.com/o/r/pull/42'),
  ],
  costUsd: 2,
  models: ['claude-sonnet-4'],
  usageByModel: {},
} as Run;

describe('buildRunBrief', () => {
  const brief = buildRunBrief(run, buildRunGraph(run));

  it('captures the storyline: episodes with intent, actions, cost, errors', () => {
    expect(brief.episodes).toHaveLength(2);
    expect(brief.episodes[0].intent).toBe('fix');
    expect(brief.episodes[0].errors).toBe(1);
    expect(brief.episodes[0].actionSummary).toContain('pnpm:build');
    expect(brief.episodes[1].intent).toBe('deliver');
    expect(brief.episodes[1].actionSummary).toContain('gh:pr:create');
  });

  it('extracts outcome signals: closer, artifacts, error previews', () => {
    expect(brief.closer).toContain('PR opened');
    expect(brief.artifacts).toEqual(['https://github.com/o/r/pull/42']);
    expect(brief.errorPreviews[0]).toContain('TS2345');
    expect(brief.errorCount).toBe(1);
  });

  it('renders a bounded LLM block containing the skeleton, never full payloads', () => {
    const text = renderBriefText(brief);
    expect(text).toContain('EPISODES');
    expect(text).toContain('gh:pr:create');
    expect(text).toContain('FINAL ASSISTANT MESSAGE');
    expect(text.length).toBeLessThan(4000);
  });

  it('caps excerpt sizes on adversarially long content', () => {
    const big: Run = {
      ...run,
      steps: [
        step('model_turn', 'user', 'x'.repeat(50_000)),
        step('model_turn', 'assistant', 'y'.repeat(50_000)),
        step('tool_use', 'Bash', '{"command":"pnpm t"}'),
        step('tool_result', 'Bash', 'z'.repeat(50_000), { isError: true }),
      ],
    } as Run;
    const b = buildRunBrief(big, buildRunGraph(big));
    expect(b.opener.length).toBeLessThanOrEqual(601);
    expect(b.closer.length).toBeLessThanOrEqual(601);
    expect(b.errorPreviews[0].length).toBeLessThanOrEqual(201);
    expect(renderBriefText(b).length).toBeLessThan(6000);
  });
});
