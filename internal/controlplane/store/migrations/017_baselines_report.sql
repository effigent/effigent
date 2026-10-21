-- Behaviour baselines (novelty detection, not prompt-injection detection):
-- per machine and agent, the binaries it ran, hosts it reached, MCP servers it
-- used and action kinds it hit, with when each was first and last seen.
-- Filled in IngestBatch's transaction (inventory.Extract / inventory.Decide).
-- Caps per key (inventory.Caps): past them a key stops learning (overflow).
create table if not exists cp.baseline_keys (
  tenant_ref   text not null,
  endpoint_id  uuid not null,
  agent        text not null,
  kind         text not null,           -- binary | host | mcp | action
  values_n     int not null default 0,  -- distinct values kept
  overflow     bigint not null default 0, -- sightings not kept: the key was at its cap
  signals_day  date,
  signals      int not null default 0,  -- first-seen signals on signals_day
  suppressed   bigint not null default 0, -- signals over the daily cap
  first_at     timestamptz not null default now(),
  primary key (tenant_ref, endpoint_id, agent, kind)
);

create table if not exists cp.baseline_values (
  tenant_ref   text not null,
  endpoint_id  uuid not null,
  agent        text not null,
  kind         text not null,
  value        text not null,
  first_at     timestamptz not null,
  last_at      timestamptz not null,
  seen         bigint not null default 0,
  primary key (tenant_ref, endpoint_id, agent, kind, value)
);

-- First-seen signals: a value outside the agent's last 30 days on that
-- machine, after its 7-day warm-up. prev_last_at: when it was seen before
-- (null = never).
create table if not exists cp.anomalies (
  id           bigserial primary key,
  tenant_ref   text not null,
  endpoint_id  uuid not null,
  agent        text not null,
  kind         text not null,
  value        text not null,
  seen_at      timestamptz not null,
  event_type   text not null default '',
  prev_last_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists anomalies_tenant_time on cp.anomalies (tenant_ref, seen_at desc, id desc);

-- The posture report, emailed on a schedule (weekly or monthly). next_at is
-- claimed with one update, so a send happens once across instances.
create table if not exists cp.report_schedules (
  tenant_ref    text primary key,
  enabled       boolean not null default false,
  cadence       text not null default 'weekly' check (cadence in ('weekly', 'monthly')),
  emails        text[] not null default '{}',
  next_at       timestamptz,
  last_sent_at  timestamptz,
  last_result   jsonb,
  updated_by    text not null default '',
  updated_at    timestamptz not null default now()
);
create index if not exists report_schedules_due on cp.report_schedules (next_at) where enabled;
