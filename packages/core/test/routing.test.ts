import { describe, expect, it } from 'vitest';
import { detectModel, evaluateRouting, outputSimilarity, smallerCandidates } from '../src/index.js';

const samples = Array.from({ length: 5 }, (_, i) => ({
  input: `context ${i}`,
  expectedOutput: 'the service is healthy on port 8443',
}));
const ANSWER = 'the service is healthy on port 8443';

describe('model family detection + same-vendor ladders', () => {
  it('detects family + tier and lists smaller candidates (smallest-first)', () => {
    expect(detectModel('claude-opus-4-8')).toEqual({ family: 'anthropic', tierIndex: 0 });
    expect(smallerCandidates('claude-opus-4-8').map((c) => c.key)).toEqual(['haiku', 'sonnet']);
    expect(smallerCandidates('claude-sonnet-4-8').map((c) => c.key)).toEqual(['haiku']);
    expect(smallerCandidates('gemini-2.5-pro').map((c) => c.key)).toEqual(['flash-lite', 'flash']);
    expect(smallerCandidates('gpt-5').map((c) => c.key)).toEqual(['nano', 'mini']);
  });

  it('never crosses vendor families', () => {
    for (const c of smallerCandidates('claude-opus-4-8')) expect(c.openrouter.startsWith('anthropic/')).toBe(true);
    for (const c of smallerCandidates('gemini-2.5-pro')) expect(c.openrouter.startsWith('google/')).toBe(true);
  });

  it('smallest tier has no smaller candidate', () => {
    expect(smallerCandidates('claude-haiku-4-5')).toEqual([]);
  });
});

describe('evaluateRouting — cheapest-first, escalate up', () => {
  it('validates the smallest model when it reproduces the step', async () => {
    const r = await evaluateRouting('claude-opus-4-8', samples, {
      callModel: async (m) => (m.includes('haiku') ? ANSWER : 'garbage'),
    });
    expect(r.status).toBe('validated');
    expect(r.chosen?.tier).toBe('haiku'); // cheapest wins
    expect(r.attempts.map((a) => a.tier)).toEqual(['haiku']); // stopped at first pass
  });

  it('escalates to the next tier up when the smallest fails', async () => {
    const r = await evaluateRouting('claude-opus-4-8', samples, {
      callModel: async (m) => (m.includes('sonnet') ? ANSWER : 'garbage'),
    });
    expect(r.status).toBe('validated');
    expect(r.chosen?.tier).toBe('sonnet');
    expect(r.attempts.map((a) => a.tier)).toEqual(['haiku', 'sonnet']); // tried haiku, escalated
  });

  it('reports unfit when no smaller model reproduces the step', async () => {
    const r = await evaluateRouting('claude-opus-4-8', samples, { callModel: async () => 'garbage' });
    expect(r.status).toBe('unfit');
    expect(r.attempts).toHaveLength(2);
    expect(r.chosen).toBeUndefined();
  });

  it('retries a flaky call before failing the sample', async () => {
    let n = 0;
    const r = await evaluateRouting('claude-opus-4-8', samples.slice(0, 1), {
      minSamples: 1,
      retries: 2,
      callModel: async (m) => {
        if (!m.includes('haiku')) return 'garbage';
        n++;
        if (n % 3 === 1) throw new Error('rate limit'); // first attempt throws, retry succeeds
        return ANSWER;
      },
    });
    expect(r.status).toBe('validated');
    expect(r.chosen?.tier).toBe('haiku');
  });

  it('unknown vendor → unknown-model; already-smallest → no-candidate', async () => {
    expect((await evaluateRouting('llama-3-70b', samples, { callModel: async () => '' })).status).toBe('unknown-model');
    expect((await evaluateRouting('claude-haiku-4-5', samples, { callModel: async () => '' })).status).toBe('no-candidate');
  });
});

describe('outputSimilarity', () => {
  it('rewards reproducing the same content, tolerant of formatting', () => {
    expect(outputSimilarity('Service healthy on port 8443', 'service healthy on port 8443')).toBe(1);
    expect(outputSimilarity('completely different text', 'the service is healthy')).toBeLessThan(0.3);
  });
});
