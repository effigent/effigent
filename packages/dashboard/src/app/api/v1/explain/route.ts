import { auth } from '@clerk/nextjs/server';
import { callOpenRouter, hasOpenRouterKey } from '@/lib/openrouter.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Plain-English explanation of one mined subtree.
 *
 * Why this exists: the metrics and the tree tell you WHAT was found, but not what the
 * optimizer would actually do about it, or why the verdict is what it is. That gap is
 * the whole complaint — an all-green tree next to "extract as sub-agent, 34%
 * confidence" is not self-explanatory.
 *
 * Two rules shape the prompt:
 *
 *  1. Only STRUCTURE is sent — step labels, counts, cost, stability figures. Never
 *     payloads. Run content lives in the org's own bucket and must not be shipped to
 *     a third-party model to produce a caption.
 *  2. The model explains the numbers it is given and must NOT upgrade the verdict.
 *     Determinism resting on two samples is the exact trap the Wilson bound exists to
 *     catch, so the prompt states the sample size and forbids recommending a compile
 *     when confidence is low.
 */

interface SubtreeNodeIn {
  structLabel?: string;
  level?: number;
  class?: string;
  determinism?: number;
  confidence?: number;
  distinctValues?: number;
  samples?: number;
}

interface Body {
  agentId?: string;
  rootLabel?: string;
  nodes?: number;
  span?: number;
  support?: number;
  runsTotal?: number;
  occurrences?: number;
  totalCostUsd?: number;
  determinism?: number;
  confidence?: number;
  mechanicalRatio?: number;
  action?: string;
  tree?: SubtreeNodeIn[];
}

const MODEL = process.env.EFFIGENT_EXPLAIN_MODEL ?? 'anthropic/claude-sonnet-4.5';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!hasOpenRouterKey()) {
    return Response.json(
      { error: 'explanations need OPENROUTER_API_KEY on the server' },
      { status: 501 },
    );
  }

  let b: Body;
  try {
    b = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!Array.isArray(b.tree) || b.tree.length === 0) {
    return Response.json({ error: 'tree required' }, { status: 400 });
  }

  const pct = (n: number | undefined) => `${Math.round((n ?? 0) * 100)}%`;
  const shape = b.tree
    .map((n) => {
      const indent = '  '.repeat(n.level ?? 0);
      return `${indent}- ${n.structLabel ?? '?'} [${n.class ?? '?'}] ` +
        `stable=${pct(n.determinism)} confidence=${pct(n.confidence)} ` +
        `distinct_payloads=${n.distinctValues ?? '?'} over ${n.samples ?? '?'} occurrences`;
    })
    .join('\n');

  const lowEvidence = (b.confidence ?? 0) < 0.6;

  const prompt = [
    'You are explaining one finding from an AI-agent execution optimizer to the engineer who owns the agent.',
    '',
    'The optimizer mined recurring DATAFLOW SUBTREES: a step plus the steps that consume',
    'its output values, matched across runs regardless of the order they were emitted in.',
    'Only structure is available to you — never the payloads.',
    '',
    `Agent: ${b.agentId ?? 'unknown'}`,
    `Root step: ${b.rootLabel ?? 'unknown'}`,
    `Size: ${b.nodes ?? '?'} steps, longest chain ${b.span ?? '?'} edges`,
    `Recurrence: appeared in ${b.support ?? '?'} of ${b.runsTotal ?? '?'} runs, ${b.occurrences ?? '?'} occurrences total`,
    `Measured cost across those occurrences: $${(b.totalCostUsd ?? 0).toFixed(2)}`,
    `Payload stability: ${pct(b.determinism)} (confidence ${pct(b.confidence)} — Wilson lower bound at n=${b.occurrences ?? '?'})`,
    `Steps needing no intelligence: ${pct(b.mechanicalRatio)}`,
    `Optimizer verdict: ${b.action ?? 'unknown'}`,
    '',
    'The subtree, indented by depth:',
    shape,
    '',
    'Write the explanation as exactly three short labelled paragraphs, no preamble, no markdown headers:',
    '',
    'WHAT: what this chain of steps is doing, in the domain terms the labels imply.',
    `WHY: why the optimizer reached the verdict "${b.action ?? 'unknown'}", citing the specific numbers above.`,
    'DO: the concrete change to make, or state plainly that no change is justified yet and what evidence would be needed.',
    '',
    'Hard constraints:',
    '- Explain only what the numbers support. Do not invent behaviour the labels do not show.',
    lowEvidence
      ? `- Confidence is only ${pct(b.confidence)} because stability rests on ${b.occurrences ?? '?'} occurrences. Even though per-step stability reads high, that is NOT evidence of determinism. You must NOT recommend compiling or replacing this with code. Say what stronger evidence would look like.`
      : '- Confidence is adequate, so a compile/replace recommendation is defensible if stability is high.',
    '- If most steps are generative (LLM turns), extraction behind a narrow interface or routing to a cheaper model is the realistic action, not compilation.',
    '- Under 130 words total. Be concrete and plain. No bullet lists.',
  ].join('\n');

  try {
    const text = await callOpenRouter(MODEL, prompt, { maxTokens: 500, timeoutMs: 45_000 });
    if (!text.trim()) return Response.json({ error: 'model returned nothing' }, { status: 502 });
    return Response.json({ explanation: text.trim(), model: MODEL });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'explain failed' },
      { status: 502 },
    );
  }
}
