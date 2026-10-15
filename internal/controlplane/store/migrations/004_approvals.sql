-- Approval requests: an agent hook paused a tool call that matched an approval
-- list (exec_approve, command_approve, …) and asks an approver. One open
-- request (pending, or approved but not yet used) per machine and action
-- fingerprint, so retries of the same call don't create or notify again.
create table if not exists cp.approvals (
  id              text primary key,
  tenant_ref      text not null,
  endpoint_id     uuid not null references cp.endpoints (id),
  fingerprint     text not null,
  agent           text not null default '',
  session_id      text not null default '',
  tool            text not null default '',
  summary         text not null default '', -- redacted on the endpoint
  cwd             text not null default '',
  rule            text not null default '', -- the policy list that matched, e.g. command_approve
  reason          text not null default '',
  hostname        text not null default '',
  os_user         text not null default '',
  state           text not null default 'pending', -- pending | approved | denied | expired | used
  requested_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  decided_at      timestamptz,
  decided_by      text not null default '', -- console user id
  decided_by_name text not null default '', -- display name the console sent (not authoritative)
  note            text not null default '',
  used_at         timestamptz,
  notified        jsonb
);
create index if not exists approvals_tenant_time on cp.approvals (tenant_ref, requested_at desc);
create unique index if not exists approvals_one_open on cp.approvals (tenant_ref, endpoint_id, fingerprint)
  where state in ('pending', 'approved');

-- Where approval requests are announced. The Slack webhook URL is a secret:
-- the console API never returns it, only whether it is set.
create table if not exists cp.notification_settings (
  tenant_ref    text primary key,
  slack_webhook text not null default '',
  emails        text[] not null default '{}',
  updated_by    text not null default '',
  updated_at    timestamptz not null default now()
);
