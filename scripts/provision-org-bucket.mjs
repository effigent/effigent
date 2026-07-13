#!/usr/bin/env node
/**
 * Provision a dedicated Effigent-account S3 bucket for one org and record it on
 * the tenant, so its captured runs land in that bucket (S3-only residency).
 * Owner-run (creating buckets is intentionally NOT done from the dashboard's
 * request handlers — that keeps the app's IAM scoped to read/write objects).
 *
 * For a BYO bucket (the org's own account), skip this — the org admin sets it
 * via the dashboard Storage settings / PUT /api/v1/storage instead.
 *
 * Prereqs: AWS creds in env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION)
 * for the Effigent account, plus PROD_DATABASE_URL for Neon.
 *
 * Usage:
 *   AWS_REGION=us-east-1 PROD_DATABASE_URL="postgres://…?sslmode=require" \
 *     node scripts/provision-org-bucket.mjs --ref org_abc [--kms <kms-key-arn>] [--bucket <name>]
 */
import pg from 'pg';
import {
  S3Client, CreateBucketCommand, PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand, BucketAlreadyOwnedByYou,
} from '@aws-sdk/client-s3';

const url = process.env.PROD_DATABASE_URL;
const region = process.env.AWS_REGION;
if (!url) { console.error('Set PROD_DATABASE_URL.'); process.exit(1); }
if (!region) { console.error('Set AWS_REGION.'); process.exit(1); }
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const ref = val('--ref');
const kms = val('--kms');
let bucket = val('--bucket');
if (!ref) { console.error('Pass --ref <clerk_ref substring> (e.g. org_abc).'); process.exit(1); }

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query(
  `select id, clerk_ref from tenants where clerk_ref like $1 order by created_at limit 2`,
  [`%${ref}%`],
);
if (rows.length === 0) { console.error(`No tenant matches ref '${ref}'.`); process.exit(1); }
if (rows.length > 1) { console.error(`Ref '${ref}' is ambiguous — be more specific.`); process.exit(1); }
const tenant = rows[0];
bucket = bucket || `effigent-runs-${tenant.id.replace(/-/g, '').slice(0, 12)}`;

const s3 = new S3Client({ region });
try {
  await s3.send(new CreateBucketCommand({
    Bucket: bucket,
    ...(region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: region } } : {}),
  }));
  console.log(`✓ created bucket ${bucket}`);
} catch (err) {
  if (err instanceof BucketAlreadyOwnedByYou) console.log(`• bucket ${bucket} already exists (reusing)`);
  else throw err;
}

await s3.send(new PutPublicAccessBlockCommand({
  Bucket: bucket,
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
  },
}));
await s3.send(new PutBucketEncryptionCommand({
  Bucket: bucket,
  ServerSideEncryptionConfiguration: {
    Rules: [{
      ApplyServerSideEncryptionByDefault: kms
        ? { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: kms }
        : { SSEAlgorithm: 'AES256' },
      BucketKeyEnabled: true,
    }],
  },
}));
console.log(`✓ block-public-access + default encryption applied${kms ? ' (KMS)' : ' (SSE-S3)'}`);

await c.query(
  `update tenants set storage_bucket=$2, storage_region=$3, storage_kms_key=$4,
          storage_provisioned_at=now() where id=$1`,
  [tenant.id, bucket, region, kms || null],
);
console.log(`✓ tenant ${tenant.clerk_ref} → s3://${bucket} (${region})`);
await c.end();
