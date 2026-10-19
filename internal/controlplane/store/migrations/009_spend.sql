-- Pricing Leaks: AI coding tool spend. Per tenant and vendor a connector
-- (admin API key sealed with EFFIGENT_SECRETS_KEY, never returned), the seats
-- and daily usage the last sync or CSV import brought back, and one settings
-- document (people directory + price overrides).
create table if not exists cp.spend_connectors (
  tenant_ref       text not null,
  vendor           text not null,              -- cursor | anthropic | copilot | openai
  secret_enc       text not null default '',
  secret_hint      text not null default '',   -- last 4 characters of the key
  settings         jsonb not null default '{}', -- non-secret: {"org": "acme"} for Copilot
  enabled          boolean not null default true,
  sync_status      text not null default '',   -- '' | running | ok | error
  sync_started_at  timestamptz,
  last_sync_at     timestamptz,                -- last successful sync
  last_error       text not null default '',
  last_counts      jsonb not null default '{}',
  updated_by       text not null default '',
  updated_at       timestamptz not null default now(),
  primary key (tenant_ref, vendor)
);

create table if not exists cp.spend_seats (
  tenant_ref       text not null,
  vendor           text not null,
  identity         text not null,  -- email, or GitHub login for Copilot
  source           text not null,  -- api | csv
  name             text not null default '',
  plan             text not null default '',
  price_cents      bigint not null default 0,
  assigned_at      timestamptz,
  last_activity_at timestamptz,
  synced_at        timestamptz not null default now(),
  primary key (tenant_ref, vendor, source, identity)
);

create table if not exists cp.spend_usage (
  tenant_ref  text not null,
  vendor      text not null,
  day         date not null,
  identity    text not null,      -- '' = the organisation's total for the day
  source      text not null,      -- api | csv
  cost_cents  bigint not null default 0,
  requests    bigint not null default 0,
  tokens      bigint not null default 0,
  estimated   boolean not null default false,
  synced_at   timestamptz not null default now(),
  primary key (tenant_ref, vendor, source, day, identity)
);

create table if not exists cp.spend_settings (
  tenant_ref  text primary key,
  config      jsonb not null default '{}',
  updated_by  text not null default '',
  updated_at  timestamptz not null default now()
);
