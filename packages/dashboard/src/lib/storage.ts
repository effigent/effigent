import { gzipSync, gunzipSync } from 'node:zlib';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { pool } from './db.ts';
import type { Run } from './engine/types.ts';

/**
 * Per-org run storage (S3-only residency). Each org's run blobs live in ITS OWN
 * bucket — a dedicated Effigent-account bucket, or the org's own bucket via a
 * cross-account role (BYO). Nothing sensitive is kept in Neon; this module is
 * the only path run content flows through on write and read.
 *
 * Config lives on `tenants.storage_*` (migration 012). A tenant with no
 * `storage_bucket` is NOT provisioned → capture is refused (the onboarding gate).
 */

export class StorageNotProvisioned extends Error {
  constructor(tenantId: string) {
    super(`workspace storage not provisioned for tenant ${tenantId}`);
    this.name = 'StorageNotProvisioned';
  }
}

interface StorageConfig {
  bucket: string;
  region: string;
  prefix: string;
  kmsKey?: string;
  roleArn?: string;
  externalId?: string;
}

interface Resolved {
  client: S3Client;
  cfg: StorageConfig;
}

const DEFAULT_REGION = process.env.AWS_REGION ?? 'us-east-1';
const DEFAULT_KMS = process.env.EFFIGENT_S3_KMS_KEY || undefined;

// Cache resolved clients (incl. assumed-role creds) ~50 min — under the default
// 1h STS session so creds never expire mid-use.
const CACHE_MS = 50 * 60 * 1000;
const cache = new Map<string, { resolved: Resolved; expires: number }>();

async function loadConfig(tenantId: string): Promise<StorageConfig> {
  const { rows } = await pool.query<{
    storage_bucket: string | null;
    storage_region: string | null;
    storage_prefix: string | null;
    storage_kms_key: string | null;
    storage_role_arn: string | null;
    storage_external_id: string | null;
  }>(
    `select storage_bucket, storage_region, storage_prefix, storage_kms_key,
            storage_role_arn, storage_external_id
       from tenants where id = $1`,
    [tenantId],
  );
  const r = rows[0];
  if (!r?.storage_bucket) throw new StorageNotProvisioned(tenantId);
  return {
    bucket: r.storage_bucket,
    region: r.storage_region ?? DEFAULT_REGION,
    prefix: (r.storage_prefix ?? '').replace(/^\/+|\/+$/g, ''),
    kmsKey: r.storage_kms_key ?? DEFAULT_KMS,
    roleArn: r.storage_role_arn ?? undefined,
    externalId: r.storage_external_id ?? undefined,
  };
}

/** An S3 client scoped to the tenant's bucket (assuming the BYO role if set). */
async function resolveStorage(tenantId: string): Promise<Resolved> {
  const hit = cache.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit.resolved;

  const cfg = await loadConfig(tenantId);
  let client: S3Client;
  if (cfg.roleArn) {
    // BYO bucket in the org's own AWS account — assume their cross-account role.
    const sts = new STSClient({ region: cfg.region });
    const out = await sts.send(
      new AssumeRoleCommand({
        RoleArn: cfg.roleArn,
        RoleSessionName: `effigent-${tenantId.slice(0, 16)}`,
        ExternalId: cfg.externalId,
        DurationSeconds: 3600,
      }),
    );
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error(`AssumeRole returned no credentials for ${cfg.roleArn}`);
    client = new S3Client({
      region: cfg.region,
      credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
    });
  } else {
    // Effigent-account bucket — default credentials (Vercel env / OIDC).
    client = new S3Client({ region: cfg.region });
  }
  const resolved: Resolved = { client, cfg };
  cache.set(tenantId, { resolved, expires: Date.now() + CACHE_MS });
  return resolved;
}

/** Invalidate a tenant's cached client (call after its storage config changes). */
export function invalidateStorage(tenantId: string): void {
  cache.delete(tenantId);
}

function fullKey(prefix: string, key: string): string {
  return prefix ? `${prefix}/${key}` : key;
}

/** Gzip + upload a run blob; returns the canonical `s3://bucket/key` URI. */
export async function putRunBlob(tenantId: string, key: string, body: string): Promise<string> {
  const { client, cfg } = await resolveStorage(tenantId);
  const Key = fullKey(cfg.prefix, key);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key,
      Body: gzipSync(Buffer.from(body, 'utf8')),
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
      ...(cfg.kmsKey ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: cfg.kmsKey } : { ServerSideEncryption: 'AES256' }),
    }),
  );
  return `s3://${cfg.bucket}/${Key}`;
}

/** Fetch + gunzip a run blob by its `s3://bucket/key` URI. */
export async function getRunBlob(tenantId: string, uri: string): Promise<string> {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`not an s3 URI: ${uri}`);
  const [, , Key] = m;
  const { client, cfg } = await resolveStorage(tenantId);
  const out = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key }));
  const buf = Buffer.from(await out.Body!.transformToByteArray());
  // Objects are written gzipped; tolerate uncompressed just in case.
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  return (isGzip ? gunzipSync(buf) : buf).toString('utf8');
}

/**
 * Load a run's content as a `Run`, from the org's S3 bucket when `blobPath` is
 * an `s3://` URI, or from the inline `parsed` jsonb for legacy pre-S3 rows.
 * Returns null if the blob is missing/unreadable (a single bad run must not sink
 * a whole insights window). Callers fetch these in parallel.
 */
export async function loadRun(tenantId: string, blobPath: string | null, inlineParsed: Run | null): Promise<Run | null> {
  if (blobPath && blobPath.startsWith('s3://')) {
    try {
      return JSON.parse(await getRunBlob(tenantId, blobPath)) as Run;
    } catch {
      return null;
    }
  }
  return inlineParsed ?? null; // legacy inline row (blob_path='inline')
}

/** Whether the tenant has storage configured (used by the onboarding gate). */
export async function isProvisioned(tenantId: string): Promise<boolean> {
  try {
    await loadConfig(tenantId);
    return true;
  } catch {
    return false;
  }
}
