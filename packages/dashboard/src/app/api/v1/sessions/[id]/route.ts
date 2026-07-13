import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { loadRun } from '@/lib/storage.ts';

export const dynamic = 'force-dynamic';

/** One session's stored run (the parsed Run + its step list) for the DAG deep-dive.
 *  Run content lives in the org's S3 bucket; only metadata is in Neon. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  const { id } = await ctx.params;

  const { rows } = await pool.query(
    `select session_id, agent_id, started_at, ended_at, cost_usd, n_steps, models, blob_path, parsed
       from runs where tenant_id = $1 and session_id = $2 limit 1`,
    [tenantId, id],
  );
  if (!rows.length) return Response.json({ error: 'not found' }, { status: 404 });
  const row = rows[0];
  // Fetch the run content from the org's bucket (or inline parsed for legacy rows).
  const parsed = await loadRun(tenantId, row.blob_path ?? null, row.parsed ?? null);
  return Response.json({ run: { ...row, blob_path: undefined, parsed } });
}
