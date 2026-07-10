import { randomBytes } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { authenticateKey, hashKey, hasOwnershipColumns } from '@/lib/agent-auth.ts';

export const dynamic = 'force-dynamic';

/**
 * POST — CLI agent registration (`ccopt agent add`): Bearer tenant key →
 * upsert the agent and mint a member key scoped to it. Plaintext returned once.
 */
export async function POST(req: Request) {
  const keyAuth = await authenticateKey(req.headers.get('authorization'));
  if (!keyAuth) return Response.json({ error: 'invalid API key' }, { status: 401 });
  if (keyAuth.agentId) {
    return Response.json({ error: 'agent registration requires a tenant key, not an agent-scoped key' }, { status: 403 });
  }
  let body: { name?: string; harness?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  if (!body.name) return Response.json({ error: 'name required' }, { status: 400 });

  // Plan limit: distinct registered agents per tenant. tenants.max_agents wins
  // (set per plan / design-partner deal); null or missing column → default.
  const DEFAULT_MAX_AGENTS = 2; // Free tier
  let maxAgents = DEFAULT_MAX_AGENTS;
  try {
    const t = await pool.query<{ max_agents: number | null }>(
      'select max_agents from tenants where id = $1', [keyAuth.tenantId],
    );
    if (t.rows[0]?.max_agents != null) maxAgents = t.rows[0].max_agents;
  } catch { /* column not migrated yet → default */ }
  const existing = await pool.query<{ n: string; known: boolean }>(
    `select count(*)::text as n,
            bool_or(name = $2) as known
       from agents where tenant_id = $1`,
    [keyAuth.tenantId, body.name],
  );
  const count = Number(existing.rows[0]?.n ?? 0);
  const isReRegister = existing.rows[0]?.known === true;
  if (!isReRegister && count >= maxAgents) {
    return Response.json(
      { error: `agent limit reached (${maxAgents} for this workspace) — contact us to raise it` },
      { status: 403 },
    );
  }

  // Ownership: the agent inherits whoever minted the key that registered it
  // ("who added this agent"). First adder wins; re-registration never steals.
  const withOwner = await hasOwnershipColumns();
  const agent = withOwner
    ? await pool.query<{ id: string }>(
        `insert into agents (tenant_id, name, harness, created_by, created_by_label) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, name) do update
           set harness = coalesce(excluded.harness, agents.harness),
               created_by = coalesce(agents.created_by, excluded.created_by),
               created_by_label = coalesce(agents.created_by_label, excluded.created_by_label)
         returning id`,
        [keyAuth.tenantId, body.name, body.harness ?? null, keyAuth.createdBy ?? null, keyAuth.createdByLabel ?? null],
      )
    : await pool.query<{ id: string }>(
        `insert into agents (tenant_id, name, harness) values ($1,$2,$3)
         on conflict (tenant_id, name) do update set harness = coalesce(excluded.harness, agents.harness)
         returning id`,
        [keyAuth.tenantId, body.name, body.harness ?? null],
      );
  const apiKey = `eff_${randomBytes(24).toString('hex')}`;
  await pool.query(
    withOwner
      ? `insert into api_keys (tenant_id, key_hash, label, role, agent_id, created_by, created_by_label) values ($1,$2,$3,'member',$4,$5,$6)`
      : `insert into api_keys (tenant_id, key_hash, label, role, agent_id) values ($1,$2,$3,'member',$4)`,
    withOwner
      ? [keyAuth.tenantId, hashKey(apiKey), body.name, agent.rows[0].id, keyAuth.createdBy ?? null, keyAuth.createdByLabel ?? null]
      : [keyAuth.tenantId, hashKey(apiKey), body.name, agent.rows[0].id],
  );
  return Response.json({ agentId: agent.rows[0].id, name: body.name, apiKey });
}

/**
 * This tenant's agents, derived from their runs. `optimized` is true when the
 * agent has been through an optimization pass (agents.optimized_at set). That
 * column is optional — the query degrades gracefully if its migration hasn't
 * been applied yet.
 */
export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  const hasOptCol =
    (
      await pool.query(
        `select 1 from information_schema.columns where table_name = 'agents' and column_name = 'optimized_at'`,
      )
    ).rowCount ?? 0;
  const optimizedExpr = hasOptCol
    ? `(select a.optimized_at is not null from agents a
          where a.tenant_id = runs.tenant_id and a.name = runs.agent_id)`
    : `false`;
  const hasOwnerCol =
    (
      await pool.query(
        `select 1 from information_schema.columns where table_name = 'agents' and column_name = 'created_by'`,
      )
    ).rowCount ?? 0;
  const addedByExpr = hasOwnerCol
    ? `(select coalesce(a.created_by_label, a.created_by) from agents a
          where a.tenant_id = runs.tenant_id and a.name = runs.agent_id)`
    : `null`;

  const { rows } = await pool.query(
    `select agent_id,
            count(*)::int           as n_runs,
            round(sum(cost_usd), 2) as total_cost_usd,
            max(started_at)         as last_seen,
            ${addedByExpr}          as added_by,
            coalesce(${optimizedExpr}, false) as optimized,
            (select coalesce(jsonb_agg(distinct m), '[]'::jsonb)
               from runs r2, jsonb_array_elements_text(r2.models) m
              where r2.tenant_id = runs.tenant_id and r2.agent_id = runs.agent_id) as models
       from runs
      where tenant_id = $1
      group by tenant_id, agent_id
      order by sum(cost_usd) desc`,
    [tenantId],
  );
  return Response.json({ agents: rows, tenantId });
}
