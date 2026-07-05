/**
 * ccopt SaaS shell — spec §4. Single service: tenant/key admin, gzip ingest,
 * batch analyze, server-rendered report viewer, weekly email job.
 */

import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseTranscript, type Run } from '@ccopt/core';
import { loadConfig } from './config.js';
import { createPool, migrate, type Db } from './db.js';
import { DiskBlobStore } from './blobs.js';
import { runPipeline } from './pipeline.js';
import { OutboxEmailSender } from './email.js';
import { sanitizeForJsonb } from './jsonb.js';

const config = loadConfig();
const db: Db = createPool(config.databaseUrl);
const blobs = new DiskBlobStore(config.dataDir);
const email = new OutboxEmailSender(config.dataDir);

const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 });

// Raw-body parser for transcript uploads.
app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),
);

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

interface TenantAuth {
  tenantId: string;
}

async function authenticate(authorization?: string): Promise<TenantAuth | null> {
  const m = authorization?.match(/^Bearer (cck_[A-Za-z0-9]+)$/);
  if (!m) return null;
  const { rows } = await db.query<{ tenant_id: string; id: string }>(
    `select id, tenant_id from api_keys where key_hash = $1`,
    [hashKey(m[1])],
  );
  if (rows.length === 0) return null;
  await db.query(`update api_keys set last_used_at = now() where id = $1`, [rows[0].id]);
  return { tenantId: rows[0].tenant_id };
}

app.get('/healthz', async () => {
  await db.query('select 1');
  return { ok: true };
});

/** Admin: create tenant + API key (returned exactly once). */
app.post('/api/v1/tenants', async (req, reply) => {
  if (req.headers['x-admin-token'] !== config.adminToken) {
    return reply.code(401).send({ error: 'admin token required' });
  }
  const body = (req.body ?? {}) as { name?: string; email?: string };
  if (!body.name) return reply.code(400).send({ error: 'name required' });
  const tenant = await db.query<{ id: string }>(
    `insert into tenants (name, email) values ($1, $2) returning id`,
    [body.name, body.email ?? null],
  );
  const apiKey = `cck_${randomBytes(24).toString('hex')}`;
  await db.query(
    `insert into api_keys (tenant_id, key_hash, label) values ($1, $2, 'default')`,
    [tenant.rows[0].id, hashKey(apiKey)],
  );
  return { tenantId: tenant.rows[0].id, apiKey };
});

/** Ingest one gzipped session transcript. */
app.post('/api/v1/ingest', async (req, reply) => {
  const auth = await authenticate(req.headers.authorization);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });

  const sessionId = String(req.headers['x-ccopt-session-id'] ?? '');
  if (!sessionId) return reply.code(400).send({ error: 'x-ccopt-session-id header required' });
  const agentIdHeader = req.headers['x-ccopt-agent-id']
    ? String(req.headers['x-ccopt-agent-id'])
    : undefined;

  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    return reply.code(400).send({ error: 'binary body required' });
  }
  let jsonl: string;
  try {
    jsonl = (req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
  } catch {
    return reply.code(400).send({ error: 'failed to decompress body' });
  }

  const blobPath = `${auth.tenantId}/sessions/${sessionId}.jsonl.gz`;
  await blobs.put(blobPath, req.headers['content-encoding'] === 'gzip' ? raw : Buffer.from(jsonl));

  const upload = await db.query<{ id: string }>(
    `insert into uploads (tenant_id, session_id, agent_id, blob_path, bytes)
     values ($1,$2,$3,$4,$5) returning id`,
    [auth.tenantId, sessionId, agentIdHeader ?? null, blobPath, raw.length],
  );

  const run: Run | null = parseTranscript(jsonl, { agentId: agentIdHeader });
  if (!run) {
    await db.query(`update uploads set status = 'failed', error = 'no assistant activity' where id = $1`, [
      upload.rows[0].id,
    ]);
    return reply.code(202).send({ uploadId: upload.rows[0].id, parsed: false });
  }

  // Persist with step payloads trimmed — the blob keeps full fidelity.
  const trimmed: Run = sanitizeForJsonb({
    ...run,
    steps: run.steps.map((s) => ({ ...s, payload: s.payload.slice(0, 8000) })),
  });
  await db.query(
    `insert into runs (tenant_id, session_id, agent_id, started_at, ended_at,
                       cost_usd, models, n_steps, blob_path, parsed)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (tenant_id, session_id) do update
       set agent_id = excluded.agent_id, started_at = excluded.started_at,
           ended_at = excluded.ended_at, cost_usd = excluded.cost_usd,
           models = excluded.models, n_steps = excluded.n_steps,
           blob_path = excluded.blob_path, parsed = excluded.parsed`,
    [
      auth.tenantId,
      sessionId,
      run.agentId,
      run.startedAt ?? null,
      run.endedAt ?? null,
      run.costUsd,
      JSON.stringify(run.models),
      run.steps.length,
      blobPath,
      JSON.stringify(trimmed),
    ],
  );
  await db.query(`update uploads set status = 'parsed' where id = $1`, [upload.rows[0].id]);
  return { uploadId: upload.rows[0].id, parsed: true, agentId: run.agentId, costUsd: run.costUsd };
});

/** Trigger analysis now (also runs nightly). */
app.post('/api/v1/analyze', async (req, reply) => {
  const auth = await authenticate(req.headers.authorization);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });
  const result = await runPipeline(db, blobs, auth.tenantId);
  if (!result) return reply.code(404).send({ error: 'no runs ingested yet' });
  return { ...result, reportUrl: `${config.publicBaseUrl}/r/${result.reportId}` };
});

/** Agent inventory for the tenant: every agent we've seen, with run/cost stats. */
app.get('/api/v1/agents', async (req, reply) => {
  const auth = await authenticate(req.headers.authorization);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });
  const { rows } = await db.query(
    `select agent_id,
            count(*)::int                as n_runs,
            round(sum(cost_usd), 2)      as total_cost_usd,
            min(started_at)              as first_seen,
            max(started_at)              as last_seen,
            (select coalesce(jsonb_agg(distinct m), '[]'::jsonb)
               from runs r2, jsonb_array_elements_text(r2.models) m
              where r2.tenant_id = runs.tenant_id and r2.agent_id = runs.agent_id) as models
     from runs
     where tenant_id = $1
     group by tenant_id, agent_id
     order by sum(cost_usd) desc`,
    [auth.tenantId],
  );
  return { agents: rows };
});

/** Admin: fleet overview across ALL tenants — every agent our service is set up on. */
app.get('/api/v1/admin/overview', async (req, reply) => {
  if (req.headers['x-admin-token'] !== config.adminToken) {
    return reply.code(401).send({ error: 'admin token required' });
  }
  const { rows } = await db.query(
    `select t.id as tenant_id, t.name as tenant, r.agent_id,
            count(r.id)::int             as n_runs,
            round(sum(r.cost_usd), 2)    as total_cost_usd,
            max(r.started_at)            as last_seen
     from tenants t
     left join runs r on r.tenant_id = t.id
     group by t.id, t.name, r.agent_id
     order by t.name, sum(r.cost_usd) desc nulls last`,
  );
  const tenants = new Map<string, { tenantId: string; tenant: string; agents: unknown[] }>();
  for (const row of rows) {
    const entry =
      tenants.get(row.tenant_id) ??
      tenants.set(row.tenant_id, { tenantId: row.tenant_id, tenant: row.tenant, agents: [] }).get(row.tenant_id)!;
    if (row.agent_id) {
      entry.agents.push({
        agentId: row.agent_id,
        nRuns: row.n_runs,
        totalCostUsd: row.total_cost_usd,
        lastSeen: row.last_seen,
      });
    }
  }
  return { tenants: [...tenants.values()] };
});

/** Report history for the tenant. */
app.get('/api/v1/reports', async (req, reply) => {
  const auth = await authenticate(req.headers.authorization);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });
  const { rows } = await db.query(
    `select id, generated_at, window_days, totals from reports
     where tenant_id = $1 order by generated_at desc limit 50`,
    [auth.tenantId],
  );
  return {
    reports: rows.map((r) => ({ ...r, url: `${config.publicBaseUrl}/r/${r.id}` })),
  };
});

/** Hosted report viewer — report ids are unguessable UUIDs (share-by-link). */
app.get('/r/:reportId', async (req, reply) => {
  const { reportId } = req.params as { reportId: string };
  if (!/^[0-9a-f-]{36}$/.test(reportId)) return reply.code(404).send('not found');
  const { rows } = await db.query<{ html_blob_path: string }>(
    `select html_blob_path from reports where id = $1`,
    [reportId],
  );
  if (rows.length === 0) return reply.code(404).send('not found');
  const html = await blobs.get(rows[0].html_blob_path);
  return reply.type('text/html').send(html);
});

/** Nightly analyze + weekly email — a simple in-process scheduler, no queues. */
async function nightlyJob(): Promise<void> {
  const { rows: tenants } = await db.query<{ id: string; email: string | null; name: string }>(
    `select id, email, name from tenants`,
  );
  for (const t of tenants) {
    try {
      const result = await runPipeline(db, blobs, t.id);
      if (!result) continue;
      app.log.info({ tenant: t.id, ...result }, 'nightly analysis complete');
      const { rows } = await db.query<{ id: string; emailed_at: string | null }>(
        `select id, emailed_at from reports where tenant_id = $1 order by generated_at desc limit 1`,
        [t.id],
      );
      const lastEmail = await db.query<{ m: string | null }>(
        `select max(emailed_at)::text as m from reports where tenant_id = $1`,
        [t.id],
      );
      const weekMs = 7 * 86_400_000;
      const due =
        !lastEmail.rows[0].m || Date.now() - Date.parse(lastEmail.rows[0].m) >= weekMs;
      if (due && t.email && rows.length > 0) {
        const html = await blobs.get(
          (
            await db.query<{ html_blob_path: string }>(
              `select html_blob_path from reports where id = $1`,
              [rows[0].id],
            )
          ).rows[0].html_blob_path,
        );
        await email.send(t.email, `Your weekly Agent Waste Report — ${t.name}`, html.toString('utf8'));
        await db.query(`update reports set emailed_at = now() where id = $1`, [rows[0].id]);
      }
    } catch (err) {
      app.log.error({ tenant: t.id, err }, 'nightly analysis failed');
    }
  }
}

async function main(): Promise<void> {
  await migrate(db);
  if (!config.disableJobs) {
    setInterval(() => void nightlyJob(), 24 * 3600 * 1000).unref();
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
