/**
 * ccopt SaaS shell — spec §4. Single service: tenant/key admin, gzip ingest,
 * batch analyze, server-rendered report viewer, weekly email job.
 */

import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { buildRunGraph, parseTranscript, type Run, type WasteReport } from '@ccopt/core';
import { loadConfig } from './config.js';
import { createPool, migrate, type Db } from './db.js';
import { createBlobStore } from './blobs.js';
import { runPipeline } from './pipeline.js';
import { renderClusterHtml, renderDashboardHtml, renderGraphHtml, renderSessionHtml } from './views.js';
import { sanitizeForJsonb } from './jsonb.js';
import { buildInsightsPacket, buildRunDigest, generateInsights } from './insights.js';
import { createLlmProvider } from './llm.js';

const config = loadConfig();
const db: Db = createPool(config.databaseUrl);
const blobs = createBlobStore(process.env, config.dataDir);

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
  const agentFilter = (req.query as { agent?: string })?.agent;
  const result = await runPipeline(db, blobs, auth.tenantId, agentFilter);
  if (!result) return reply.code(404).send({ error: 'no runs ingested yet' });
  return { ...result, reportUrl: `${config.publicBaseUrl}/r/${result.reportId}` };
});

/**
 * AI analysis: Claude reviews the latest report's clusters/graph data and
 * returns cost reductions that don't hurt performance. Requires
 * ANTHROPIC_API_KEY (or other SDK-resolvable auth) in the server env.
 * Result is stored on the report row and shown on /ui.
 */
app.post('/api/v1/insights', async (req, reply) => {
  const auth = await authenticateFlexible(req);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });
  const agentFilter = (req.query as { agent?: string })?.agent;
  const maxRuns = Math.min(80, Number((req.query as { runs?: string })?.runs ?? 40) || 40);

  // Trigger-only semantics: analyzing an agent generates everything fresh at
  // this moment — first the deterministic report for the agent, then the AI pass.
  const pipelineResult = await runPipeline(db, blobs, auth.tenantId, agentFilter);
  if (!pipelineResult) return reply.code(404).send({ error: 'no runs ingested for this agent yet' });
  const { rows } = await db.query<{ id: string; report_json: WasteReport }>(
    `select id, report_json from reports where id = $1`,
    [pipelineResult.reportId],
  );
  const report = rows[0].report_json;

  const clusterRows = await db.query(
    `select id, cluster_key, agent_id, n_runs, total_cost_usd, determinism, metrics, label_sequence
     from clusters where report_id = $1 order by total_cost_usd desc limit 12`,
    [rows[0].id],
  );

  // The insights agent goes over the runs themselves — full fidelity from the
  // blob store, most expensive first (that's where the money is), capped so
  // the packet fits one context. The cap is reported to the model honestly.
  const runRows = await db.query<{ session_id: string; agent_id: string; blob_path: string; parsed: Run }>(
    agentFilter
      ? `select session_id, agent_id, blob_path, parsed from runs
         where tenant_id = $1 and agent_id ilike '%' || $2 || '%'
         order by cost_usd desc limit ` + String(maxRuns)
      : `select session_id, agent_id, blob_path, parsed from runs
         where tenant_id = $1 order by cost_usd desc limit ` + String(maxRuns),
    agentFilter ? [auth.tenantId, agentFilter] : [auth.tenantId],
  );
  const totalCount = await db.query<{ n: string }>(
    agentFilter
      ? `select count(*) as n from runs where tenant_id = $1 and agent_id ilike '%' || $2 || '%'`
      : `select count(*) as n from runs where tenant_id = $1`,
    agentFilter ? [auth.tenantId, agentFilter] : [auth.tenantId],
  );

  const digests = [];
  for (const r of runRows.rows) {
    let run: Run | null = null;
    try {
      run = parseTranscript(gunzipSync(await blobs.get(r.blob_path)).toString('utf8'), {
        agentId: r.agent_id,
      });
    } catch {
      run = r.parsed; // blob unavailable — the trimmed DB copy still carries the signals
    }
    if (run) digests.push(buildRunDigest(run, config.publicBaseUrl));
  }
  if (digests.length === 0) return reply.code(404).send({ error: 'no runs to analyze' });

  const packet = buildInsightsPacket(
    report,
    clusterRows.rows.map((c) => ({
      clusterId: c.id,
      agentId: c.agent_id,
      nRuns: c.n_runs,
      totalCostUsd: Number(c.total_cost_usd),
      determinism: Number(c.determinism),
      failureRate: Number(c.metrics?.failureRate ?? 0),
      labelSequence: c.label_sequence,
      metrics: {
        retrySubchains: c.metrics?.retrySubchains,
        modelMix: c.metrics?.modelMix,
        cacheReadRatio: c.metrics?.cacheReadRatio,
        costP50Usd: c.metrics?.costP50Usd,
        costP95Usd: c.metrics?.costP95Usd,
        l0DuplicateRuns: c.metrics?.l0DuplicateRuns,
        volatileSlots: (c.metrics?.volatileSlots ?? []).slice(0, 8),
      },
    })),
    digests,
    Number(totalCount.rows[0].n),
  );

  try {
    const llm = createLlmProvider(process.env);
    const insights = await generateInsights(llm, packet);
    await db.query(
      `update reports set report_json = jsonb_set(report_json, '{aiInsights}', $2::jsonb) where id = $1`,
      [rows[0].id, JSON.stringify(sanitizeForJsonb(insights))],
    );
    return { reportId: rows[0].id, ...insights };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, 'insights generation failed');
    return reply.code(502).send({
      error: `AI analysis failed: ${msg}`,
      hint: 'Configure the LLM provider env: ANTHROPIC_API_KEY (default), or CCOPT_LLM_PROVIDER=openai-compatible with CCOPT_LLM_BASE_URL/CCOPT_LLM_MODEL/CCOPT_LLM_API_KEY.',
    });
  }
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

/** Browser auth: Bearer header (API) or ?key= query (dashboard links). */
async function authenticateFlexible(req: {
  headers: { authorization?: string };
  query: unknown;
}): Promise<TenantAuth | null> {
  const fromHeader = await authenticate(req.headers.authorization);
  if (fromHeader) return fromHeader;
  const key = (req.query as { key?: string })?.key;
  return key ? authenticate(`Bearer ${key}`) : null;
}

/** Workspace dashboard: agents, sessions, reports — open /ui?key=cck_… in a browser. */
app.get('/ui', async (req, reply) => {
  const auth = await authenticateFlexible(req);
  if (!auth) return reply.code(401).type('text/plain').send('add ?key=cck_… (your tenant API key)');
  const key = (req.query as { key?: string }).key ?? '';
  const [tenant, agents, runs, reports, latest] = await Promise.all([
    db.query<{ name: string }>(`select name from tenants where id = $1`, [auth.tenantId]),
    db.query(
      `select agent_id, count(*)::int as n_runs, round(sum(cost_usd),2) as total_cost_usd, max(started_at) as last_seen
       from runs where tenant_id = $1 group by agent_id order by sum(cost_usd) desc limit 50`,
      [auth.tenantId],
    ),
    db.query(
      `select session_id, agent_id, started_at, round(cost_usd,2) as cost_usd, n_steps
       from runs where tenant_id = $1 order by started_at desc nulls last limit 50`,
      [auth.tenantId],
    ),
    db.query(
      `select id, generated_at, totals from reports where tenant_id = $1 order by generated_at desc limit 20`,
      [auth.tenantId],
    ),
    db.query(
      `select report_json->'aiInsights' as ai from reports where tenant_id = $1 order by generated_at desc limit 1`,
      [auth.tenantId],
    ),
  ]);
  return reply
    .type('text/html')
    .send(
      renderDashboardHtml(
        tenant.rows[0]?.name ?? 'workspace',
        agents.rows,
        runs.rows,
        reports.rows,
        key,
        latest.rows[0]?.ai ?? undefined,
      ),
    );
});

/** Session transcript viewer — full fidelity, parsed from the raw S3 blob. */
app.get('/s/:sessionId', async (req, reply) => {
  const auth = await authenticateFlexible(req);
  if (!auth) return reply.code(401).type('text/plain').send('add ?key=cck_… (your tenant API key)');
  const { sessionId } = req.params as { sessionId: string };
  const key = (req.query as { key?: string }).key ?? '';
  const { rows } = await db.query<{ blob_path: string; agent_id: string; parsed: Run }>(
    `select blob_path, agent_id, parsed from runs where tenant_id = $1 and session_id = $2`,
    [auth.tenantId, sessionId],
  );
  if (rows.length === 0) return reply.code(404).send('session not found');
  let run: Run | null = null;
  try {
    const blob = await blobs.get(rows[0].blob_path);
    run = parseTranscript(gunzipSync(blob).toString('utf8'), { agentId: rows[0].agent_id });
  } catch {
    run = rows[0].parsed; // blob unavailable — fall back to the trimmed DB copy
  }
  if (!run) return reply.code(422).send('session could not be parsed');
  return reply.type('text/html').send(renderSessionHtml(run, key));
});

/** Run-graph viewer: canonical DAG with dataflow edges + full I/O per node. */
app.get('/g/:sessionId', async (req, reply) => {
  const auth = await authenticateFlexible(req);
  if (!auth) return reply.code(401).type('text/plain').send('add ?key=cck_… (your tenant API key)');
  const { sessionId } = req.params as { sessionId: string };
  const key = (req.query as { key?: string }).key ?? '';
  const { rows } = await db.query<{ blob_path: string; agent_id: string; parsed: Run }>(
    `select blob_path, agent_id, parsed from runs where tenant_id = $1 and session_id = $2`,
    [auth.tenantId, sessionId],
  );
  if (rows.length === 0) return reply.code(404).send('session not found');
  let run: Run | null = null;
  try {
    const blob = await blobs.get(rows[0].blob_path);
    run = parseTranscript(gunzipSync(blob).toString('utf8'), { agentId: rows[0].agent_id });
  } catch {
    run = rows[0].parsed;
  }
  if (!run) return reply.code(422).send('session could not be parsed');
  return reply.type('text/html').send(renderGraphHtml(buildRunGraph(run), key));
});

/** Cluster view: shape, determinism, volatile slots, evidence — the money page. */
app.get('/c/:clusterId', async (req, reply) => {
  const auth = await authenticateFlexible(req);
  if (!auth) return reply.code(401).type('text/plain').send('add ?key=cck_… (your tenant API key)');
  const { clusterId } = req.params as { clusterId: string };
  const key = (req.query as { key?: string }).key ?? '';
  if (!/^[0-9a-f-]{36}$/.test(clusterId)) return reply.code(404).send('not found');
  const cluster = await db.query(
    `select id, cluster_key, agent_id, n_runs, total_cost_usd, determinism, metrics, label_sequence, report_id
     from clusters where tenant_id = $1 and id = $2`,
    [auth.tenantId, clusterId],
  );
  if (cluster.rows.length === 0) return reply.code(404).send('cluster not found');
  const c = cluster.rows[0];
  const [sessions, findings] = await Promise.all([
    db.query(
      `select r.session_id, r.started_at, round(r.cost_usd,2) as cost_usd
       from cluster_runs cr join runs r on r.id = cr.run_id
       where cr.cluster_id = $1 order by r.started_at desc limit 50`,
      [clusterId],
    ),
    db.query(
      `select kind, title, est_monthly_saving_usd, payload from findings
       where report_id = $1 and payload->'clusterIds' ? $2 order by score desc`,
      [c.report_id, c.cluster_key],
    ),
  ]);
  return reply.type('text/html').send(
    renderClusterHtml(
      {
        clusterKey: c.cluster_key,
        agentId: c.agent_id,
        nRuns: c.n_runs,
        totalCostUsd: c.total_cost_usd,
        determinism: c.determinism,
        metrics: c.metrics,
        labelSequence: c.label_sequence,
        sessions: sessions.rows,
        findings: findings.rows,
      },
      key,
    ),
  );
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

async function main(): Promise<void> {
  await migrate(db);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
