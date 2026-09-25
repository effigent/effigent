import { describe, expect, it } from 'vitest';
import { applySkill, parseAppliedAt, renderForAgent, type RecommendationsResponse } from '../src/recommend.js';

const resp: RecommendationsResponse = {
  agent: 'shop',
  sessions: 40,
  headline: '$900/month at this pace.',
  recommendations: [
    { id: 'spill-exploration', title: 'Run exploration in an isolated scout subagent', why: '19% of requests are lookups.', basis: 'simulated', perMonthUsd: { low: 120, high: 200 },
      files: [{ path: '.claude/agents/scout.md', content: '---\nname: scout\n---\nbody\n' }, { path: 'CLAUDE.md', note: 'append', content: '- Delegate to scout.\n' }], appliedAt: null, source: null },
    { id: 'compact-before-breaks', title: 'Run /compact before stepping away', why: 'Breaks re-wrote context.', basis: 'structural', perMonthUsd: null, files: [], appliedAt: null, source: null },
    { id: 'compact-earlier', title: 'Compact at 200k', why: 'x', basis: 'simulated', perMonthUsd: null, files: [], appliedAt: '2026-09-20T00:00:00.000Z', source: 'detected' },
  ],
  notes: [{ id: 'advisor-cost', title: 'Advisor calls are an uncached second model', why: '25% of spend.' }],
};

describe('renderForAgent', () => {
  const md = renderForAgent(resp);
  it('lists open changes with their files and the command that records them', () => {
    expect(md).toContain('### 1. Run exploration in an isolated scout subagent');
    expect(md).toContain('File `.claude/agents/scout.md`');
    expect(md).toContain('name: scout');
    expect(md).toContain('`effigent applied spill-exploration --agent shop`');
    expect(md).toContain('≈$120–$200/month');
  });
  it('says a no-file item is for the person, not a file to invent', () => {
    expect(md).toMatch(/Run \/compact before stepping away[\s\S]*No file/);
  });
  it('separates what is already applied and what only the person can act on', () => {
    expect(md).toContain('## Already applied');
    expect(md).toContain('applied 2026-09-20 (detected from sessions)');
    expect(md).toContain('## For the person');
    expect(md).not.toContain('effigent applied compact-earlier');
  });
  it('carries the rules only when something is open', () => {
    expect(md).toContain('## How to apply');
    expect(renderForAgent({ ...resp, recommendations: [resp.recommendations[2]] })).not.toContain('## How to apply');
  });
});

describe('applySkill', () => {
  it('is user-invoked and injects the plan from the given binary', () => {
    const s = applySkill('/usr/bin/node /opt/effigent.cjs');
    expect(s).toContain('disable-model-invocation: true');
    expect(s).toContain('!`/usr/bin/node /opt/effigent.cjs recommendations`');
  });
});

describe('parseAppliedAt', () => {
  it('defaults to now, takes a bare date as its UTC start, rejects junk', () => {
    const now = new Date('2026-09-25T12:34:00Z');
    expect(parseAppliedAt(undefined, now)).toBe('2026-09-25T12:34:00.000Z');
    expect(parseAppliedAt('2026-09-24')).toBe('2026-09-24T00:00:00.000Z');
    expect(parseAppliedAt('soon')).toBeNull();
  });
});
