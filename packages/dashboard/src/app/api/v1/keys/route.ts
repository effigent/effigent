import { randomBytes, createHash } from 'node:crypto';
import { auth, currentUser } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { hasOwnershipColumns } from '@/lib/agent-auth.ts';

export const dynamic = 'force-dynamic';

/**
 * Workspace API keys. Keys are stored as SHA-256 hashes — the plaintext exists
 * only in the POST response that minted it. GET lists metadata (never values).
 */

export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  const withOwner = await hasOwnershipColumns();
  const { rows } = await pool.query(
    `select k.id, k.label, k.role, k.created_at, k.last_used_at, a.name as agent${withOwner ? ', coalesce(k.created_by_label, k.created_by) as added_by' : ''}
       from api_keys k left join agents a on a.id = k.agent_id
      where k.tenant_id = $1
      order by k.created_at desc`,
    [tenantId],
  );
  return Response.json({ tenantId, keys: rows });
}

export async function POST(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  let label = 'workspace';
  try {
    const body = (await req.json()) as { label?: string };
    if (body.label && typeof body.label === 'string') label = body.label.slice(0, 60);
  } catch { /* empty body is fine */ }

  // Owner key: full workspace access — this is the key `effigent login` takes.
  // Stamped with the minting user so agents registered with it inherit ownership.
  const apiKey = `eff_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(apiKey).digest('hex');
  const withOwner = await hasOwnershipColumns();
  if (withOwner) {
    const u = await currentUser().catch(() => null);
    const who =
      u?.primaryEmailAddress?.emailAddress ??
      u?.emailAddresses?.[0]?.emailAddress ??
      ([u?.firstName, u?.lastName].filter(Boolean).join(' ') || null);
    await pool.query(
      `insert into api_keys (tenant_id, key_hash, label, role, created_by, created_by_label) values ($1,$2,$3,'owner',$4,$5)`,
      [tenantId, hash, label, userId, who],
    );
  } else {
    await pool.query(
      `insert into api_keys (tenant_id, key_hash, label, role) values ($1,$2,$3,'owner')`,
      [tenantId, hash, label],
    );
  }
  // Plaintext leaves the server exactly once, here.
  return Response.json({ apiKey, tenantId });
}
