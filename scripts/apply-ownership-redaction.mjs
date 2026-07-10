#!/usr/bin/env node
/**
 * Applies migrations 009 (agent/key ownership) + 010 (custom redaction rules)
 * to prod, and optionally hand-assigns an agent's owner label for agents that
 * predate the columns. All statements idempotent.
 *
 * Usage:
 *   PROD_DATABASE_URL="postgres://…?sslmode=require" \
 *     node scripts/apply-ownership-redaction.mjs
 *
 *   # assign an owner label to a pre-existing agent:
 *   PROD_DATABASE_URL=… node scripts/apply-ownership-redaction.mjs \
 *     --agent invoice-reconciliation --user "erel@moonshot.co.il"
 */
import pg from 'pg';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL.'); process.exit(1); }
const argv = process.argv.slice(2);
const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const agent = val('--agent');
const user = val('--user');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

// 009 — ownership
await c.query('alter table api_keys add column if not exists created_by text');
await c.query('alter table api_keys add column if not exists created_by_label text');
await c.query('alter table agents   add column if not exists created_by text');
await c.query('alter table agents   add column if not exists created_by_label text');
console.log('✓ 009 agent/key ownership columns applied');

// 010 — org-admin custom redaction rules
await c.query("alter table tenants add column if not exists redaction_rules jsonb not null default '[]'::jsonb");
console.log('✓ 010 tenants.redaction_rules applied');

if (agent && user) {
  const r = await c.query('update agents set created_by_label = $2 where name = $1 returning name', [agent, user]);
  console.log(r.rowCount ? `✓ ${agent} → added by ${user}` : `! no agents row named ${agent}`);
}

const { rows } = await c.query(
  'select name, coalesce(created_by_label, created_by) as added_by from agents order by name',
);
console.table(rows);
await c.end();
