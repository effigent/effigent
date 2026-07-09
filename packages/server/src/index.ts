/**
 * ccopt SaaS shell — spec §4. Single service: tenant/key admin, gzip ingest,
 * batch analyze, server-rendered report viewer, weekly email job.
 */

import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  buildRunGraph,
  mineSegments,
  otelToRuns,
  parseTranscript,
  type OtlpTracesPayload,
  type Run,
  type WasteReport,
} from '@ccopt/core';
import { loadConfig } from './config.js';
import { createPool, migrate, type Db } from './db.js';
import { createBlobStore } from './blobs.js';
import { runPipeline } from './pipeline.js';
import { renderClusterHtml, renderDashboardHtml, renderSessionHtml } from './views.js';
import { renderGraphPage } from './graph-view.js';
import { sanitizeForJsonb } from './jsonb.js';
import { redactDeep, redactSecrets } from './redact.js';
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

// HTML forms (the dashboard's "Run optimization" button) post as
// x-www-form-urlencoded with an empty body — accept and ignore it, all
// parameters travel in the query string.
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_req, _body, done) => done(null, {}),
);

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

interface TenantAuth {
  tenantId: string;
  role: 'owner' | 'member';
  /** Set when the key is scoped to a registered agent — binds capture to that agent. */
  agentId?: string;
  agentName?: string;
}

async function authenticate(authorization?: string): Promise<TenantAuth | null> {
  const m = authorization?.match(/^Bearer (cck_[A-Za-z0-9]+)$/);
  if (!m) return null;
  const { rows } = await db.query<{
    id: string;
    tenant_id: string;
    role: string;
    agent_id: string | null;
    agent_name: string | null;
  }>(
    `select k.id, k.tenant_id, k.role, k.agent_id, a.name as agent_name
       from api_keys k
       left join agents a on a.id = k.agent_id
      where k.key_hash = $1`,
    [hashKey(m[1])],
  );
  if (rows.length === 0) return null;
  await db.query(`update api_keys set last_used_at = now() where id = $1`, [rows[0].id]);
  return {
    tenantId: rows[0].tenant_id,
    role: rows[0].role === 'owner' ? 'owner' : 'member',
    agentId: rows[0].agent_id ?? undefined,
    agentName: rows[0].agent_name ?? undefined,
  };
}

/**
 * Shared write path for a parsed Run — used by BOTH ingestion shapes (transcript
 * `/api/v1/ingest` and OTLP `/v1/traces`) so they can't drift. Inserts the upload
 * row (marked parsed) and upserts the run with step payloads trimmed (the blob
 * keeps full fidelity). Returns the upload id.
 */
async function persistParsedRun(
  auth: TenantAuth,
  sessionId: string,
  run: Run,
  blobPath: string,
  bytes: number,
  source: 'transcript' | 'otlp',
): Promise<string> {
  const upload = await db.query<{ id: string }>(
    `insert into uploads (tenant_id, session_id, agent_id, blob_path, bytes, source, status)
     values ($1,$2,$3,$4,$5,$6,'parsed') returning id`,
    [auth.tenantId, sessionId, run.agentId, blobPath, bytes, source],
  );
  // Persist the execution DAG (the optimizer's IR) as a gzipped blob. It's
  // regenerable from the Run, but storing it gives the brain a stable graph to
  // read/diff without recomputing, and is only decompressed on demand.
  const graphPath = `${auth.tenantId}/graphs/${encodeURIComponent(sessionId)}.json.gz`;
  await blobs.put(graphPath, gzipSync(Buffer.from(JSON.stringify(buildRunGraph(run)))));

  const trimmed: Run = sanitizeForJsonb({
    ...run,
    steps: run.steps.map((s) => ({ ...s, payload: s.payload.slice(0, 8000) })),
  });
  await db.query(
    `insert into runs (tenant_id, session_id, agent_id, started_at, ended_at,
                       cost_usd, models, n_steps, blob_path, parsed, graph_blob_path)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (tenant_id, session_id) do update
       set agent_id = excluded.agent_id, started_at = excluded.started_at,
           ended_at = excluded.ended_at, cost_usd = excluded.cost_usd,
           models = excluded.models, n_steps = excluded.n_steps,
           blob_path = excluded.blob_path, parsed = excluded.parsed,
           graph_blob_path = excluded.graph_blob_path`,
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
      graphPath,
    ],
  );
  return upload.rows[0].id;
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

/** Admin: mint an additional API key for a tenant (role: owner | member). */
app.post('/api/v1/tenants/:tenantId/keys', async (req, reply) => {
  if (req.headers['x-admin-token'] !== config.adminToken) {
    return reply.code(401).send({ error: 'admin token required' });
  }
  const { tenantId } = req.params as { tenantId: string };
  const body = (req.body ?? {}) as { label?: string; role?: string };
  const role = body.role === 'owner' ? 'owner' : 'member';
  const apiKey = `cck_${randomBytes(24).toString('hex')}`;
  await db.query(
    `insert into api_keys (tenant_id, key_hash, label, role) values ($1, $2, $3, $4)`,
    [tenantId, hashKey(apiKey), body.label ?? role, role],
  );
  return { tenantId, role, apiKey };
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

  // A scoped agent key binds attribution to its agent — it wins over the
  // client-supplied x-ccopt-agent-id header (which a leaked/misconfigured key
  // must not be able to spoof).
  const effectiveAgentId = auth.agentName ?? agentIdHeader;

  const blobPath = `${auth.tenantId}/sessions/${sessionId}.jsonl.gz`;
  // Always store gzipped at rest — readers gunzip on demand. If the client
  // didn't pre-compress, we compress it here so nothing is ever stored raw.
  await blobs.put(blobPath, req.headers['content-encoding'] === 'gzip' ? raw : gzipSync(Buffer.from(jsonl)));

  const run: Run | null = parseTranscript(jsonl, { agentId: effectiveAgentId });
  if (!run) {
    const upload = await db.query<{ id: string }>(
      `insert into uploads (tenant_id, session_id, agent_id, blob_path, bytes, source, status, error)
       values ($1,$2,$3,$4,$5,'transcript','failed','no assistant activity') returning id`,
      [auth.tenantId, sessionId, effectiveAgentId ?? null, blobPath, raw.length],
    );
    return reply.code(202).send({ uploadId: upload.rows[0].id, parsed: false });
  }

  const uploadId = await persistParsedRun(auth, sessionId, run, blobPath, raw.length, 'transcript');
  return { uploadId, parsed: true, agentId: run.agentId, costUsd: run.costUsd };
});

/**
 * OTLP/HTTP ingestion — OpenTelemetry GenAI spans from OpenLLMetry-instrumented
 * agents (any framework). Phase 1 requires UNCOMPRESSED JSON: exporters must set
 * OTEL_EXPORTER_OTLP_PROTOCOL=http/json and OTEL_EXPORTER_OTLP_COMPRESSION=none
 * (protobuf/gzip decode is a fast-follow). Normalizes spans into the same `Run`
 * model as the transcript path, keyed by the scoped agent when present.
 */
app.post('/v1/traces', async (req, reply) => {
  const auth = await authenticate(req.headers.authorization);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });
  if (Buffer.isBuffer(req.body) || typeof req.body !== 'object' || req.body === null) {
    return reply.code(415).send({
      error: 'send OTLP/HTTP as uncompressed JSON',
      hint: 'set OTEL_EXPORTER_OTLP_PROTOCOL=http/json and OTEL_EXPORTER_OTLP_COMPRESSION=none',
    });
  }
  const payload = req.body as OtlpTracesPayload;
  const runs = otelToRuns(payload, {
    agentId: auth.agentName, // scoped key forces attribution; overrides span attrs
    defaultAgentId: 'unknown-otel-agent',
  });
  if (runs.length === 0) return reply.code(202).send({ parsed: false, runs: 0 });

  const body = gzipSync(Buffer.from(JSON.stringify(payload)));
  let persisted = 0;
  for (const run of runs) {
    const sessionId = run.runId; // 'otel:<conversation|trace id>'
    const blobPath = `${auth.tenantId}/otel/${encodeURIComponent(sessionId)}.json.gz`;
    await blobs.put(blobPath, body);
    await persistParsedRun(auth, sessionId, run, blobPath, body.length, 'otlp');
    persisted++;
  }
  return { parsed: true, runs: persisted };
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
// One analysis at a time per tenant — overlapping runs (double-clicks, retries)
// stack blob parsing + LLM calls and can starve the instance.
const analysisInFlight = new Set<string>();

app.post('/api/v1/insights', async (req, reply) => {
  const auth = await authenticateFlexible(req);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });
  if (analysisInFlight.has(auth.tenantId)) {
    return reply.code(429).send({ error: 'an analysis is already running for this workspace — try again in a minute' });
  }
  const q = req.query as { agent?: string; runs?: string; force?: string; redirect?: string; key?: string };
  const agentFilter = q.agent;
  const maxRuns = Math.min(80, Number(q.runs ?? 40) || 40);
  const backToUi = () =>
    reply.redirect(`/ui?key=${encodeURIComponent(q.key ?? '')}${agentFilter ? `&agent=${encodeURIComponent(agentFilter)}` : ''}`);

  // Explicit-trigger only: the (paid) OpenRouter/LLM pass runs ONLY when ?force=1
  // is passed. Every other request returns the last cached analysis without ever
  // calling the LLM — so background/automated callers can't rack up spend on their
  // own. It runs only when a human explicitly asks for it.
  if (q.force !== '1') {
    if (q.redirect === '1') return backToUi();
    const gate = await latestInsights(auth.tenantId, agentFilter);
    if (gate) {
      const runsNow = await countRuns(auth.tenantId, agentFilter);
      const newRuns = runsNow - gate.runsTotalAtGeneration;
      return { cached: true, newRunsSinceAnalysis: newRuns, hint: 'AI analysis runs only on explicit request — pass ?force=1 to run it now', ...gate };
    }
    return { cached: false, hint: 'AI analysis runs only on explicit request — pass ?force=1 to run it now' };
  }

  analysisInFlight.add(auth.tenantId);
  try {
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
  const digestGraphs = [];
  for (const r of runRows.rows) {
    let run: Run | null = null;
    try {
      run = parseTranscript(gunzipSync(await blobs.get(r.blob_path)).toString('utf8'), {
        agentId: r.agent_id,
      });
    } catch {
      run = r.parsed; // blob unavailable — the trimmed DB copy still carries the signals
    }
    if (run) {
      const graph = buildRunGraph(run);
      digestGraphs.push(graph);
      digests.push(buildRunDigest(run, config.publicBaseUrl, graph));
    }
  }
  if (digests.length === 0) return reply.code(404).send({ error: 'no runs to analyze' });
  const minedSegments = mineSegments(digestGraphs);

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
    minedSegments,
  );

  try {
    const llm = createLlmProvider(process.env);
    const insights = await generateInsights(llm, redactDeep(packet), agentFilter);
    await db.query(
      `update reports set report_json = jsonb_set(report_json, '{aiInsights}', $2::jsonb) where id = $1`,
      [rows[0].id, JSON.stringify(sanitizeForJsonb(insights))],
    );
    if (q.redirect === '1') return backToUi();
    return { reportId: rows[0].id, ...insights };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, 'insights generation failed');
    return reply.code(502).send({
      error: `AI analysis failed: ${msg}`,
      hint: 'Configure the LLM provider env: ANTHROPIC_API_KEY (default), or CCOPT_LLM_PROVIDER=openai-compatible with CCOPT_LLM_BASE_URL/CCOPT_LLM_MODEL/CCOPT_LLM_API_KEY.',
    });
  }
  } finally {
    analysisInFlight.delete(auth.tenantId);
  }
});

async function countRuns(tenantId: string, agentFilter?: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    agentFilter
      ? `select count(*) as n from runs where tenant_id = $1 and agent_id ilike '%' || $2 || '%'`
      : `select count(*) as n from runs where tenant_id = $1`,
    agentFilter ? [tenantId, agentFilter] : [tenantId],
  );
  return Number(r.rows[0].n);
}

/** Most recent stored AI analysis whose scope matches the requested filter. */
async function latestInsights(tenantId: string, agentFilter?: string) {
  const { rows } = await db.query<{ ai: { agentFilter: string | null; runsTotalAtGeneration?: number } & Record<string, unknown> }>(
    `select report_json->'aiInsights' as ai from reports
     where tenant_id = $1 and report_json ? 'aiInsights'
     order by generated_at desc limit 5`,
    [tenantId],
  );
  for (const r of rows) {
    if ((r.ai.agentFilter ?? null) === (agentFilter ?? null)) {
      return { ...r.ai, runsTotalAtGeneration: Number(r.ai.runsTotalAtGeneration ?? 0) };
    }
  }
  return rows[0]?.ai ? { ...rows[0].ai, runsTotalAtGeneration: Number(rows[0].ai.runsTotalAtGeneration ?? 0) } : null;
}

/**
 * Register an agent and mint a per-agent SCOPED key (returned exactly once).
 * Requires a TENANT-level key (owner or member) — an agent-scoped capture key
 * cannot mint further keys, so a leaked capture key can't escalate. Scoped keys
 * are always role 'member', so they never unlock the raw-transcript viewers.
 */
app.post('/api/v1/agents', async (req, reply) => {
  const auth = await authenticate(req.headers.authorization);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });
  if (auth.agentId) {
    return reply.code(403).send({ error: 'agent registration requires a tenant key, not an agent-scoped key' });
  }
  const body = (req.body ?? {}) as { name?: string; harness?: string };
  if (!body.name) return reply.code(400).send({ error: 'name required' });
  const agent = await db.query<{ id: string }>(
    `insert into agents (tenant_id, name, harness) values ($1,$2,$3)
     on conflict (tenant_id, name) do update set harness = coalesce(excluded.harness, agents.harness)
     returning id`,
    [auth.tenantId, body.name, body.harness ?? null],
  );
  const apiKey = `cck_${randomBytes(24).toString('hex')}`;
  await db.query(
    `insert into api_keys (tenant_id, key_hash, label, role, agent_id) values ($1,$2,$3,'member',$4)`,
    [auth.tenantId, hashKey(apiKey), body.name, agent.rows[0].id],
  );
  return { agentId: agent.rows[0].id, name: body.name, apiKey };
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

/** The stored execution DAG (IR) for one run — gzipped in the blob store,
 *  decompressed on demand. Rebuilds on the fly for runs ingested before the
 *  graph was persisted. This is what the optimization engine reads. */
app.get('/api/v1/runs/:sessionId/graph', async (req, reply) => {
  const auth = await authenticate(req.headers.authorization);
  if (!auth) return reply.code(401).send({ error: 'invalid API key' });
  const { sessionId } = req.params as { sessionId: string };
  const { rows } = await db.query<{ graph_blob_path: string | null; parsed: Run }>(
    `select graph_blob_path, parsed from runs where tenant_id = $1 and session_id = $2`,
    [auth.tenantId, sessionId],
  );
  if (rows.length === 0) return reply.code(404).send({ error: 'run not found' });
  if (rows[0].graph_blob_path) {
    try {
      const g = gunzipSync(await blobs.get(rows[0].graph_blob_path)).toString('utf8');
      return reply.type('application/json').send(g);
    } catch {
      /* blob missing/corrupt — fall through to rebuild */
    }
  }
  return buildRunGraph(rows[0].parsed);
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
  const uiAgent = (req.query as { agent?: string }).agent;
  const [tenant, agents, runs, reports] = await Promise.all([
    db.query<{ name: string }>(`select name from tenants where id = $1`, [auth.tenantId]),
    db.query(
      uiAgent
        ? `select agent_id, count(*)::int as n_runs, round(sum(cost_usd),2) as total_cost_usd, max(started_at) as last_seen
           from runs where tenant_id = $1 and agent_id ilike '%' || $2 || '%' group by agent_id order by sum(cost_usd) desc limit 50`
        : `select agent_id, count(*)::int as n_runs, round(sum(cost_usd),2) as total_cost_usd, max(started_at) as last_seen
           from runs where tenant_id = $1 group by agent_id order by sum(cost_usd) desc limit 50`,
      uiAgent ? [auth.tenantId, uiAgent] : [auth.tenantId],
    ),
    db.query(
      uiAgent
        ? `select session_id, agent_id, started_at, round(cost_usd,2) as cost_usd, n_steps
           from runs where tenant_id = $1 and agent_id ilike '%' || $2 || '%' order by started_at desc nulls last limit 50`
        : `select session_id, agent_id, started_at, round(cost_usd,2) as cost_usd, n_steps
           from runs where tenant_id = $1 order by started_at desc nulls last limit 50`,
      uiAgent ? [auth.tenantId, uiAgent] : [auth.tenantId],
    ),
    db.query(
      `select id, generated_at, totals from reports where tenant_id = $1 order by generated_at desc limit 20`,
      [auth.tenantId],
    ),
  ]);
  const ai = await latestInsights(auth.tenantId, uiAgent);
  const runsNow = await countRuns(auth.tenantId, uiAgent);
  const newRunsSince = ai ? runsNow - ai.runsTotalAtGeneration : runsNow;
  const segRows = await db.query<{ segments: unknown }>(
    `select report_json->'segments' as segments from reports
     where tenant_id = $1 and report_json ? 'segments' order by generated_at desc limit 1`,
    [auth.tenantId],
  );
  return reply
    .type('text/html')
    .send(
      renderDashboardHtml(
        tenant.rows[0]?.name ?? 'workspace',
        agents.rows,
        runs.rows,
        reports.rows,
        key,
        (ai as never) ?? undefined,
        { agentFilter: uiAgent, newRunsSince, canRun: !ai || newRunsSince >= 5 },
        (segRows.rows[0]?.segments as never) ?? undefined,
      ),
    );
});

/** Session transcript viewer — full fidelity, parsed from the raw S3 blob. */
app.get('/s/:sessionId', async (req, reply) => {
  const auth = await authenticateFlexible(req);
  if (!auth) return reply.code(401).type('text/plain').send('add ?key=cck_… (your tenant API key)');
  if (auth.role !== 'owner') {
    return reply.code(403).type('text/plain').send('session transcripts are restricted to the workspace owner key');
  }
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
  const revealed = (req.query as { reveal?: string }).reveal === '1';
  return reply
    .type('text/html')
    .send(renderSessionHtml(run, key, revealed ? (t) => t : redactSecrets, revealed));
});

/** Run-graph viewer: canonical DAG with dataflow edges + full I/O per node. */
app.get('/g/:sessionId', async (req, reply) => {
  const auth = await authenticateFlexible(req);
  if (!auth) return reply.code(401).type('text/plain').send('add ?key=cck_… (your tenant API key)');
  if (auth.role !== 'owner') {
    return reply.code(403).type('text/plain').send('run graphs expose raw payloads — restricted to the workspace owner key');
  }
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
  const revealed = (req.query as { reveal?: string }).reveal === '1';
  // Segments from the latest report annotate the switchable parts of this run.
  const segRows = await db.query<{ segments: never }>(
    `select report_json->'segments' as segments from reports
     where tenant_id = $1 and report_json ? 'segments' order by generated_at desc limit 1`,
    [auth.tenantId],
  );
  return reply
    .type('text/html')
    .send(
      renderGraphPage(
        buildRunGraph(run),
        (segRows.rows[0]?.segments as never) ?? [],
        key,
        revealed ? (t) => t : redactSecrets,
        revealed,
      ),
    );
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
        metrics: redactDeep(c.metrics),
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
  const stored = await blobs.get(rows[0].html_blob_path);
  let html: Buffer;
  try {
    html = gunzipSync(stored); // reports are stored gzipped
  } catch {
    html = stored; // tolerate older reports written uncompressed
  }
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
