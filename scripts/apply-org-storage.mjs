#!/usr/bin/env node
/**
 * Applies migration 012 (per-org S3 storage columns) to prod. Idempotent.
 *
 * Usage:
 *   PROD_DATABASE_URL="postgres://…?sslmode=require" \
 *     node scripts/apply-org-storage.mjs
 *
 *   # inspect current per-org storage config:
 *   PROD_DATABASE_URL=… node scripts/apply-org-storage.mjs --list
 */
import pg from 'pg';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL.'); process.exit(1); }
const list = process.argv.slice(2).includes('--list');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const cols = [
  'storage_bucket text',
  'storage_region text',
  'storage_prefix text',
  'storage_kms_key text',
  'storage_role_arn text',
  'storage_external_id text',
  'storage_provisioned_at timestamptz',
];
for (const col of cols) {
  await c.query(`alter table tenants add column if not exists ${col}`);
}
console.log('✓ 012 tenants.storage_* columns applied');

if (list) {
  const { rows } = await c.query(
    `select clerk_ref, storage_bucket, storage_region, storage_role_arn is not null as byo, storage_provisioned_at
       from tenants order by storage_provisioned_at desc nulls last`,
  );
  console.table(rows);
}

await c.end();
