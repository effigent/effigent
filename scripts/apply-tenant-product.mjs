#!/usr/bin/env node
/**
 * Applies migration 014 (tenants.product — which Effigent product a workspace uses:
 * insights | runtime | both) to prod. Idempotent — safe to re-run. Every existing
 * workspace defaults to 'insights', so nothing changes until an admin picks.
 *
 * Usage:
 *   # inspect only — no writes:
 *   PROD_DATABASE_URL="postgres://…?sslmode=require" node scripts/apply-tenant-product.mjs --check
 *
 *   # apply the migration:
 *   PROD_DATABASE_URL=… node scripts/apply-tenant-product.mjs
 *
 *   # apply + set one workspace's product (design partners for the runtime):
 *   PROD_DATABASE_URL=… node scripts/apply-tenant-product.mjs --set runtime --tenant <clerk_ref-substr>
 */
import pg from 'pg';

const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error('Set PROD_DATABASE_URL (Neon connection string, include ?sslmode=require).');
  process.exit(1);
}
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const checkOnly = argv.includes('--check');
const setTo = flag('--set');
const tenantRef = flag('--tenant');
const PRODUCTS = ['insights', 'runtime', 'both'];

const localish = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const c = new pg.Client({ connectionString: url, ...(localish ? {} : { ssl: { rejectUnauthorized: false } }) });
await c.connect();

const hasColumn = async () =>
  ((await c.query(`select 1 from information_schema.columns where table_name = 'tenants' and column_name = 'product'`))
    .rowCount ?? 0) > 0;

const list = async () => {
  const { rows } = await c.query('select clerk_ref, name, product from tenants order by clerk_ref');
  console.table(rows);
};

const before = await hasColumn();
console.log(`tenants.product present: ${before}`);
if (checkOnly) {
  if (before) await list();
  await c.end();
  process.exit(0);
}

await c.query(`alter table tenants add column if not exists product text not null default 'insights'`);
await c.query(`do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_product_check') then
    alter table tenants add constraint tenants_product_check check (product in ('insights', 'runtime', 'both'));
  end if;
end $$;`);
console.log(before ? '✓ 014 already applied — nothing to do' : '✓ 014 applied — every workspace starts on insights');

if (setTo !== undefined) {
  if (!PRODUCTS.includes(setTo)) {
    console.error(`✗ --set must be one of ${PRODUCTS.join(' | ')} (got ${setTo})`);
    await c.end();
    process.exit(1);
  }
  if (!tenantRef) {
    console.error('✗ --set needs --tenant <clerk_ref-substr> (refusing to change every workspace)');
    await c.end();
    process.exit(1);
  }
  const { rows } = await c.query('update tenants set product = $1 where clerk_ref like $2 returning clerk_ref, product', [
    setTo,
    `%${tenantRef}%`,
  ]);
  if (!rows.length) console.error(`✗ no tenant matched ${tenantRef} — unchanged`);
  else console.log(`✓ product set to ${setTo} for ${rows.length} tenant(s)`);
}
await list();
await c.end();
