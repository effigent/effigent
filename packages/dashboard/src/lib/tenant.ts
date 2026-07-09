import { randomBytes, createHash } from 'node:crypto';
import { pool } from './db.ts';

const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

/**
 * Map a Clerk subject to our tenant. A Clerk Organization is a tenant; a user
 * with no active org gets a personal tenant. Find-or-create, keyed by clerk_ref.
 */
export async function resolveTenant({ userId, orgId }: { userId: string; orgId: string | null }): Promise<string> {
  const ref = orgId ? `org:${orgId}` : `user:${userId}`;
  const found = await pool.query<{ id: string }>('select id from tenants where clerk_ref = $1', [ref]);
  if (found.rows.length) return found.rows[0].id;

  const t = await pool.query<{ id: string }>(
    `insert into tenants (name, clerk_ref) values ($1,$2)
     on conflict (clerk_ref) do update set name = tenants.name returning id`,
    [orgId ?? userId, ref],
  );
  const tid = t.rows[0].id;
  // A default owner api key so agents can ingest under this tenant.
  const apiKey = `cck_${randomBytes(24).toString('hex')}`;
  await pool
    .query("insert into api_keys (tenant_id, key_hash, label, role) values ($1,$2,'dashboard','owner')", [tid, hashKey(apiKey)])
    .catch(() => {});
  return tid;
}
