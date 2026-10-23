-- Tamper alerts: effigentd stopped while the machine kept running, killed or
-- crashed (unclean restart on the same boot), or a kernel policy that failed to
-- load. Unlike offline alerts these are emailed by default: a deliberate stop is
-- not a laptop going to sleep, and a stop during a shutdown or reboot is never
-- alerted.
alter table cp.endpoint_health_settings add column if not exists email_tamper boolean not null default true;

-- When an alert of each kind last went out about this machine (the cooldown:
-- one per hour for stops and unclean restarts, one per day for policy load
-- failures). Claimed with a single update, so instances can't both send.
alter table cp.endpoints add column if not exists stop_alerted_at timestamptz;
alter table cp.endpoints add column if not exists unclean_alerted_at timestamptz;
alter table cp.endpoints add column if not exists policy_fail_alerted_at timestamptz;
