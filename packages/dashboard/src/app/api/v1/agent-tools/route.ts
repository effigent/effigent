import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const dynamic = 'force-dynamic';

/**
 * The per-agent injected-tool registry (dashboard view + switches). Rows are
 * written by /api/v1/optimize on every generation; `enabled` belongs to the
 * owner and survives regenerations. Disabling a tool drops it from the next
 * bundle refresh (session start / `effigent optimize`).
 */

let tableChecked: boolean | null = null;
async function hasTable(): Promise<boolean> {
  if (tableChecked !== null) return tableChecked;
  try {
    const r = await pool.query(`select 1 from information_schema.tables where table_name = 'agent_tools'`);
    tableChecked = (r.rowCount ?? 0) > 0;
  } catch {
    tableChecked = false;
  }
  return tableChecked;
}

interface SpecLite {
  body?: unknown[];
  params?: unknown[];
  savings?: { perRunUsd?: number };
  evidence?: { runs?: number; support?: number };
  replay?: { passRate?: number; runsChecked?: number };
}

export async function GET(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  const agent = new URL(req.url).searchParams.get('agent');
  if (!agent) return Response.json({ error: 'agent required' }, { status: 400 });
  if (!(await hasTable())) return Response.json({ agent, tools: [], migrated: false });

  const { rows } = await pool.query<{ tool_id: string; name: string; status: string; enabled: boolean; updated_at: string; spec: SpecLite }>(
    `select tool_id, name, status, enabled, updated_at, spec
       from agent_tools where tenant_id = $1 and agent_id = $2
      order by (spec->'savings'->>'windowUsd')::numeric desc nulls last`,
    [tenantId, agent],
  );
  return Response.json({
    agent,
    migrated: true,
    tools: rows.map((r) => ({
      toolId: r.tool_id,
      name: r.name,
      status: r.status,
      enabled: r.enabled,
      updatedAt: r.updated_at,
      steps: r.spec.body?.length ?? 0,
      params: r.spec.params?.length ?? 0,
      perRunUsd: r.spec.savings?.perRunUsd ?? 0,
      support: r.spec.evidence?.support ?? 0,
      runs: r.spec.evidence?.runs ?? 0,
      passRate: r.spec.replay?.passRate ?? null,
    })),
  });
}

export async function PUT(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  if (!(await hasTable())) {
    return Response.json({ error: 'agent_tools not migrated — run scripts/apply-ownership-redaction.mjs' }, { status: 409 });
  }
  let body: { agent?: string; toolId?: string; enabled?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!body.agent || !body.toolId || typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'agent, toolId, enabled required' }, { status: 400 });
  }
  const r = await pool.query(
    `update agent_tools set enabled = $4, updated_at = now()
      where tenant_id = $1 and agent_id = $2 and tool_id = $3`,
    [tenantId, body.agent, body.toolId, body.enabled],
  );
  if ((r.rowCount ?? 0) === 0) return Response.json({ error: 'tool not found' }, { status: 404 });
  return Response.json({ ok: true, toolId: body.toolId, enabled: body.enabled });
}
