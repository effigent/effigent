-- Dashboard human users (distinct from machine api_keys). A user belongs to one
-- tenant. password_hash is null for OAuth-only users. Idempotent.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  email         text not null unique,
  password_hash text,
  provider      text not null default 'password',
  created_at    timestamptz not null default now()
);
create index if not exists users_tenant on users (tenant_id);
