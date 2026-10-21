-- Inventory and posture rollups. Like cp.agent_activity_daily (migration 010)
-- they are upserted in the transaction that stores each ingested batch
-- (store.IngestBatch, from that batch's rows only), so the inventory page and
-- the posture report never scan cp.events.

-- Every agent seen per machine: when, how often, its last mode (claude-cowork
-- reports "unmanaged"), and whether its events came from an agent hook
-- (no process in the event) or from the kernel sensor (a process).
create table if not exists cp.agent_inventory (
  tenant_ref     text not null,
  endpoint_id    uuid not null,
  agent          text not null,
  first_at       timestamptz not null,
  last_at        timestamptz not null,
  events         bigint not null default 0,
  hook_events    bigint not null default 0,
  kernel_events  bigint not null default 0,
  mode           text not null default '',
  mode_at        timestamptz,
  primary key (tenant_ref, endpoint_id, agent)
);

-- MCP servers per day, machine, agent and OS user. server/tool come from the
-- hook's tool name (mcp__<server>__<tool>, source 'hook') or from the kernel
-- (the MCP server process an event ran under, "via": mcp:<label>; no tool
-- name, source 'kernel'). unlisted = calls the hook flagged mcp_unlisted
-- (outside the policy's mcp_allow on that machine).
create table if not exists cp.mcp_activity_daily (
  tenant_ref   text not null,
  endpoint_id  uuid not null,
  day          date not null,
  agent        text not null,
  os_user      text not null default '',
  server       text not null,
  tool         text not null default '',
  source       text not null,
  events       bigint not null default 0,
  unlisted     bigint not null default 0,
  first_at     timestamptz not null,
  last_at      timestamptz not null,
  primary key (tenant_ref, endpoint_id, day, agent, os_user, server, tool, source)
);
create index if not exists mcp_activity_daily_day on cp.mcp_activity_daily (tenant_ref, day);

-- Enforcement outcomes per day: blocked / would_block / file_open and the
-- approval events, by the list that matched (rule: exec_deny, actions_deny…;
-- kernel policies collapse to kernel_lsm / kernel_net) and, for the action
-- lists, the action kind (detail). The posture report's "blocked by kind".
create table if not exists cp.enforcement_daily (
  tenant_ref   text not null,
  endpoint_id  uuid not null,
  day          date not null,
  agent        text not null,
  type         text not null,
  rule         text not null default '',
  detail       text not null default '',
  events       bigint not null default 0,
  primary key (tenant_ref, endpoint_id, day, agent, type, rule, detail)
);
create index if not exists enforcement_daily_day on cp.enforcement_daily (tenant_ref, day);

-- Backfill the last 35 days (the same statements IngestBatch runs per batch:
-- store/inventory_rollup.go; TestInventoryBackfillInStep keeps them in step).
insert into cp.agent_inventory as a (tenant_ref, endpoint_id, agent, first_at, last_at, events, hook_events, kernel_events, mode, mode_at)
select tenant_ref, endpoint_id, left(agent, 120), min(event_time), max(event_time), count(*),
       count(*) filter (where not (body ? 'process')), count(*) filter (where body ? 'process'),
       coalesce((array_agg(left(body->>'mode', 40) order by event_time desc) filter (where coalesce(body->>'mode', '') <> ''))[1], ''),
       max(event_time) filter (where coalesce(body->>'mode', '') <> '')
from (select * from cp.events where event_time >= now() - interval '35 days') e
where agent <> '' and agent not like 'mcp:%'
group by 1, 2, 3
on conflict (tenant_ref, endpoint_id, agent) do update set
  first_at = least(a.first_at, excluded.first_at), last_at = greatest(a.last_at, excluded.last_at),
  events = a.events + excluded.events, hook_events = a.hook_events + excluded.hook_events,
  kernel_events = a.kernel_events + excluded.kernel_events,
  mode = case when excluded.mode <> '' and (a.mode_at is null or excluded.mode_at >= a.mode_at) then excluded.mode else a.mode end,
  mode_at = greatest(a.mode_at, excluded.mode_at);

insert into cp.mcp_activity_daily as d (tenant_ref, endpoint_id, day, agent, os_user, server, tool, source, events, unlisted, first_at, last_at)
select tenant_ref, endpoint_id, day, agent, os_user, left(server, 120), left(tool, 120), source, count(*),
       count(*) filter (where unlisted), min(event_time), max(event_time)
from (
  select tenant_ref, endpoint_id, event_time, (event_time at time zone 'UTC')::date as day, left(agent, 120) agent,
         left(lower(coalesce(body->>'os_user', '')), 200) os_user,
         case when t like 'mcp\_\_%' then split_part(substr(t, 6), '__', 1) else substr(body->>'via', 5) end server,
         case when t like 'mcp\_\_%' then substr(t, length(split_part(substr(t, 6), '__', 1)) + 8) else '' end tool,
         case when body ? 'process' then 'kernel' else 'hook' end source,
         coalesce(body->'actions' @> '[{"kind":"mcp_unlisted"}]', false) unlisted
  from (select *, split_part(coalesce(body->>'target', ''), ': ', 1) t from (select * from cp.events where event_time >= now() - interval '35 days') b
        where agent <> '' and agent not like 'mcp:%') e
  where (t like 'mcp\_\_%' and not (body ? 'process')) or coalesce(body->>'via', '') like 'mcp:_%'
) m
where server <> ''
group by 1, 2, 3, 4, 5, 6, 7, 8
on conflict (tenant_ref, endpoint_id, day, agent, os_user, server, tool, source) do update set
  events = d.events + excluded.events, unlisted = d.unlisted + excluded.unlisted,
  first_at = least(d.first_at, excluded.first_at), last_at = greatest(d.last_at, excluded.last_at);

insert into cp.enforcement_daily as d (tenant_ref, endpoint_id, day, agent, type, rule, detail, events)
select tenant_ref, endpoint_id, day, agent, type, rule, detail, count(*)
from (
  select tenant_ref, endpoint_id, (event_time at time zone 'UTC')::date as day, left(agent, 120) agent, type,
         case when r ~ '-lsm$' then case when t like 'exec %' then 'kernel_exec' when t like 'connect %' then 'kernel_connect' else 'kernel_file' end
              when r ~ '-net$' then 'kernel_connect'
              when r ~ '^[a-z_]{1,40}$' then r when r = '' then '' else 'other' end rule,
         case when r like 'actions\_%' then coalesce((select left(a->>'kind', 40)
              from jsonb_array_elements(case when jsonb_typeof(body->'actions') = 'array' then body->'actions' else '[]'::jsonb end) a
              where coalesce(a->>'kind', '') <> '' and position(a->>'kind' in coalesce(body->>'message', '')) > 0 limit 1), '') else '' end detail
  from (select *, coalesce(body->>'rule', '') r, coalesce(body->>'target', '') t from (select * from cp.events where event_time >= now() - interval '35 days') b
        where agent <> '' and type in ('blocked', 'would_block', 'file_open', 'approval_pending', 'approved', 'approval_denied')) e
) x
group by 1, 2, 3, 4, 5, 6, 7
on conflict (tenant_ref, endpoint_id, day, agent, type, rule, detail) do update set events = d.events + excluded.events;
