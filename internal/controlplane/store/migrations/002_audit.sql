-- Append-only, hash-chained audit trail (PRD FR-50..52). Each row's hash covers
-- its content and the previous row's hash for the same tenant, so editing or
-- removing history breaks the chain and GET /api/v1/audit/verify reports it.
create table if not exists cp.audit_log (
  seq         bigserial primary key,
  tenant_ref  text not null,
  at          timestamptz not null default now(),
  actor       text not null,          -- Clerk user id, "endpoint:<id>", "admin-token", "system"
  actor_via   text not null default '',
  actor_role  text not null default '',
  action      text not null,          -- e.g. policy.publish, endpoint.revoke, denied.PUT /api/v1/policy
  target      text not null default '',
  details     jsonb not null default '{}',
  ip          text not null default '',
  prev_hash   text not null,
  hash        text not null
);
create index if not exists audit_tenant_seq on cp.audit_log (tenant_ref, seq desc);

create or replace function cp.audit_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'cp.audit_log is append-only';
end $$;

drop trigger if exists audit_log_no_update on cp.audit_log;
create trigger audit_log_no_update before update or delete on cp.audit_log
  for each row execute function cp.audit_log_append_only();
