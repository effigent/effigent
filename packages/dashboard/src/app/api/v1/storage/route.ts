import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { invalidateStorage, putRunBlob, getRunBlob } from '@/lib/storage.ts';

export const dynamic = 'force-dynamic';

/**
 * Per-org run storage settings (S3-only residency). GET shows where this org's
 * run blobs live; PUT (org-admin only) points capture at a bucket — either a
 * BYO bucket in the org's own account (role_arn + external_id) or an
 * Effigent-account bucket. A PUT runs a write→read probe to prove access before
 * declaring the workspace provisioned. Values here are identifiers, not
 * credentials (AWS creds live in Vercel env or the assumed cross-account role).
 */

const canEditOf = (orgId?: string | null, orgRole?: string | null) =>
  !orgId || orgRole === 'org:admin' || orgRole === 'admin';

let col: boolean | null = null;
async function migrated(): Promise<boolean> {
  if (col !== null) return col;
  try {
    const r = await pool.query(
      `select 1 from information_schema.columns where table_name='tenants' and column_name='storage_bucket'`,
    );
    col = (r.rowCount ?? 0) > 0;
  } catch {
    col = false;
  }
  return col;
}

export async function GET() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  if (!(await migrated())) {
    return Response.json({ migrated: false, provisioned: false, canEdit: canEditOf(orgId, orgRole) });
  }
  const { rows } = await pool.query(
    `select storage_bucket, storage_region, storage_prefix, storage_kms_key,
            storage_role_arn, storage_external_id, storage_provisioned_at
       from tenants where id = $1`,
    [tenantId],
  );
  const r = rows[0] ?? {};
  return Response.json({
    migrated: true,
    provisioned: !!r.storage_bucket,
    mode: r.storage_role_arn ? 'byo' : r.storage_bucket ? 'effigent' : 'none',
    bucket: r.storage_bucket ?? null,
    region: r.storage_region ?? null,
    prefix: r.storage_prefix ?? null,
    kmsKey: r.storage_kms_key ?? null,
    roleArn: r.storage_role_arn ?? null,
    externalId: r.storage_external_id ?? null,
    provisionedAt: r.storage_provisioned_at ?? null,
    canEdit: canEditOf(orgId, orgRole),
  });
}

export async function PUT(req: Request) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!canEditOf(orgId, orgRole)) {
    return Response.json({ error: 'only organization admins can change storage settings' }, { status: 403 });
  }
  if (!(await migrated())) {
    return Response.json({ error: 'storage columns not migrated yet (run scripts/apply-org-storage.mjs)' }, { status: 409 });
  }
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  let body: {
    bucket?: string; region?: string; prefix?: string; kmsKey?: string;
    roleArn?: string; externalId?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const bucket = (body.bucket ?? '').trim();
  if (!bucket || !/^[a-z0-9.\-]{3,63}$/.test(bucket)) {
    return Response.json({ error: 'a valid S3 bucket name is required' }, { status: 400 });
  }

  await pool.query(
    `update tenants set storage_bucket=$2, storage_region=$3, storage_prefix=$4,
            storage_kms_key=$5, storage_role_arn=$6, storage_external_id=$7,
            storage_provisioned_at=now()
       where id=$1`,
    [
      tenantId,
      bucket,
      (body.region ?? '').trim() || null,
      (body.prefix ?? '').trim() || null,
      (body.kmsKey ?? '').trim() || null,
      (body.roleArn ?? '').trim() || null,
      (body.externalId ?? '').trim() || null,
    ],
  );
  invalidateStorage(tenantId);

  // Prove access: write a probe object and read it back. If this fails, the
  // config is saved but the workspace is not actually usable — report it.
  try {
    const key = `.effigent/probe-${tenantId.slice(0, 8)}.json.gz`;
    const uri = await putRunBlob(tenantId, key, JSON.stringify({ probe: true }));
    const round = JSON.parse(await getRunBlob(tenantId, uri)) as { probe?: boolean };
    if (!round.probe) throw new Error('probe round-trip mismatch');
  } catch (err) {
    return Response.json(
      { ok: false, saved: true, probe: 'failed', error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  return Response.json({ ok: true, provisioned: true, probe: 'passed', bucket });
}
