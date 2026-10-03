import { resolveCaller, agentFor } from '@/lib/caller.ts';
import { getTenantProduct, usesRuntime } from '@/lib/tenant-settings.ts';
import type { PolicyBundle } from '@/lib/engine/policy.ts';
import { SUBAGENT_ROUTING_VERSION, subagentRoutingPolicy } from '@/lib/engine/routing-shadow.ts';

export const dynamic = 'force-dynamic';

/**
 * The policy bundle the runtime (`@effigent/runtime`) executes for one agent:
 * `GET ?agent=` → { agent, version, policies } (lib/engine/policy.ts).
 * Only for workspaces that use the runtime (403 otherwise). Bearer key or a
 * signed-in user (lib/caller.ts); a scoped key reads its own agent only.
 *
 * Analyzer-produced policies: none yet — that needs a prefix matcher
 * (recognising a pattern from the START of a live run). Served today: the
 * hand-written Claude Code subagent routing policy, in SHADOW (`effigent claude`
 * records what it would route and posts it to ./shadow; nothing is changed).
 */
export async function GET(req: Request) {
  const caller = await resolveCaller(req);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!usesRuntime(await getTenantProduct(caller.tenantId))) {
    return Response.json(
      { error: 'the runtime is not enabled for this workspace', hint: 'an org admin can enable it under Workspace → Product' },
      { status: 403 },
    );
  }
  const which = agentFor(caller, new URL(req.url).searchParams.get('agent'));
  if ('error' in which) return Response.json({ error: which.error }, { status: which.status });

  const bundle: PolicyBundle = {
    agent: which.agent,
    version: `routing-${SUBAGENT_ROUTING_VERSION}`,
    policies: [subagentRoutingPolicy(which.agent)],
  };
  return Response.json(bundle);
}
