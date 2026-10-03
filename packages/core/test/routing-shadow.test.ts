import { describe, expect, it } from 'vitest';
import { SUBAGENT_ROUTING_TARGET, SubagentRoutingShadow, summarizeShadow, usageCostUsd, type TokenUsage } from '../src/index.js';

const u = (p: Partial<TokenUsage>): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, ...p });

describe('subagent routing shadow', () => {
  it('groups by session and subagent; main thread is never routed', () => {
    const sh = new SubagentRoutingShadow('repo');
    sh.add({ sessionId: 's1', model: 'claude-opus-5-5', usage: u({ inputTokens: 100, outputTokens: 2000, cacheCreationInputTokens: 50_000 }) });
    sh.add({ sessionId: 's1', agentId: 'a1', model: 'claude-opus-5-5', usage: u({ inputTokens: 10, outputTokens: 3000, cacheCreationInputTokens: 40_000 }) });
    sh.add({ sessionId: 's1', agentId: 'a1', model: 'claude-opus-5-5', usage: u({ inputTokens: 10, outputTokens: 1000, cacheReadInputTokens: 40_000 }) });
    sh.add({ sessionId: 's1', agentId: 'a2', model: 'claude-haiku-4-5', usage: u({ outputTokens: 500, cacheCreationInputTokens: 30_000 }) });
    const [s] = sh.result();
    expect(s.sessionId).toBe('s1');
    expect(s.requests).toBe(4);
    expect(s.subagents).toHaveLength(2);
    const a1 = s.subagents.find((x) => x.agentId === 'a1')!;
    expect(a1.requests).toBe(2);
    expect(a1.wouldRouteTo).toBe(SUBAGENT_ROUTING_TARGET);
    const total = u({ inputTokens: 20, outputTokens: 4000, cacheCreationInputTokens: 40_000, cacheReadInputTokens: 40_000 });
    expect(a1.costUsd).toBeCloseTo(usageCostUsd('claude-opus-5-5', total), 10);
    expect(a1.counterfactualUsd).toBeCloseTo(usageCostUsd(SUBAGENT_ROUTING_TARGET, total), 10);
    // Haiku is already below the target: not a candidate at all.
    expect(s.subagents.find((x) => x.agentId === 'a2')!.counterfactualUsd).toBeUndefined();
    expect(s.wouldRoute).toBe(1);
    expect(s.estimatedSavingsUsd).toBeCloseTo(a1.costUsd - a1.counterfactualUsd!, 10);
    expect(s.costUsd).toBeCloseTo(s.mainCostUsd + a1.costUsd + s.subagents[1].costUsd, 10);
  });

  it('a premium subagent that would NOT be cheaper is not counted (cache-read heavy on Opus 5.5)', () => {
    const sh = new SubagentRoutingShadow('repo');
    // Cache reads: Opus 5.5 = 0.05 × $4 = $0.20/M, Sonnet 5 = 0.1 × $2 = $0.20/M — no saving.
    sh.add({ sessionId: 's', agentId: 'a', model: 'claude-opus-5-5', usage: u({ cacheReadInputTokens: 1_000_000 }) });
    const [s] = sh.result();
    expect(s.subagents[0].counterfactualUsd).toBeCloseTo(s.subagents[0].costUsd, 10);
    expect(s.subagents[0].wouldRouteTo).toBeUndefined();
    expect(s.wouldRoute).toBe(0);
    expect(s.estimatedSavingsUsd).toBe(0);
  });

  it('a saving under 5% is not counted', () => {
    const sh = new SubagentRoutingShadow('repo');
    // 1M cache reads (same price both tiers) + 1k output: Opus $0.20 + $0.02, Sonnet $0.20 + $0.01 → 4.5% cheaper.
    sh.add({ sessionId: 's', agentId: 'a', model: 'claude-opus-5-5', usage: u({ cacheReadInputTokens: 1_000_000, outputTokens: 1000 }) });
    const sub = sh.result()[0].subagents[0];
    expect(sub.counterfactualUsd!).toBeLessThan(sub.costUsd);
    expect(sub.wouldRouteTo).toBeUndefined();
  });

  it('the decision holds from the first request even if a later one uses another model', () => {
    const sh = new SubagentRoutingShadow('repo');
    sh.add({ sessionId: 's', agentId: 'a', model: 'claude-sonnet-5-5', usage: u({ outputTokens: 100 }) });
    sh.add({ sessionId: 's', agentId: 'a', model: 'claude-opus-5-5', usage: u({ outputTokens: 100 }) });
    const sub = sh.result()[0].subagents[0];
    expect(sub.model).toBe('claude-sonnet-5-5');
    expect(sub.wouldRouteTo).toBeUndefined();
    // …but the cost is still priced per model actually used.
    expect(sub.costUsd).toBeCloseTo(usageCostUsd('claude-sonnet-5-5', u({ outputTokens: 100 })) + usageCostUsd('claude-opus-5-5', u({ outputTokens: 100 })), 10);
  });

  it('summarizes across sessions', () => {
    const sh = new SubagentRoutingShadow('repo');
    sh.add({ sessionId: 's1', agentId: 'a', model: 'claude-fable-5-1', usage: u({ outputTokens: 10_000 }), at: '2026-10-01T00:00:00Z' });
    sh.add({ sessionId: 's2', model: 'claude-fable-5-1', usage: u({ outputTokens: 10_000 }), at: '2026-10-02T00:00:00Z' });
    const sum = summarizeShadow(sh.result());
    expect(sum).toMatchObject({ sessions: 2, subagents: 1, premiumSubagents: 1, wouldRoute: 1, firstAt: '2026-10-01T00:00:00Z', lastAt: '2026-10-02T00:00:00Z' });
    // Fable output $50/M → Sonnet $10/M on 10k tokens = $0.40 saved of $1.00 total.
    expect(sum.estimatedSavingsUsd).toBeCloseTo(0.4, 10);
    expect(sum.estimatedSavingsShare).toBeCloseTo(0.4, 10);
  });
});
