-- Pricing Leaks history and alerts. A job computes each tenant's report when
-- its spend data changed (a vendor sync, a CSV import, new prices) and at least
-- hourly, and upserts today's rows; past days freeze. Vendor seats are
-- replaced on every sync, so these rows are the only record of what was paid
-- and found on a given day.

-- When each tenant's report was last rolled up, and when its data last changed.
create table if not exists cp.spend_rollups (
  tenant_ref  text primary key,
  changed_at  timestamptz not null default now(),
  rolled_at   timestamptz,
  last_error  text not null default ''
);
insert into cp.spend_rollups (tenant_ref)
select tenant_ref from cp.spend_connectors
union select tenant_ref from cp.spend_seats
union select tenant_ref from cp.spend_usage
on conflict do nothing;

-- Per day and vendor: the report's spend (seats per month, usage in the
-- 30-day window ending that day, both scaled to a month).
create table if not exists cp.spend_report_daily (
  tenant_ref    text not null,
  day           date not null,
  vendor        text not null,
  seats         int not null default 0,
  active_seats  int not null default 0,
  seat_cents    bigint not null default 0,
  usage_cents   bigint not null default 0,
  monthly_cents bigint not null default 0,
  estimated     boolean not null default false,
  connected     boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (tenant_ref, day, vendor)
);

-- Per day, leak type and vendor: how many leaks and what they're worth.
create table if not exists cp.spend_leaks_daily (
  tenant_ref     text not null,
  day            date not null,
  leak_type      text not null,
  vendor         text not null,
  leaks          int not null default 0,
  savings_cents  bigint not null default 0,
  at_risk_cents  bigint not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (tenant_ref, day, leak_type, vendor)
);

-- Every leak found: when it was first and last seen, when it went away. A leak
-- that comes back after being resolved starts over (first_seen_at, notified_at).
-- Runaway cost leaks are announced (webhook event pricing_leaks.runaway_cost,
-- email, Slack) once per episode and again weekly while they last; claiming
-- notified_at with an update makes that exactly once across instances.
create table if not exists cp.spend_leaks (
  tenant_ref     text not null,
  leak_id        text not null,           -- spend.Leak.ID: type:vendor:person
  leak_type      text not null,
  vendor         text not null,
  person         text not null default '',
  name           text not null default '',
  title          text not null default '',
  evidence       jsonb not null default '[]',
  confidence     text not null default '',
  savings_cents  bigint not null default 0,
  at_risk_cents  bigint not null default 0,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  notified_at    timestamptz,
  notify_result  jsonb not null default '{}',
  primary key (tenant_ref, leak_id)
);
create index if not exists spend_leaks_recent on cp.spend_leaks (tenant_ref, leak_type, last_seen_at desc);
