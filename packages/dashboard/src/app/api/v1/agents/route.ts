import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const dynamic = 'force-dynamic';

/** This tenant's agents (from their Clerk org / personal workspace). */
export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  const { rows } = await pool.query(
    `select agent_id,
            count(*)::int           as n_runs,
            round(sum(cost_usd), 2) as total_cost_usd,
            max(started_at)         as last_seen,
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
