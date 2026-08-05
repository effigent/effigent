import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { loadRun } from '@/lib/storage.ts';
import { buildRunGraph } from '@/lib/engine/graph.ts';
import { buildRunBrief, renderBriefText, type RunBrief } from '@/lib/engine/brief.ts';
import { callOpenRouter, hasOpenRouterKey } from '@/lib/openrouter.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The session digest — the "what was this run actually about?" layer.
 *
 * GET  → the deterministic brief only: episode storyline (ask → intent →
 *        actions → cost → errors), outcome signals, artifacts. Instant, no LLM.
 * GET ?ai=1 → additionally has a model READ the brief (episode skeleton +
 *        bounded, ingest-redacted excerpts — never the raw run) and return a
 *        typed digest: title, tl;dr, outcome, per-episode narrative, friction.
 *
 * This is a deliberate posture change from /api/v1/explain (structure-only):
 * the product decision is that redacted run content MAY be read by the digest
 * model. Redaction happened at the persistRun choke point; excerpts are
 * length-capped again in buildRunBrief.
 */

const MODEL = process.env.EFFIGENT_DIGEST_MODEL ?? process.env.EFFIGENT_EXPLAIN_MODEL ?? 'anthropic/claude-sonnet-4.5';

export interface AiDigest {
  title: string;
  tldr: string;
  outcome: 'delivered' | 'partial' | 'abandoned' | 'unclear';
  outcomeNote: string;
  chapters: { episode: number; note: string }[];
  friction: string[];
}

// Digests are deterministic per stored run — cache per session for the process lifetime.
const CACHE = new Map<string, { brief: RunBrief; ai?: AiDigest; model?: string }>();

function digestPrompt(briefText: string): string {
  return [
    'You are summarizing one recorded session of an AI coding agent for the engineer who owns it.',
    'Below is a structured brief: per-episode skeleton (user ask → intent → tool actions → cost → errors)',
    'plus short excerpts. Sensitive values were already redacted as [REDACTED:…].',
    '',
    briefText,
    '',
    'Return ONLY a JSON object (no markdown fences, no prose) with exactly these fields:',
    '{',
    '  "title": "5-9 words naming what the session was about",',
    '  "tldr": "2-3 sentences: what was asked, what the agent did, how it ended",',
    '  "outcome": "delivered" | "partial" | "abandoned" | "unclear",',
    '  "outcomeNote": "one sentence of evidence for the outcome (cite artifacts/final message)",',
    '  "chapters": [{"episode": <index>, "note": "one plain sentence: what this episode did and whether it went smoothly"}],',
    '  "friction": ["up to 4 short bullets: where money/time was visibly wasted — error loops, interruptions, re-work. Cite the episode numbers. Empty array if none."]',
    '}',
    '',
    'Rules: describe only what the brief shows; never invent files, tools or results.',
    'Cover every episode listed. Judge outcome from artifacts and the final message, not optimism.',
  ].join('\n');
}

function parseAiDigest(text: string): AiDigest | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const d = JSON.parse(cleaned.slice(start, end + 1)) as Partial<AiDigest>;
    if (!d.title || !d.tldr) return null;
    return {
      title: String(d.title).slice(0, 120),
      tldr: String(d.tldr).slice(0, 600),
      outcome: (['delivered', 'partial', 'abandoned', 'unclear'] as const).includes(d.outcome as never)
        ? (d.outcome as AiDigest['outcome'])
        : 'unclear',
      outcomeNote: String(d.outcomeNote ?? '').slice(0, 300),
      chapters: Array.isArray(d.chapters)
        ? d.chapters.slice(0, 40).map((c) => ({
            episode: Number((c as { episode?: unknown }).episode ?? 0),
            note: String((c as { note?: unknown }).note ?? '').slice(0, 240),
          }))
        : [],
      friction: Array.isArray(d.friction) ? d.friction.slice(0, 4).map((f) => String(f).slice(0, 240)) : [],
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  const { id } = await ctx.params;
  const wantAi = new URL(req.url).searchParams.get('ai') === '1';

  const cached = CACHE.get(`${tenantId}|${id}`);
  if (cached && (!wantAi || cached.ai)) {
    return Response.json({ brief: cached.brief, ai: cached.ai ?? null, model: cached.model ?? null });
  }

  const { rows } = await pool.query(
    `select session_id, agent_id, started_at, cost_usd, blob_path, parsed
       from runs where tenant_id = $1 and session_id = $2 limit 1`,
    [tenantId, id],
  );
  if (!rows.length) return Response.json({ error: 'not found' }, { status: 404 });
  const run = await loadRun(tenantId, rows[0].blob_path ?? null, rows[0].parsed ?? null);
  if (!run?.steps?.length) return Response.json({ error: 'run content unavailable' }, { status: 404 });

  const normalized = {
    ...run,
    runId: rows[0].session_id,
    agentId: rows[0].agent_id,
    costUsd: Number(rows[0].cost_usd ?? run.costUsd ?? 0),
    usageByModel: run.usageByModel ?? {},
  };
  const brief = buildRunBrief(normalized, buildRunGraph(normalized));

  let ai: AiDigest | undefined;
  if (wantAi) {
    if (!hasOpenRouterKey()) {
      return Response.json({ brief, ai: null, error: 'AI digests need OPENROUTER_API_KEY on the server' }, { status: 501 });
    }
    try {
      const text = await callOpenRouter(MODEL, digestPrompt(renderBriefText(brief)), { maxTokens: 1200, timeoutMs: 50_000 });
      ai = parseAiDigest(text) ?? undefined;
      if (!ai) return Response.json({ brief, ai: null, error: 'model returned unparseable digest' }, { status: 502 });
    } catch (err) {
      return Response.json(
        { brief, ai: null, error: err instanceof Error ? err.message : 'digest failed' },
        { status: 502 },
      );
    }
  }

  CACHE.set(`${tenantId}|${id}`, { brief, ai, model: ai ? MODEL : undefined });
  return Response.json({ brief, ai: ai ?? null, model: ai ? MODEL : null });
}
