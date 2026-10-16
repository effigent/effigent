-- Integrations: API keys for automation (Windmill, Tines, scripts) and
-- outbound webhooks with a persistent delivery queue.

-- An API key acts for its workspace with the scopes it was given
-- (read, approvals, endpoints, policy). Only its sha256 is stored.
create table if not exists cp.api_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_ref    text not null,
  name          text not null default '',
  prefix        text not null,              -- first characters, to recognise it in the console
  key_hash      text not null unique,
  scopes        text[] not null default '{}',
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists api_keys_tenant on cp.api_keys (tenant_ref);

-- A webhook receives the events it subscribed to, signed with its secret.
-- The URL can carry the receiver's own token (Windmill does): never returned.
create table if not exists cp.webhooks (
  id             uuid primary key default gen_random_uuid(),
  tenant_ref     text not null,
  name           text not null default '',
  url            text not null,
  secret         text not null,             -- HMAC-SHA256 signing key
  events         text[] not null,
  enabled        boolean not null default true,
  created_by     text not null default '',
  created_at     timestamptz not null default now(),
  last_status    int,
  last_error     text not null default '',
  last_attempt_at timestamptz,
  dropped        bigint not null default 0  -- events skipped by the per-webhook rate cap
);
create index if not exists webhooks_tenant on cp.webhooks (tenant_ref);

-- Deliveries survive restarts: a worker picks due rows (skip locked) and
-- retries with backoff until delivered or out of attempts.
create table if not exists cp.webhook_deliveries (
  id              bigserial primary key,
  webhook_id      uuid not null references cp.webhooks (id) on delete cascade,
  event_id        text not null,
  event_type      text not null,
  body            text not null,
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  state           text not null default 'pending', -- pending | delivered | failed
  last_status     int,
  last_error      text not null default '',
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index if not exists webhook_deliveries_due on cp.webhook_deliveries (next_attempt_at) where state = 'pending';
create index if not exists webhook_deliveries_hook on cp.webhook_deliveries (webhook_id, created_at desc);
