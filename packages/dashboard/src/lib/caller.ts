import { auth } from '@clerk/nextjs/server';
import { authenticateKey } from './agent-auth.ts';
import { resolveTenant } from './tenant.ts';

/**
 * Who is calling a route both people and agents use: a Bearer `eff_`/`cck_` key
 * (the CLI, or a coding agent through it) or a signed-in dashboard user. Routes
 * using this must be listed as public in middleware.ts — the Bearer path has no
 * Clerk session — and Clerk's auth() still resolves a signed-in browser there.
 */
export interface Caller {
  tenantId: string;
  /** A scoped key is bound to one agent and may only act on it. */
  pinnedAgent?: string;
  /** Recorded as `appliedBy`: the Clerk user id, or `key:<label>`. */
  actor: string;
}

export async function resolveCaller(req: Request): Promise<Caller | null> {
  const header = req.headers.get('authorization');
  if (header) {
    const key = await authenticateKey(header);
    if (!key) return null;
    return { tenantId: key.tenantId, pinnedAgent: key.agentName, actor: `key:${key.agentName ?? key.createdByLabel ?? key.role}` };
  }
  const { userId, orgId } = await auth();
  if (!userId) return null;
  return { tenantId: await resolveTenant({ userId, orgId: orgId ?? null }), actor: userId };
}

/** The agent a request may act on: the pinned one, or the one it asked for. */
export function agentFor(caller: Caller, requested: string | null | undefined): { agent: string } | { error: string; status: number } {
  if (caller.pinnedAgent && requested && requested !== caller.pinnedAgent) return { error: 'scoped key is bound to a different agent', status: 403 };
  const agent = caller.pinnedAgent ?? requested;
  return agent ? { agent } : { error: 'agent required', status: 400 };
}
