-- Control plane schema. Lives in its own Postgres schema so it never touches
-- the v1 tables; tenants are referenced by their Clerk ref ("org:…"/"user:…").
create schema if not exists cp;

create table if not exists cp.enrollment_tokens (
  id          uuid primary key default gen_random_uuid(),
  tenant_ref  text not null,
  token_hash  text not null unique,
  label       text not null default '',
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  max_uses    int not null default 1,
  uses        int not null default 0
);

create table if not exists cp.endpoints (
  id              uuid primary key default gen_random_uuid(),
  tenant_ref      text not null,
  secret_hash     text not null unique,
  hostname        text not null default '',
  os              text not null default '',
  arch            text not null default '',
  version         text not null default '',
  enrolled_at     timestamptz not null default now(),
  last_seen       timestamptz,
  policy_version  bigint not null default 0,
  revoked_at      timestamptz
);
create index if not exists endpoints_tenant on cp.endpoints (tenant_ref);

-- Versioned endpoint policy documents (effigentd's YAML), one sequence per tenant.
create table if not exists cp.policy_versions (
  tenant_ref  text not null,
  version     bigint not null,
  body        text not null,
  comment     text not null default '',
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  primary key (tenant_ref, version)
);

create table if not exists cp.events (
  id           bigserial primary key,
  tenant_ref   text not null,
  endpoint_id  uuid not null,
  event_time   timestamptz not null,
  ingested_at  timestamptz not null default now(),
  type         text not null,
  severity     text not null default 'info',
  agent        text not null default '',
  body         jsonb not null
);
create index if not exists events_tenant_time on cp.events (tenant_ref, event_time desc);
