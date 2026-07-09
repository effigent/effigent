#!/usr/bin/env node
/**
 * Seed a tenant in the PROD Neon DB with synthetic sessions so the dashboard's
 * Sessions view, agent filter, DAG deep-dive and per-agent panels have realistic
 * data before real agent runs flow in.
 *
 * Usage:
 *   PROD_DATABASE_URL="postgres://…?sslmode=require" node scripts/seed-prod.mjs [--list]
 *   PROD_DATABASE_URL=…  node scripts/seed-prod.mjs --ref org:org_123   # target one tenant
 *   PROD_DATABASE_URL=…  node scripts/seed-prod.mjs --all               # all clerk_ref tenants (default)
 *
 * Rows are clearly-labeled seed data (session ids prefixed `seed-`) — delete with
 *   delete from runs where session_id like 'seed-%';
 */
import pg from 'pg';

const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error('Set PROD_DATABASE_URL (the prod Neon connection string).');
  process.exit(1);
}
const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const refArg = (() => {
  const i = argv.indexOf('--ref');
  return i >= 0 ? argv[i + 1] : null;
})();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows: tenants } = await client.query(
  `select t.id, t.name, t.clerk_ref, count(r.id)::int as runs
     from tenants t left join runs r on r.tenant_id = t.id
    where t.clerk_ref is not null
    group by t.id, t.name, t.clerk_ref
    order by t.created_at`,
);
console.log('Tenants with a Clerk ref:');
for (const t of tenants) console.log(`  ${t.clerk_ref.padEnd(28)}  ${t.name}  (${t.runs} runs)  ${t.id}`);
if (listOnly) { await client.end(); process.exit(0); }
if (!tenants.length) { console.error('\nNo clerk_ref tenants yet — log into the dashboard once to create one.'); await client.end(); process.exit(1); }

const targets = refArg ? tenants.filter((t) => t.clerk_ref.includes(refArg)) : tenants;
if (!targets.length) { console.error(`\nNo tenant matched --ref ${refArg}`); await client.end(); process.exit(1); }

// ---- pricing ($/1M tokens) ---------------------------------------------------
const PRICE = {
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4': { in: 0.8, out: 4 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
};
const price = (m) => PRICE[m] ?? PRICE['claude-sonnet-4'];

// ---- step builders (steps carry per-step model/tokens/ms, like OTLP spans) ---
const pick = (arr, n) => arr[n % arr.length];
const mt = (text, model, inTok, outTok, ms) => ({ kind: 'model_turn', name: 'assistant', payload: text, model, tokens: { input: inTok, output: outTok }, ms });
const th = (text, ms) => ({ kind: 'thinking', name: 'reasoning', payload: text, ms });
const tu = (tool, input, id, ms) => ({ kind: 'tool_use', name: tool, payload: JSON.stringify(input), toolUseId: id, ms });
const tr = (tool, result, id, ms, isError) => ({ kind: 'tool_result', name: tool, payload: result, toolUseId: id, ms, ...(isError ? { isError: true } : {}) });

/** Each agent is a small "program". `main` is the planning model; `cheap` is where
 *  an optimized agent routes deterministic sub-steps. */
function program(kind, main, cheap, n) {
  const id = (s) => `${kind.slice(0, 3)}${n}${s}`;
  switch (kind) {
    case 'invoice':
      return [
        mt('Reconcile the uploaded invoice batch against the ledger.', main, 1240, 180, 900),
        th('Batch has line items in mixed currencies; validate rows, resolve tax, then match totals.', 300),
        tu('read_file', { path: `invoices/batch-${100 + (n % 24)}.csv` }, id('a'), 120),
        tr('read_file', `rows=${28 + (n % 60)}, currencies=[USD,EUR,${pick(['GBP', 'CAD', 'JPY'], n)}], total_gross=${(12000 + n * 137).toLocaleString()}`, id('a'), 140),
        tu('validate_schema', { columns: ['sku', 'qty', 'unit_price', 'currency'] }, id('b'), 90),
        tr('validate_schema', `valid=${28 + (n % 60) - (n % 3)}, rejected=${n % 3}`, id('b'), 95),
        mt('Look up the applicable tax rate for each region.', cheap, 640, 90, 300),
        tu('tax_rate', { region: pick(['CA', 'NY', 'TX', 'WA', 'IL'], n) }, id('c'), 60),
        tr('tax_rate', `${pick([7.25, 8.88, 6.25, 6.5, 10.25], n)}`, id('c'), 40),
        tu('fx_convert', { from: 'EUR', to: 'USD', amount: 4210 + n * 11 }, id('d'), 70),
        tr('fx_convert', `${(4570 + n * 12).toFixed(2)} USD @ 1.086`, id('d'), 45),
        mt(`All ${28 + (n % 60)} line items reconciled; net variance $${(n % 7) * 0.4}. Ledger updated.`, main, 1980, 260, 700),
      ];
    case 'triage':
      return [
        mt('Triage the incoming support ticket and route it.', main, 980, 140, 700),
        tu('fetch_ticket', { id: 5000 + n }, id('a'), 110),
        tr('fetch_ticket', `subject="${pick(['billing discrepancy', 'app crash on export', 'how to invite users', 'total outage'], n)}", customer_tier=${pick(['free', 'pro', 'enterprise'], n)}`, id('a'), 130),
        mt('Classify category and priority tier from the ticket text.', cheap, 720, 110, 400),
        tu('classify_tier', { category: pick(['billing', 'bug', 'howto', 'outage'], n) }, id('b'), 80),
        tr('classify_tier', `${pick(['P3', 'P2', 'P4', 'P1'], n)} (confidence ${(0.72 + (n % 20) / 100).toFixed(2)})`, id('b'), 60),
        tu('search_kb', { query: pick(['refund window', 'export csv fails', 'seat management', 'incident status'], n), top_k: 3 }, id('c'), 140),
        tr('search_kb', `3 articles, best="${pick(['KB-1042', 'KB-2211', 'KB-0087', 'KB-9001'], n)}" score=0.9${n % 9}`, id('c'), 150),
        mt('Drafted a reply grounded in the KB article and routed to the correct queue with an SLA.', main, 2100, 320, 800),
      ];
    case 'repo':
      return [
        mt('Find every call site of the deprecated auth module and summarize impact.', main, 1120, 160, 800),
        th('Grep first to scope, then read the top files, then extract the import graph.', 260),
        tu('grep', { pattern: 'import .* from ["\\\'].*auth-legacy', glob: '**/*.ts' }, id('a'), 210),
        tr('grep', `${12 + (n % 30)} matches across ${4 + (n % 8)} files`, id('a'), 220),
        tu('read_file', { path: pick(['src/server/session.ts', 'src/api/login.ts', 'src/mw/guard.ts'], n) }, id('b'), 160),
        tr('read_file', `${180 + n * 3} lines; 3 legacy calls: verifyLegacy(), signLegacy(), refreshLegacy()`, id('b'), 170),
        mt('Extract the import graph deterministically.', cheap, 540, 80, 220),
        tu('extractImports', { root: 'src/' }, id('c'), 90),
        tr('extractImports', `nodes=${340 + n * 5}, edges=${910 + n * 7}, cycles=${n % 2}`, id('c'), 110),
        tu('find_refs', { symbol: 'verifyLegacy' }, id('d'), 130),
        tr('find_refs', `${6 + (n % 14)} references, ${2 + (n % 4)} in tests`, id('d'), 120),
        mt(`Impact: ${12 + (n % 30)} call sites in ${4 + (n % 8)} files; migration is mechanical for ${8 + (n % 10)} of them.`, main, 2240, 300, 900),
      ];
    case 'ci':
      return [
        mt('A CI job failed. Diagnose and propose a fix.', main, 1040, 150, 750),
        tu('read_logs', { run_id: 88000 + n, tail: 200 }, id('a'), 180),
        tr('read_logs', `FAIL ${pick(['auth.spec.ts', 'billing.spec.ts', 'graph.spec.ts'], n)} — expected 200, got 500`, id('a'), 160),
        th('Looks like a null tenant in the new code path; reproduce locally.', 240),
        tu('run_tests', { file: pick(['auth.spec.ts', 'billing.spec.ts', 'graph.spec.ts'], n), grep: 'tenant' }, id('b'), 4200),
        tr('run_tests', `1 failing: "resolves tenant on first login" — TypeError: cannot read 'id' of undefined`, id('b'), 4300, n % 5 === 0),
        mt('Root cause: ON CONFLICT against a partial unique index. Proposing a one-line fix.', main, 1680, 240, 900),
        tu('apply_patch', { file: 'lib/tenant.ts', hunk: '+ where clerk_ref is not null' }, id('c'), 120),
        tr('apply_patch', 'patched 1 file (+1 -1)', id('c'), 90),
      ];
    case 'docs':
      return [
        mt('Write API reference docs for the new endpoints.', main, 900, 130, 700),
        tu('fetch_spec', { path: 'openapi.yaml' }, id('a'), 130),
        tr('fetch_spec', `${6 + (n % 10)} paths, ${18 + n} schemas`, id('a'), 120),
        mt('Outline the sections and retrieve real examples.', cheap, 620, 200, 500),
        tu('search_examples', { endpoint: pick(['/v1/traces', '/api/v1/agents', '/api/v1/sessions'], n) }, id('b'), 150),
        tr('search_examples', `4 request/response pairs found`, id('b'), 140),
        mt(`Generated ${3 + (n % 5)} sections with runnable curl + SDK snippets.`, main, 2600, 540, 1100),
      ];
    default: // pipeline
      return [
        mt('Run the nightly ETL and verify row counts.', main, 860, 120, 650),
        tu('read_schema', { table: 'events_raw' }, id('a'), 100),
        tr('read_schema', `${9 + (n % 6)} columns, partitioned by day`, id('a'), 90),
        tu('transform', { rows: 120000 + n * 900, dedupe: true }, id('b'), 5200),
        tr('transform', `out_rows=${118000 + n * 880}, dropped=${2000 + n * 20}`, id('b'), 5300),
        tu('load', { target: 'events_clean' }, id('c'), 3100),
        tr('load', `loaded ${118000 + n * 880} rows`, id('c'), 3200),
        mt('Counts reconcile within tolerance; pipeline green.', main, 1200, 160, 500),
      ];
  }
}

const AGENTS = [
  { name: 'invoice-reconciliation', kind: 'invoice', main: 'claude-sonnet-4', cheap: 'claude-haiku-4', count: 22 },
  { name: 'support-triage', kind: 'triage', main: 'claude-sonnet-4', cheap: 'gpt-4o', count: 18 },
  { name: 'repo-explorer', kind: 'repo', main: 'claude-sonnet-4', cheap: 'gpt-4o-mini', count: 20 },
  { name: 'ci-fixer', kind: 'ci', main: 'claude-sonnet-4', cheap: 'claude-sonnet-4', count: 14 },
  { name: 'docs-writer', kind: 'docs', main: 'gpt-4o', cheap: 'gpt-4o-mini', count: 12 },
  { name: 'data-pipeline', kind: 'pipeline', main: 'claude-sonnet-4', cheap: 'claude-sonnet-4', count: 10 },
];

function makeRun(agent, n) {
  const steps = program(agent.kind, agent.main, agent.cheap, n);
  const usageByModel = {};
  const modelsSet = new Set();
  let ms = 0;
  for (const s of steps) {
    ms += s.ms ?? 0;
    if (s.model) {
      modelsSet.add(s.model);
      const u = (usageByModel[s.model] ??= { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
      u.inputTokens += s.tokens?.input ?? 0;
      u.outputTokens += s.tokens?.output ?? 0;
      if (n % 3 === 0) u.cacheReadInputTokens += Math.round((s.tokens?.input ?? 0) * 0.4);
    }
  }
  let costUsd = 0;
  for (const [m, u] of Object.entries(usageByModel)) {
    const p = price(m);
    costUsd += (u.inputTokens * p.in + u.outputTokens * p.out + u.cacheReadInputTokens * p.in * 0.1) / 1e6;
  }
  const dayOffset = (n * 7 + agent.kind.length) % 21; // spread over ~3 weeks
  const start = new Date(Date.now() - dayOffset * 86_400_000 - (n % 6) * 3_600_000);
  const end = new Date(start.getTime() + ms + 1500);
  const models = [...modelsSet];
  return {
    session_id: `seed-${agent.kind.slice(0, 4)}-${String(n).padStart(3, '0')}`,
    agent_id: agent.name,
    started_at: start.toISOString(),
    ended_at: end.toISOString(),
    cost_usd: costUsd,
    models,
    n_steps: steps.length,
    parsed: {
      runId: `seed-${agent.name}-${n}`,
      agentId: agent.name,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      models,
      usageByModel,
      costUsd,
      firstPrompt: steps[0].payload,
      finalOutput: steps[steps.length - 1].payload,
      steps,
    },
  };
}

const runs = [];
for (const a of AGENTS) for (let n = 0; n < a.count; n++) runs.push(makeRun(a, n));

// ---- insert ------------------------------------------------------------------
for (const t of targets) {
  let inserted = 0;
  for (const r of runs) {
    const res = await client.query(
      `insert into runs (tenant_id, session_id, agent_id, started_at, ended_at, cost_usd, models, n_steps, blob_path, parsed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (tenant_id, session_id) do update
         set agent_id=$3, started_at=$4, ended_at=$5, cost_usd=$6, models=$7, n_steps=$8, parsed=$10`,
      [t.id, r.session_id, r.agent_id, r.started_at, r.ended_at, r.cost_usd.toFixed(6),
       JSON.stringify(r.models), r.n_steps, `seed/${r.session_id}.jsonl.gz`, JSON.stringify(r.parsed)],
    );
    inserted += res.rowCount;
  }
  console.log(`Seeded ${inserted} sessions (${AGENTS.length} agents) into ${t.clerk_ref} (${t.name}).`);
}

await client.end();
console.log('Done. Delete later with:  delete from runs where session_id like \'seed-%\';');
