-- Agent registry + per-agent scoped keys (Universal Collector, Phase 1).
-- Registered agents are named identities within a tenant; a scoped api_key is
-- bound to one agent so any captured run (transcript OR OTLP) attributes to it
-- without cwd-regex guessing. runs.agent_id stays TEXT and stores the agent
-- NAME, so the analysis engine, /ui, and insights queries are unchanged;
-- agents.id (uuid) is only the credential-binding key on api_keys.
-- Migrations re-run on every boot (no tracking table) — keep every statement idempotent.

create table if not exists agents (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  harness    text,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists agents_tenant on agents (tenant_id);

-- Scoped keys point at the agent they capture for; owner/member tenant keys leave it null.
alter table api_keys add column if not exists agent_id uuid references agents(id) on delete set null;

-- Which ingestion path produced an upload: 'transcript' | 'otlp'.
alter table uploads add column if not exists source text;
