-- Who decides what: approver groups (workspace members) and ordered routing
-- rules, one document per tenant; each request records the group and rule it
-- was routed to when it was filed.
create table if not exists cp.approval_routing (
  tenant_ref  text primary key,
  config      jsonb not null default '{}',
  updated_by  text not null default '',
  updated_at  timestamptz not null default now()
);

alter table cp.approvals
  add column if not exists group_id text not null default '',
  add column if not exists route_id text not null default '';
