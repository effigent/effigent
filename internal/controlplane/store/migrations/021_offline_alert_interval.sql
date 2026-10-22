-- Offline alert emails: off unless a workspace picks a repeat interval.
-- A laptop that sleeps goes offline and back many times a night, and each
-- silence is a new offline mark, so the email needs its own memory per machine.

-- 0 = never email about a machine going offline (the default, also for rows
-- saved with email_offline = true); N = at most one email per machine per N
-- minutes (60 … 10080). Webhooks and audit entries are not affected.
alter table cp.endpoint_health_settings add column if not exists offline_alert_interval_minutes int not null default 0;

-- When an offline email about this machine last went out. Not cleared when the
-- machine comes back online.
alter table cp.endpoints add column if not exists offline_alerted_at timestamptz;
