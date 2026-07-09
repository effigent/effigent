#!/usr/bin/env node
/**
 * Seed a tenant in the PROD Neon DB with synthetic sessions so the dashboard's
 * Sessions view + agent filter have data before real agent runs flow in.
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

// ---- synthetic run generation ------------------------------------------------
const PRICE = { 'claude-opus-4': { in: 15, out: 75 }, 'claude-sonnet-4': { in: 3, out: 15 }, 'gpt-4o': { in: 2.5, out: 10 } };
const cost = (model, u) => {
  const p = PRICE[model] ?? PRICE['claude-sonnet-4'];
  return (u.inputTokens * p.in + u.outputTokens * p.out + u.cacheReadInputTokens * p.in * 0.1) / 1e6;
};
const usage = (i, o, cr = 0) => ({ inputTokens: i, outputTokens: o, cacheCreationInputTokens: 0, cacheReadInputTokens: cr });

/** Two agent "programs" with mostly-fixed shapes + a couple of varying nodes. */
function makeRun(agentId, model, n, dayOffset) {
  const start = new Date(Date.now() - dayOffset * 86_400_000 - (n % 5) * 3_600_000);
  const end = new Date(start.getTime() + 40_000 + (n % 7) * 9_000);
  const steps =
    agentId === 'invoice-reconciliation'
      ? [
          { kind: 'model_turn', name: 'assistant', payload: 'Reconcile invoice batch.' },
          { kind: 'tool_use', name: 'read_file', payload: `{"path":"invoices/batch-${100 + (n % 12)}.csv"}`, toolUseId: `t${n}a` },
          { kind: 'tool_result', name: 'read_file', payload: `rows=${18 + (n % 40)}`, toolUseId: `t${n}a` },
          { kind: 'model_turn', name: 'assistant', payload: 'Look up the applicable tax rate.' },
          { kind: 'tool_use', name: 'tax_rate', payload: `{"region":"${['CA', 'NY', 'TX', 'WA'][n % 4]}"}`, toolUseId: `t${n}b` },
          { kind: 'tool_result', name: 'tax_rate', payload: `${[7.25, 8.88, 6.25, 6.5][n % 4]}`, toolUseId: `t${n}b` },
          { kind: 'model_turn', name: 'assistant', payload: 'All line items reconciled; totals match.' },
        ]
      : [
          { kind: 'model_turn', name: 'assistant', payload: 'Triage the incoming support ticket.' },
          { kind: 'tool_use', name: 'fetch_ticket', payload: `{"id":${5000 + n}}`, toolUseId: `t${n}a` },
          { kind: 'tool_result', name: 'fetch_ticket', payload: `subject="${['billing', 'bug', 'howto', 'outage'][n % 4]}"`, toolUseId: `t${n}a` },
          { kind: 'model_turn', name: 'assistant', payload: 'Classify priority tier.' },
          { kind: 'tool_use', name: 'classify_tier', payload: `{"category":"${['billing', 'bug', 'howto', 'outage'][n % 4]}"}`, toolUseId: `t${n}b` },
          { kind: 'tool_result', name: 'classify_tier', payload: `${['P3', 'P2', 'P4', 'P1'][n % 4]}`, toolUseId: `t${n}b` },
          { kind: 'model_turn', name: 'assistant', payload: 'Routed to the correct queue with an SLA set.' },
        ];
  const u = usage(1800 + (n % 9) * 220, 340 + (n % 6) * 60, (n % 3) * 900);
  return {
    session_id: `seed-${agentId.slice(0, 4)}-${String(n).padStart(3, '0')}`,
    agent_id: agentId,
    started_at: start.toISOString(),
    ended_at: end.toISOString(),
    cost_usd: cost(model, u),
    models: [model],
    n_steps: steps.length,
    parsed: {
      runId: `seed-${agentId}-${n}`,
      agentId,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      models: [model],
      usageByModel: { [model]: u },
      costUsd: cost(model, u),
      steps,
    },
  };
}

const runs = [];
for (let n = 0; n < 16; n++) runs.push(makeRun('invoice-reconciliation', 'claude-sonnet-4', n, n % 14));
for (let n = 0; n < 14; n++) runs.push(makeRun('support-triage', n % 3 === 0 ? 'gpt-4o' : 'claude-sonnet-4', n, (n + 2) % 14));

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
  console.log(`Seeded ${inserted} sessions into ${t.clerk_ref} (${t.name}).`);
}

await client.end();
console.log('Done. Delete later with:  delete from runs where session_id like \'seed-%\';');
