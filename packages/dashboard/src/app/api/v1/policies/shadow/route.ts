import { resolveCaller, agentFor } from '@/lib/caller.ts';
import { getJson, putJson } from '@/lib/storage.ts';
import { getTenantProduct, usesRuntime } from '@/lib/tenant-settings.ts';
import {
  SUBAGENT_ROUTING_POLICY_ID,
  summarizeShadow,
  subagentRoutingPolicy,
  type ShadowSession,
  type ShadowSubagent,
} from '@/lib/engine/routing-shadow.ts';
import type { TokenUsage } from '@/lib/engine/types.ts';

export const dynamic = 'force-dynamic';

/**
 * Shadow results of the Claude Code subagent routing policy, posted by
 * `effigent claude` when Claude Code exits (lib/engine/routing-shadow.ts).
 * Metadata only by construction — models, token counts, costs, ids; never
 * prompt or output content.
 *
 *   POST { agent, sessions: ShadowSession[] }  → upsert by sessionId
 *   GET  ?agent=                               → { policy, summary, sessions }
 *
 * One JSON document per agent in the org's own bucket, capped to the newest
 * KEEP sessions. Read-modify-write: two sessions ending in the same instant can
 * lose one — acceptable for an estimate; move to a table if this becomes billing.
 */

const KEEP = 200;
const MAX_POST_SESSIONS = 20;
const MAX_SUBAGENTS = 200;

interface ShadowDoc {
  agent: string;
  sessions: ShadowSession[];
}

const keyOf = (agent: string) => `effigent/shadow/${agent.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200)}.json`;

async function gate(req: Request, requested: string | null | undefined) {
  const caller = await resolveCaller(req);
  if (!caller) return { res: Response.json({ error: 'unauthorized' }, { status: 401 }) };
  if (!usesRuntime(await getTenantProduct(caller.tenantId))) {
    return {
      res: Response.json(
        { error: 'the runtime is not enabled for this workspace', hint: 'an org admin can enable it under Workspace → Product' },
        { status: 403 },
      ),
    };
  }
  const which = agentFor(caller, requested);
  if ('error' in which) return { res: Response.json({ error: which.error }, { status: which.status }) };
  return { tenantId: caller.tenantId, agent: which.agent };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);

function usageOf(v: unknown): TokenUsage {
  const u = (v ?? {}) as Record<string, unknown>;
  const out: TokenUsage = {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheCreationInputTokens: num(u.cacheCreationInputTokens),
    cacheReadInputTokens: num(u.cacheReadInputTokens),
  };
  if (num(u.cacheCreation1hInputTokens)) out.cacheCreation1hInputTokens = num(u.cacheCreation1hInputTokens);
  return out;
}

/** Whitelist the shape: anything else a client sends is dropped, never stored. */
function cleanSession(v: unknown, agent: string): ShadowSession | null {
  const s = (v ?? {}) as Record<string, unknown>;
  const sessionId = str(s.sessionId);
  if (!sessionId || s.policyId !== SUBAGENT_ROUTING_POLICY_ID) return null;
  const subagents: ShadowSubagent[] = (Array.isArray(s.subagents) ? s.subagents : []).slice(0, MAX_SUBAGENTS).map((x) => {
    const a = (x ?? {}) as Record<string, unknown>;
    const sub: ShadowSubagent = {
      agentId: str(a.agentId) ?? 'unknown',
      model: str(a.model) ?? 'unknown',
      requests: num(a.requests),
      usage: usageOf(a.usage),
      costUsd: num(a.costUsd),
    };
    const to = str(a.wouldRouteTo);
    if (to) sub.wouldRouteTo = to;
    if (a.counterfactualUsd != null) sub.counterfactualUsd = num(a.counterfactualUsd);
    return sub;
  });
  return {
    sessionId,
    agent,
    policyId: SUBAGENT_ROUTING_POLICY_ID,
    policyVersion: num(s.policyVersion),
    startedAt: str(s.startedAt, 40),
    endedAt: str(s.endedAt, 40),
    requests: num(s.requests),
    costUsd: num(s.costUsd),
    mainCostUsd: num(s.mainCostUsd),
    subagents,
    wouldRoute: subagents.filter((x) => x.wouldRouteTo).length,
    // Recomputed from the cleaned rows so the stored total always matches them.
    estimatedSavingsUsd: subagents.reduce((t, x) => t + (x.wouldRouteTo ? Math.max(0, x.costUsd - (x.counterfactualUsd ?? x.costUsd)) : 0), 0),
  };
}

export async function POST(req: Request) {
  let body: { agent?: string; sessions?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const g = await gate(req, body.agent);
  if ('res' in g) return g.res;
  const incoming = (Array.isArray(body.sessions) ? body.sessions : [])
    .slice(0, MAX_POST_SESSIONS)
    .map((s) => cleanSession(s, g.agent))
    .filter((s): s is ShadowSession => s != null);
  if (!incoming.length) return Response.json({ error: 'no valid sessions' }, { status: 400 });
  try {
    const doc = (await getJson<ShadowDoc>(g.tenantId, keyOf(g.agent))) ?? { agent: g.agent, sessions: [] };
    const ids = new Set(incoming.map((s) => s.sessionId));
    const sessions = [...doc.sessions.filter((s) => !ids.has(s.sessionId)), ...incoming]
      .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
      .slice(-KEEP);
    await putJson(g.tenantId, keyOf(g.agent), { agent: g.agent, sessions });
    return Response.json({ ok: true, stored: incoming.length });
  } catch (err) {
    console.error(`[policies/shadow] store failed tenant=${g.tenantId} agent=${g.agent}:`, err);
    return Response.json({ error: 'run storage is not set up for this workspace' }, { status: 409 });
  }
}

export async function GET(req: Request) {
  const g = await gate(req, new URL(req.url).searchParams.get('agent'));
  if ('res' in g) return g.res;
  const policy = subagentRoutingPolicy(g.agent);
  try {
    const doc = await getJson<ShadowDoc>(g.tenantId, keyOf(g.agent));
    const sessions = doc?.sessions ?? [];
    return Response.json({ agent: g.agent, policy, summary: summarizeShadow(sessions), sessions: sessions.slice(-20).reverse() });
  } catch (err) {
    console.error(`[policies/shadow] read failed tenant=${g.tenantId} agent=${g.agent}:`, err);
    return Response.json({ agent: g.agent, policy, summary: summarizeShadow([]), sessions: [], note: 'Run storage is not set up for this workspace yet.' });
  }
}
