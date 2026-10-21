-- Endpoint health: whether each machine's agent hooks are in place, when it
-- went silent, and whether it said it was stopping.

-- effigentd's last hook report ({"sensor": …, "agents": {"claude": {…}, …}});
-- null = never reported (builds before hook state reporting).
alter table cp.endpoints add column if not exists hooks jsonb;
alter table cp.endpoints add column if not exists hooks_reported_at timestamptz;
-- when the report last changed (not just re-sent)
alter table cp.endpoints add column if not exists hooks_changed_at timestamptz;

-- Set by the offline detector when last_seen got older than the tenant's
-- threshold (one alert per silence), cleared when the machine is heard again.
alter table cp.endpoints add column if not exists offline_at timestamptz;
-- The newest daemon_stop event's time and details ({signal, os_user, via}).
-- "Stopped deliberately" = offline with nothing heard after this.
alter table cp.endpoints add column if not exists stopped_at timestamptz;
alter table cp.endpoints add column if not exists stop jsonb;

create index if not exists endpoints_silent on cp.endpoints (last_seen)
  where revoked_at is null and offline_at is null;

-- Per tenant: how long a machine may be silent before it is reported
-- offline, and which alerts go out by email (webhooks are chosen per webhook).
create table if not exists cp.endpoint_health_settings (
  tenant_ref             text primary key,
  offline_after_seconds  int not null,
  email_offline          boolean not null default true,
  email_hooks            boolean not null default true,
  updated_by             text not null default '',
  updated_at             timestamptz not null default now()
);
