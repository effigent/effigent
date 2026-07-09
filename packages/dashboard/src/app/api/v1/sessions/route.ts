import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const dynamic = 'force-dynamic';

/** Recent runs (sessions) for this org, newest first. Optional ?agent= filter. */
export async function GET(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  const agent = new URL(req.url).searchParams.get('agent') || undefined;
  const { rows } = await pool.query(
    agent
      ? `select session_id, agent_id, started_at, ended_at, cost_usd, n_steps, models
           from runs where tenant_id = $1 and agent_id ilike '%' || $2 || '%'
          order by started_at desc nulls last limit 200`
      : `select session_id, agent_id, started_at, ended_at, cost_usd, n_steps, models
           from runs where tenant_id = $1
          order by started_at desc nulls last limit 200`,
    agent ? [tenantId, agent] : [tenantId],
  );
  return Response.json({ sessions: rows });
}
