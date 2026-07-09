#!/usr/bin/env node
/**
 * End-to-end smoke test against the DEPLOYED dashboard/collector.
 * Exercises exactly what a design partner's machine does:
 *   1. key validation (`effigent login` probe)      GET  /api/v1/reports
 *   2. agent registration (scoped key mint)          POST /api/v1/agents
 *   3. transcript ingest (gzip, redaction canaries)  POST /api/v1/ingest
 *   4. OTLP GenAI ingest                             POST /v1/traces
 *   5. verify runs landed + secrets were redacted    (direct DB read)
 *   6. cleanup: deletes every artifact it created (runs, agent, keys)
 *
 * The temp key exists only inside this process. Prints PASS/FAIL per step.
 *
 * Usage:
 *   PROD_DATABASE_URL="postgres://…?sslmode=require" \
 *     node scripts/smoke-test.mjs https://ccopt-dashboard-wyvz.vercel.app
 */
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const BASE = (process.argv[2] ?? '').replace(/\/$/, '');
const dbUrl = process.env.PROD_DATABASE_URL;
if (!BASE || !dbUrl) {
  console.error('Usage: PROD_DATABASE_URL=… node scripts/smoke-test.mjs <dashboard-base-url>');
  process.exit(1);
}

const TENANT = 'a9154f7a-86b8-4266-868b-a39654a7ac9a'; // Test Organization (demo)
const AGENT = 'smoke-agent';
const SESSION = `smoke-${Date.now()}`;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await db.connect();

// -- mint a temp owner key (plaintext never leaves this process) --------------
const ownerKey = `eff_${randomBytes(24).toString('hex')}`;
await db.query("insert into api_keys (tenant_id, key_hash, label, role) values ($1,$2,'smoke-test','owner')",
  [TENANT, createHash('sha256').update(ownerKey).digest('hex')]);

try {
  // 1. key validation (what `effigent login` does)
  const rep = await fetch(`${BASE}/api/v1/reports`, { headers: { authorization: `Bearer ${ownerKey}` } });
  check('key validation (GET /api/v1/reports)', rep.ok, `HTTP ${rep.status}`);

  // 2. agent registration (what `effigent agent add` does)
  const reg = await fetch(`${BASE}/api/v1/agents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: AGENT, harness: 'smoke' }),
  });
  const regBody = await reg.json().catch(() => ({}));
  const scopedKey = regBody.apiKey;
  check('agent registration (POST /api/v1/agents)', reg.ok && !!scopedKey, `HTTP ${reg.status}`);

  // 3. transcript ingest with redaction canaries
  const ts = new Date().toISOString();
  const jsonl = [
    { type: 'user', sessionId: SESSION, timestamp: ts, message: { role: 'user', content: 'Reconcile the invoices for smoke test' } },
    { type: 'assistant', timestamp: ts, requestId: 'r1', message: { role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: 900, output_tokens: 120 }, content: [
      { type: 'text', text: 'Reading the batch now.' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'invoices/batch-1.csv' } },
    ] } },
    { type: 'user', timestamp: ts, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'rows=12 db=postgresql://svc:s3cretpw@db.internal/prod contact=oncall@acme.com token=sk-ant-abc123def456ghi789xyz' },
    ] } },
    { type: 'assistant', timestamp: ts, requestId: 'r2', message: { role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: 1200, output_tokens: 200 }, content: [
      { type: 'text', text: 'All 12 rows reconciled.' },
    ] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const ing = await fetch(`${BASE}/api/v1/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${scopedKey}`, 'content-type': 'application/octet-stream', 'x-ccopt-session-id': SESSION, 'x-ccopt-agent-id': 'spoofed-name' },
    body: gzipSync(Buffer.from(jsonl)),
  });
  const ingBody = await ing.json().catch(() => ({}));
  check('transcript ingest (POST /api/v1/ingest, gzip)', ing.ok && ingBody.parsed === true, `HTTP ${ing.status} ${JSON.stringify(ingBody).slice(0, 80)}`);
  check('scoped key beats spoofed agent header', ingBody.agentId === AGENT, `agentId=${ingBody.agentId}`);

  // 4. OTLP ingest
  const otlp = await fetch(`${BASE}/v1/traces`, {
    method: 'POST',
    headers: { authorization: `Bearer ${scopedKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'chat claude-sonnet-4',
      startTimeUnixNano: `${Date.now()}000000`, endTimeUnixNano: `${Date.now() + 900}000000`,
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.response.model', value: { stringValue: 'claude-sonnet-4' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: 700 } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: 90 } },
      ],
    }] }] }] }),
  });
  const otlpBody = await otlp.json().catch(() => ({}));
  check('OTLP ingest (POST /v1/traces)', otlp.status === 200 || otlp.status === 202, `HTTP ${otlp.status} ${JSON.stringify(otlpBody).slice(0, 60)}`);

  // 5. verify in DB
  const row = await db.query(`select agent_id, cost_usd, n_steps, parsed::text as p from runs where tenant_id=$1 and session_id=$2`, [TENANT, SESSION]);
  check('run persisted', row.rows.length === 1, row.rows.length ? `agent=${row.rows[0].agent_id} steps=${row.rows[0].n_steps} cost=$${Number(row.rows[0].cost_usd).toFixed(4)}` : 'no row');
  if (row.rows.length) {
    const p = row.rows[0].p;
    check('redaction: DB password gone', !p.includes('s3cretpw') && p.includes('[REDACTED:DB_URL]'));
    check('redaction: email gone', !p.includes('oncall@acme.com') && p.includes('[REDACTED:EMAIL]'));
    check('redaction: sk- key gone', !p.includes('sk-ant-abc123'));
    check('cost computed', Number(row.rows[0].cost_usd) > 0);
  }
  const otelRow = await db.query(`select count(*)::int n from runs where tenant_id=$1 and agent_id=$2 and session_id like 'otel:%'`, [TENANT, AGENT]);
  check('OTLP run persisted', otelRow.rows[0].n >= 1, `${otelRow.rows[0].n} run(s)`);
} finally {
  // 6. cleanup — remove everything this test created
  await db.query(`delete from runs where tenant_id=$1 and (session_id=$2 or (agent_id=$3 and session_id like 'otel:%'))`, [TENANT, SESSION, AGENT]);
  await db.query(`delete from api_keys where tenant_id=$1 and (label='smoke-test' or label=$2)`, [TENANT, AGENT]);
  await db.query(`delete from agents where tenant_id=$1 and name=$2`, [TENANT, AGENT]);
  await db.end();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED — the partner loop works end to end.' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
