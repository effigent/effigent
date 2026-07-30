#!/usr/bin/env node
/**
 * Applies migration 013 (runs.parsed nullable) to prod, and optionally raises a
 * workspace's agent limit. Idempotent — safe to re-run.
 *
 * Why this exists: S3-only residency inserts `parsed = NULL`, but 001_init.sql
 * declared `runs.parsed jsonb not null` and no migration ever relaxed it. Every
 * ingest has been failing with 23502 (bare HTTP 500) while the S3 blob was already
 * written — content in the bucket, no row, empty dashboard.
 *
 * Usage:
 *   # inspect only — no writes:
 *   PROD_DATABASE_URL="postgres://…?sslmode=require" \
 *     node scripts/apply-parsed-nullable.mjs --check
 *
 *   # apply the migration:
 *   PROD_DATABASE_URL=… node scripts/apply-parsed-nullable.mjs
 *
 *   # apply + raise one workspace's agent limit (per-project attribution needs
 *   # one agent per repo; the free-tier default is 2):
 *   PROD_DATABASE_URL=… node scripts/apply-parsed-nullable.mjs --max-agents 20
 *   PROD_DATABASE_URL=… node scripts/apply-parsed-nullable.mjs --max-agents 20 --tenant <clerk_ref-substr>
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
const maxAgents = flag('--max-agents');
const tenantRef = flag('--tenant');

// Managed Postgres (Neon) needs TLS; a local docker instance has none. Deciding from
// the URL keeps this script runnable against a scratch DB, which is how it gets
// verified before it is ever pointed at prod.
const localish = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const c = new pg.Client({ connectionString: url, ...(localish ? {} : { ssl: { rejectUnauthorized: false } }) });
await c.connect();

const nullability = async () => {
  const { rows } = await c.query(
    `select is_nullable from information_schema.columns
      where table_name = 'runs' and column_name = 'parsed'`,
  );
  return rows[0]?.is_nullable; // 'YES' | 'NO' | undefined
};

const before = await nullability();
console.log(`runs.parsed nullable: ${before ?? '(column missing!)'}`);

if (checkOnly) {
  const { rows: t } = await c.query(
    `select clerk_ref, max_agents,
            (select count(*) from agents a where a.tenant_id = t.id) as agents,
            (select count(*) from runs r where r.tenant_id = t.id) as runs
       from tenants t order by clerk_ref`,
  );
  console.table(t);
  const { rows: recent } = await c.query(
    `select created_at::date as day, count(*)::int as runs from runs group by 1 order by 1 desc limit 7`,
  );
  console.table(recent);
  await c.end();
  process.exit(0);
}

if (before === 'NO') {
  await c.query('alter table runs alter column parsed drop not null');
  console.log('✓ 013 applied — runs.parsed is now nullable (ingest unblocked)');
} else if (before === 'YES') {
  console.log('✓ already nullable — nothing to do');
} else {
  console.error('✗ runs.parsed not found; is PROD_DATABASE_URL pointing at the right database?');
  await c.end();
  process.exit(1);
}

if (maxAgents !== undefined) {
  const n = Number(maxAgents);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`✗ --max-agents must be a positive integer (got ${maxAgents})`);
    await c.end();
    process.exit(1);
  }
  // Scope by clerk_ref substring when given, so a multi-tenant prod isn't raised wholesale.
  const { rows } = tenantRef
    ? await c.query(
        'update tenants set max_agents = $1 where clerk_ref like $2 returning clerk_ref, max_agents',
        [n, `%${tenantRef}%`],
      )
    : await c.query('update tenants set max_agents = $1 returning clerk_ref, max_agents', [n]);
  if (!rows.length) console.error(`✗ no tenant matched ${tenantRef ?? '(all)'} — limit unchanged`);
  else {
    console.log(`✓ agent limit raised to ${n} for ${rows.length} tenant(s)`);
    console.table(rows);
  }
}

// Orphan report: blobs written to S3 whose insert failed have no row at all, so
// they cannot be counted here — this only shows what DID land, as a sanity check.
const { rows: after } = await c.query(
  `select count(*)::int as total,
          count(*) filter (where blob_path is not null and parsed is null)::int as s3_rows,
          count(*) filter (where parsed is not null)::int as legacy_inline_rows,
          max(created_at)::text as newest
     from runs`,
);
console.table(after);
console.log('\nNext: re-run a capture (or `effigent sync --days 7`) and confirm HTTP 200.');
console.log('Runs uploaded while the constraint was live are orphaned in S3 —');
console.log('recover them with: PROD_DATABASE_URL=… node scripts/backfill-orphaned-runs.mjs --dry-run');

await c.end();
