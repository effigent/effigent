import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const dynamic = 'force-dynamic';

/**
 * Runs (sessions) for this org, newest first. Paginated out of the box:
 * ?agent= exact-ish agent filter, ?q= session-id substring search (server-side,
 * so it spans all pages), ?limit= (default 50, max 200), ?offset=.
 * Returns { sessions, total, limit, offset }.
 */
export async function GET(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  const params = new URL(req.url).searchParams;
  const agent = params.get('agent') || undefined;
  const q = params.get('q') || undefined;
  const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));
  const offset = Math.max(0, Number(params.get('offset')) || 0);

  const where: string[] = ['tenant_id = $1'];
  const args: unknown[] = [tenantId];
  if (agent) {
    args.push(agent);
    where.push(`agent_id ilike '%' || $${args.length} || '%'`);
  }
  if (q) {
    args.push(q);
    where.push(`session_id ilike '%' || $${args.length} || '%'`);
  }
  const cond = where.join(' and ');

  const [rows, count] = await Promise.all([
    pool.query(
      `select session_id, agent_id, started_at, ended_at, cost_usd, n_steps, models
         from runs where ${cond}
        order by started_at desc nulls last
        limit ${limit} offset ${offset}`,
      args,
    ),
    pool.query<{ n: string }>(`select count(*)::text as n from runs where ${cond}`, args),
  ]);

  return Response.json({ sessions: rows.rows, total: Number(count.rows[0].n), limit, offset });
}
