#!/usr/bin/env node
/**
 * Recomputes `runs.cost_usd` with the corrected pricing (docs/context-rent.md).
 *
 * Every row written before the pricing fix is overstated ~2.3×: all Opus was
 * priced at the Opus-4.1 rate and every cache write at the 5-minute multiplier.
 * This reloads each run (S3 blob or legacy inline `parsed`) and re-prices its
 * stored `usageByModel` with packages/core's `usageCostUsd`.
 *
 * Old blobs carry no 5m/1h split, so writes without `cacheCreation1hInputTokens`
 * are priced as 1-hour writes (99% of measured writes are 1h — Claude Code's
 * default). Advisor-tool usage was never captured in old blobs and cannot be
 * recovered; re-uploading a session (effigent sync) re-parses it fully.
 * `<synthetic>` usage is dropped (harness messages, never billed).
 *
 * Build core first (`npm run -w @effigent/core build`). Needs the dashboard's
 * AWS credentials (env / shared config) plus PROD_DATABASE_URL.
 *
 *   PROD_DATABASE_URL=… node scripts/recompute-run-costs.mjs            # dry run (default)
 *   PROD_DATABASE_URL=… node scripts/recompute-run-costs.mjs --apply
 *   PROD_DATABASE_URL=… node scripts/recompute-run-costs.mjs --apply --tenant <clerk_ref-substr>
 */
import pg from 'pg';
import { gunzipSync } from 'node:zlib';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { runCostUsd } from '../packages/core/dist/index.js';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL.'); process.exit(1); }
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const onlyTenant = argv.includes('--tenant') ? argv[argv.indexOf('--tenant') + 1] : undefined;

const localish = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const db = new pg.Client({ connectionString: url, ...(localish ? {} : { ssl: { rejectUnauthorized: false } }) });
await db.connect();

// Mirrors storage.ts resolveStorage: BYO buckets need the cross-account role.
async function s3For(t) {
  const region = t.storage_region ?? 'us-east-1';
  if (!t.storage_role_arn) return new S3Client({ region });
  const sts = new STSClient({ region });
  const out = await sts.send(new AssumeRoleCommand({
    RoleArn: t.storage_role_arn,
    RoleSessionName: `effigent-reprice-${String(t.id).slice(0, 16)}`,
    ExternalId: t.storage_external_id ?? undefined,
    DurationSeconds: 3600,
  }));
  const c = out.Credentials;
  return new S3Client({ region, credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken } });
}

async function loadBlob(client, uri) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) return null;
  const out = await client.send(new GetObjectCommand({ Bucket: m[1], Key: m[2] }));
  const buf = Buffer.from(await out.Body.transformToByteArray());
  return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8'));
}

const reprice = runCostUsd; // same function the Insights route uses

const { rows: tenants } = await db.query(
  `select id, clerk_ref, storage_region, storage_role_arn, storage_external_id from tenants
    ${onlyTenant ? 'where clerk_ref like $1' : ''}`,
  onlyTenant ? [`%${onlyTenant}%`] : [],
);

let before = 0, after = 0, changed = 0, skipped = 0;
for (const t of tenants) {
  const { rows } = await db.query(
    `select session_id, cost_usd, blob_path, parsed from runs where tenant_id = $1`, [t.id]);
  if (!rows.length) continue;
  let client = null;
  for (const r of rows) {
    let run = r.parsed;
    try {
      if (!run && r.blob_path?.startsWith('s3://')) run = await loadBlob(client ??= await s3For(t), r.blob_path);
    } catch (err) {
      skipped++; console.warn(`  skip ${r.session_id}: ${err.message}`); continue;
    }
    if (!run?.usageByModel || !Object.keys(run.usageByModel).length) { skipped++; continue; }
    const next = reprice(run);
    before += Number(r.cost_usd ?? 0); after += next;
    if (Math.abs(next - Number(r.cost_usd ?? 0)) < 1e-6) continue;
    changed++;
    if (apply) await db.query(`update runs set cost_usd = $1 where tenant_id = $2 and session_id = $3`, [next, t.id, r.session_id]);
  }
  console.log(`${t.clerk_ref}: ${rows.length} runs`);
}
console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — ${changed} rows change, ${skipped} skipped · total $${before.toFixed(2)} → $${after.toFixed(2)}`);
await db.end();
