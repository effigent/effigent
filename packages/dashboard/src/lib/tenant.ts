import { randomBytes, createHash } from 'node:crypto';
import { pool } from './db.ts';
import { hasOwnershipColumns } from './agent-auth.ts';

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
     on conflict (clerk_ref) where clerk_ref is not null do update set name = tenants.name returning id`,
    [orgId ?? userId, ref],
  );
  const tid = t.rows[0].id;
  // A default owner api key so agents can ingest under this tenant. Stamped
  // with the creating user (migration 009) so agents registered with it
  // inherit ownership; degrades to the unstamped insert pre-migration.
  const apiKey = `eff_${randomBytes(24).toString('hex')}`;
  const withOwner = await hasOwnershipColumns().catch(() => false);
  await pool
    .query(
      withOwner
        ? "insert into api_keys (tenant_id, key_hash, label, role, created_by) values ($1,$2,'dashboard','owner',$3)"
        : "insert into api_keys (tenant_id, key_hash, label, role) values ($1,$2,'dashboard','owner')",
      withOwner ? [tid, hashKey(apiKey), userId] : [tid, hashKey(apiKey)],
    )
    .catch(() => {});
  return tid;
}
