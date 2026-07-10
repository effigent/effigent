-- Injected-tool registry: what the optimizer synthesized per agent, and the
-- owner's per-tool switch. `enabled=false` excludes a tool from every future
-- activation bundle (the dashboard's per-agent toggle). spec is the full
-- ToolSpec + replay verdict. Idempotent.
create table if not exists agent_tools (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  agent_id   text not null,
  tool_id    text not null,
  name       text not null,
  status     text not null default 'shadow',
  enabled    boolean not null default true,
  spec       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, agent_id, tool_id)
);
