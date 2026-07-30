#!/usr/bin/env node
/**
 * Recovers runs that were uploaded while `runs.parsed` was still NOT NULL.
 *
 * During that window `persistRun` wrote the blob to the org's bucket and THEN
 * failed to insert its metadata row (23502), so the content is in S3 with nothing
 * in Neon pointing at it — invisible in the dashboard. This walks each tenant's
 * bucket, finds objects with no matching `runs` row, and inserts the row from the
 * blob's own contents. Idempotent (upsert on (tenant_id, session_id)).
 *
 * Run migration 013 FIRST (scripts/apply-parsed-nullable.mjs) — inserts still fail
 * otherwise.
 *
 * Needs the same AWS credentials the dashboard uses (env / shared config), plus:
 *   PROD_DATABASE_URL="postgres://…?sslmode=require"
 *
 * Usage:
 *   PROD_DATABASE_URL=… node scripts/backfill-orphaned-runs.mjs --dry-run
 *   PROD_DATABASE_URL=… node scripts/backfill-orphaned-runs.mjs
 *   PROD_DATABASE_URL=… node scripts/backfill-orphaned-runs.mjs --tenant <clerk_ref-substr>
 */
import pg from 'pg';
import { gunzipSync } from 'node:zlib';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL.'); process.exit(1); }
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const tenantRef = argv[argv.indexOf('--tenant') + 1];
const onlyTenant = argv.includes('--tenant') ? tenantRef : undefined;

// See apply-parsed-nullable.mjs: TLS for managed Postgres, none for a local instance.
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
    RoleSessionName: `effigent-backfill-${String(t.id).slice(0, 16)}`,
    ExternalId: t.storage_external_id ?? undefined,
    DurationSeconds: 3600,
  }));
  const c = out.Credentials;
  if (!c?.AccessKeyId) throw new Error(`AssumeRole gave no credentials for ${t.storage_role_arn}`);
  return new S3Client({
    region,
    credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
  });
}

const { rows: tenants } = await db.query(
  `select id, clerk_ref, storage_bucket, storage_region, storage_prefix,
          storage_role_arn, storage_external_id
     from tenants
    where storage_bucket is not null
      ${onlyTenant ? 'and clerk_ref like $1' : ''}
    order by clerk_ref`,
  onlyTenant ? [`%${onlyTenant}%`] : [],
);
if (!tenants.length) { console.log('no tenants with a storage bucket'); await db.end(); process.exit(0); }

let totalFound = 0, totalInserted = 0, totalSkipped = 0, totalBad = 0;

for (const t of tenants) {
  console.log(`\n=== ${t.clerk_ref} — s3://${t.storage_bucket}/${t.storage_prefix ?? ''} ===`);
  try {
    await backfillTenant(t);
  } catch (e) {
    // One unreachable bucket (missing, wrong region, AssumeRole denied) must not
    // abandon the remaining tenants — this is a recovery tool.
    console.log(`  ✗ skipped: ${e.name === 'NoSuchBucket' ? 'bucket does not exist' : e.message}`);
    totalBad++;
  }
}

async function backfillTenant(t) {
  const s3 = await s3For(t);
  const prefix = (t.storage_prefix ?? '').replace(/^\/+|\/+$/g, '');

  // Existing rows, so we only touch genuine orphans.
  const { rows: have } = await db.query('select session_id from runs where tenant_id = $1', [t.id]);
  const known = new Set(have.map((r) => r.session_id));

  let token, found = 0, inserted = 0, skipped = 0, bad = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: t.storage_bucket,
      Prefix: prefix ? `${prefix}/` : undefined,
      ContinuationToken: token,
    }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;

    for (const obj of page.Contents ?? []) {
      if (!obj.Key?.endsWith('.json.gz')) continue;
      found++;
      // Key layout (storage.ts putRunBlob): <prefix>/<agent>/<sessionId>.json.gz
      const sessionId = obj.Key.split('/').pop().replace(/\.json\.gz$/, '');
      if (known.has(sessionId)) { skipped++; continue; }

      let run;
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: t.storage_bucket, Key: obj.Key }));
        const buf = Buffer.from(await out.Body.transformToByteArray());
        const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
        run = JSON.parse((isGzip ? gunzipSync(buf) : buf).toString('utf8'));
      } catch (e) {
        console.log(`  ! unreadable ${obj.Key}: ${e.message}`);
        bad++;
        continue;
      }

      const blobPath = `s3://${t.storage_bucket}/${obj.Key}`;
      const nSteps = Array.isArray(run.steps) ? run.steps.length : 0;
      const agentId = run.agentId ?? obj.Key.split('/').slice(-2)[0] ?? 'unknown-agent';
      const cost = typeof run.costUsd === 'number' ? run.costUsd : 0;

      if (dryRun) {
        console.log(`  + would insert ${sessionId} · ${agentId} · ${nSteps} steps · $${cost.toFixed(2)}`);
        inserted++;
        continue;
      }
      try {
        await db.query(
          `insert into runs (tenant_id, session_id, agent_id, started_at, ended_at,
                             cost_usd, models, n_steps, blob_path, parsed)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null)
           on conflict (tenant_id, session_id) do update
             set agent_id = excluded.agent_id, started_at = excluded.started_at,
                 ended_at = excluded.ended_at, cost_usd = excluded.cost_usd,
                 models = excluded.models, n_steps = excluded.n_steps,
                 blob_path = excluded.blob_path`,
          [t.id, sessionId, agentId, run.startedAt ?? null, run.endedAt ?? null,
           cost, JSON.stringify(run.models ?? []), nSteps, blobPath],
        );
        console.log(`  ✓ ${sessionId} · ${agentId} · ${nSteps} steps · $${cost.toFixed(2)}`);
        inserted++;
      } catch (e) {
        console.log(`  ✗ insert failed for ${sessionId}: ${e.message}`);
        if (e.code === '23502') console.log('    → migration 013 not applied yet; run scripts/apply-parsed-nullable.mjs');
        bad++;
      }
    }
  } while (token);

  console.log(`  blobs: ${found} · ${dryRun ? 'would insert' : 'inserted'}: ${inserted} · already present: ${skipped} · failed: ${bad}`);
  totalFound += found; totalInserted += inserted; totalSkipped += skipped; totalBad += bad;
}

console.log(`\n${dryRun ? '[dry run] ' : ''}blobs ${totalFound} · ${dryRun ? 'recoverable' : 'recovered'} ${totalInserted} · present ${totalSkipped} · failed ${totalBad}`);
if (dryRun) console.log('Re-run without --dry-run to write the rows.');

await db.end();
