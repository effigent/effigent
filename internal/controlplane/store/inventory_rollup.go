package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Inventory rollups (migration 016): agents per machine, MCP servers per
// day and enforcement outcomes per day, upserted from each ingested batch's
// rows inside IngestBatch's transaction. Migration 016 runs the same
// statements once over the last 35 days (keep the two in step).

// batchEvents is the batch's rows, the source of every rollup statement.
// A tool_result is the outcome of a call already counted, not activity.
const batchEvents = `(select * from cp.events where batch_id = $1 and type <> 'tool_result')`

var inventoryRollups = []string{
	// agents per machine
	`insert into cp.agent_inventory as a (tenant_ref, endpoint_id, agent, first_at, last_at, events, hook_events, kernel_events, mode, mode_at)
	select tenant_ref, endpoint_id, left(agent, 120), min(event_time), max(event_time), count(*),
	       count(*) filter (where not (body ? 'process')), count(*) filter (where body ? 'process'),
	       coalesce((array_agg(left(body->>'mode', 40) order by event_time desc) filter (where coalesce(body->>'mode', '') <> ''))[1], ''),
	       max(event_time) filter (where coalesce(body->>'mode', '') <> '')
	from ` + batchEvents + ` e
	where agent <> '' and agent not like 'mcp:%'
	group by 1, 2, 3
	on conflict (tenant_ref, endpoint_id, agent) do update set
	  first_at = least(a.first_at, excluded.first_at), last_at = greatest(a.last_at, excluded.last_at),
	  events = a.events + excluded.events, hook_events = a.hook_events + excluded.hook_events,
	  kernel_events = a.kernel_events + excluded.kernel_events,
	  mode = case when excluded.mode <> '' and (a.mode_at is null or excluded.mode_at >= a.mode_at) then excluded.mode else a.mode end,
	  mode_at = greatest(a.mode_at, excluded.mode_at)`,

	// MCP servers: the hook's mcp__<server>__<tool>, or the kernel's via
	`insert into cp.mcp_activity_daily as d (tenant_ref, endpoint_id, day, agent, os_user, server, tool, source, events, unlisted, first_at, last_at)
	select tenant_ref, endpoint_id, day, agent, os_user, left(server, 120), left(tool, 120), source, count(*),
	       count(*) filter (where unlisted), min(event_time), max(event_time)
	from (
	  select tenant_ref, endpoint_id, event_time, (event_time at time zone 'UTC')::date as day, left(agent, 120) agent,
	         left(lower(coalesce(body->>'os_user', '')), 200) os_user,
	         case when t like 'mcp\_\_%' then split_part(substr(t, 6), '__', 1) else substr(body->>'via', 5) end server,
	         case when t like 'mcp\_\_%' then substr(t, length(split_part(substr(t, 6), '__', 1)) + 8) else '' end tool,
	         case when body ? 'process' then 'kernel' else 'hook' end source,
	         coalesce(body->'actions' @> '[{"kind":"mcp_unlisted"}]', false) unlisted
	  from (select *, split_part(coalesce(body->>'target', ''), ': ', 1) t from ` + batchEvents + ` b
	        where agent <> '' and agent not like 'mcp:%') e
	  where (t like 'mcp\_\_%' and not (body ? 'process')) or coalesce(body->>'via', '') like 'mcp:_%'
	) m
	where server <> ''
	group by 1, 2, 3, 4, 5, 6, 7, 8
	on conflict (tenant_ref, endpoint_id, day, agent, os_user, server, tool, source) do update set
	  events = d.events + excluded.events, unlisted = d.unlisted + excluded.unlisted,
	  first_at = least(d.first_at, excluded.first_at), last_at = greatest(d.last_at, excluded.last_at)`,

	// enforcement outcomes by the list that matched
	`insert into cp.enforcement_daily as d (tenant_ref, endpoint_id, day, agent, type, rule, detail, events)
	select tenant_ref, endpoint_id, day, agent, type, rule, detail, count(*)
	from (
	  select tenant_ref, endpoint_id, (event_time at time zone 'UTC')::date as day, left(agent, 120) agent, type,
	         case when r ~ '-lsm$' then case when t like 'exec %' then 'kernel_exec' when t like 'connect %' then 'kernel_connect' else 'kernel_file' end
	              when r ~ '-net$' then 'kernel_connect'
	              when r ~ '^[a-z_]{1,40}$' then r when r = '' then '' else 'other' end rule,
	         case when r like 'actions\_%' then coalesce((select left(a->>'kind', 40)
	              from jsonb_array_elements(case when jsonb_typeof(body->'actions') = 'array' then body->'actions' else '[]'::jsonb end) a
	              where coalesce(a->>'kind', '') <> '' and position(a->>'kind' in coalesce(body->>'message', '')) > 0 limit 1), '') else '' end detail
	  from (select *, coalesce(body->>'rule', '') r, coalesce(body->>'target', '') t from ` + batchEvents + ` b
	        where agent <> '' and type in ('blocked', 'would_block', 'file_open', 'approval_pending', 'approved', 'approval_denied')) e
	) x
	group by 1, 2, 3, 4, 5, 6, 7
	on conflict (tenant_ref, endpoint_id, day, agent, type, rule, detail) do update set events = d.events + excluded.events`,
}

// rollupInventory runs the inventory rollups for one stored batch.
func rollupInventory(ctx context.Context, tx pgx.Tx, batchID int64) error {
	for _, q := range inventoryRollups {
		if _, err := tx.Exec(ctx, q, batchID); err != nil {
			name, _, _ := strings.Cut(strings.TrimPrefix(strings.TrimSpace(q), "insert into "), " ")
			return &rollupError{name, err}
		}
	}
	return nil
}

type rollupError struct {
	table string
	err   error
}

func (e *rollupError) Error() string { return "rollup " + e.table + ": " + e.err.Error() }
func (e *rollupError) Unwrap() error { return e.err }
