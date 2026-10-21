package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Reads for the inventory page and the posture report (migrations 016, 017).

// AgentSighting is one agent on one machine (cp.agent_inventory).
type AgentSighting struct {
	EndpointID   string     `json:"endpoint_id"`
	Agent        string     `json:"agent"`
	FirstAt      time.Time  `json:"first_seen"`
	LastAt       time.Time  `json:"last_seen"`
	Events       int64      `json:"events"`
	HookEvents   int64      `json:"hook_events"`
	KernelEvents int64      `json:"kernel_events"`
	Mode         string     `json:"mode"`
	ModeAt       *time.Time `json:"mode_at,omitempty"`
}

// AgentSightings lists the agents seen since a time, per machine.
func (s *Store) AgentSightings(ctx context.Context, tenant string, since time.Time) ([]AgentSighting, error) {
	rows, err := s.db.Query(ctx, `select endpoint_id::text, agent, first_at, last_at, events, hook_events, kernel_events, mode, mode_at
		from cp.agent_inventory where tenant_ref = $1 and last_at >= $2 order by agent, endpoint_id limit 20000`, tenant, since)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (AgentSighting, error) {
		var a AgentSighting
		err := r.Scan(&a.EndpointID, &a.Agent, &a.FirstAt, &a.LastAt, &a.Events, &a.HookEvents, &a.KernelEvents, &a.Mode, &a.ModeAt)
		return a, err
	})
}

// MCPUse is one MCP server's use by one agent on one machine since a day,
// per source (hook | kernel) and tool ("" for the kernel).
type MCPUse struct {
	Server      string    `json:"server"`
	EndpointID  string    `json:"endpoint_id"`
	Agent       string    `json:"agent"`
	Source      string    `json:"source"`
	Tool        string    `json:"tool"`
	Events      int64     `json:"events"`
	Unlisted    int64     `json:"unlisted"`
	FirstAt     time.Time `json:"first_at"`
	LastAt      time.Time `json:"last_at"`
	OSUsers     []string  `json:"os_users"`
	EverFirstAt *time.Time
}

// MCPUses reads cp.mcp_activity_daily since a day, with when each server was
// first seen for the machine and agent at all (its baseline, migration 017).
func (s *Store) MCPUses(ctx context.Context, tenant string, since time.Time) ([]MCPUse, error) {
	rows, err := s.db.Query(ctx, `select m.server, m.endpoint_id::text, m.agent, m.source, m.tool, sum(m.events)::bigint, sum(m.unlisted)::bigint,
			min(m.first_at), max(m.last_at), array_remove(array_agg(distinct m.os_user), ''), min(b.first_at)
		from cp.mcp_activity_daily m
		left join cp.baseline_values b on b.tenant_ref = m.tenant_ref and b.endpoint_id = m.endpoint_id and b.agent = m.agent
			and b.kind = 'mcp' and b.value = m.server
		where m.tenant_ref = $1 and m.day >= $2::date
		group by 1, 2, 3, 4, 5 order by 1, 2, 3, 4, 5 limit 20000`, tenant, since)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (MCPUse, error) {
		var m MCPUse
		err := r.Scan(&m.Server, &m.EndpointID, &m.Agent, &m.Source, &m.Tool, &m.Events, &m.Unlisted, &m.FirstAt, &m.LastAt, &m.OSUsers, &m.EverFirstAt)
		return m, err
	})
}

// EnforcementCount is one row of cp.enforcement_daily summed over a period.
type EnforcementCount struct {
	Type   string `json:"type"`
	Rule   string `json:"rule"`
	Detail string `json:"detail"`
	Agent  string `json:"agent"`
	Events int64  `json:"events"`
}

// EnforcementCounts sums enforcement outcomes over [from, to).
func (s *Store) EnforcementCounts(ctx context.Context, tenant string, from, to time.Time) ([]EnforcementCount, error) {
	rows, err := s.db.Query(ctx, `select type, rule, detail, agent, sum(events)::bigint from cp.enforcement_daily
		where tenant_ref = $1 and day >= $2::date and day < $3::date group by 1, 2, 3, 4 order by 5 desc`, tenant, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (EnforcementCount, error) {
		var c EnforcementCount
		err := r.Scan(&c.Type, &c.Rule, &c.Detail, &c.Agent, &c.Events)
		return c, err
	})
}

// EnforcementDay is one day's totals per type.
type EnforcementDay struct {
	Day    time.Time `json:"day"`
	Type   string    `json:"type"`
	Events int64     `json:"events"`
}

func (s *Store) EnforcementDays(ctx context.Context, tenant string, from, to time.Time) ([]EnforcementDay, error) {
	rows, err := s.db.Query(ctx, `select day, type, sum(events)::bigint from cp.enforcement_daily
		where tenant_ref = $1 and day >= $2::date and day < $3::date group by 1, 2 order by 1, 2`, tenant, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (EnforcementDay, error) {
		var d EnforcementDay
		err := r.Scan(&d.Day, &d.Type, &d.Events)
		return d, err
	})
}

// ApprovalStats summarizes the approval requests filed in [from, to).
type ApprovalStats struct {
	Requested           int64    `json:"requested"`
	Approved            int64    `json:"approved"` // approved or used
	Denied              int64    `json:"denied"`
	Expired             int64    `json:"expired"` // expired, or pending past its deadline
	Pending             int64    `json:"pending"`
	MedianDecideSeconds *float64 `json:"median_decide_seconds"`
	SelfApprovalRefused int64    `json:"self_approval_refused"`
}

func (s *Store) ApprovalStats(ctx context.Context, tenant string, from, to time.Time) (ApprovalStats, error) {
	var a ApprovalStats
	err := s.db.QueryRow(ctx, `select count(*),
			count(*) filter (where state in ('approved', 'used')),
			count(*) filter (where state = 'denied'),
			count(*) filter (where state = 'expired' or (state = 'pending' and expires_at < now())),
			count(*) filter (where state = 'pending' and expires_at >= now()),
			percentile_cont(0.5) within group (order by extract(epoch from decided_at - requested_at)) filter (where decided_at is not null and state <> 'expired')
		from cp.approvals where tenant_ref = $1 and requested_at >= $2 and requested_at < $3`, tenant, from, to).
		Scan(&a.Requested, &a.Approved, &a.Denied, &a.Expired, &a.Pending, &a.MedianDecideSeconds)
	if err != nil {
		return a, err
	}
	err = s.db.QueryRow(ctx, `select count(*) from cp.audit_log where tenant_ref = $1 and action = 'approval.self_approval_refused'
		and at >= $2 and at < $3`, tenant, from, to).Scan(&a.SelfApprovalRefused)
	return a, err
}

// PolicyActivity is what changed in the policy in [from, to).
type PolicyActivity struct {
	Versions            int64            `json:"versions_published"`
	Proposals           map[string]int64 `json:"proposals"` // by state, filed in the period
	SelfApprovalRefused int64            `json:"self_approval_refused"`
	ChangeApproval      bool             `json:"change_approval_on"`
}

func (s *Store) PolicyActivity(ctx context.Context, tenant string, from, to time.Time) (PolicyActivity, error) {
	p := PolicyActivity{Proposals: map[string]int64{}}
	if err := s.db.QueryRow(ctx, `select count(*) from cp.policy_versions where tenant_ref = $1 and created_at >= $2 and created_at < $3`,
		tenant, from, to).Scan(&p.Versions); err != nil {
		return p, err
	}
	rows, err := s.db.Query(ctx, `select state, count(*) from cp.policy_proposals where tenant_ref = $1 and created_at >= $2 and created_at < $3 group by 1`,
		tenant, from, to)
	if err != nil {
		return p, err
	}
	for rows.Next() {
		var st string
		var n int64
		if err := rows.Scan(&st, &n); err != nil {
			rows.Close()
			return p, err
		}
		p.Proposals[st] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return p, err
	}
	if err := s.db.QueryRow(ctx, `select count(*) from cp.audit_log where tenant_ref = $1 and action = 'policy.self_approval_refused'
		and at >= $2 and at < $3`, tenant, from, to).Scan(&p.SelfApprovalRefused); err != nil {
		return p, err
	}
	err = s.db.QueryRow(ctx, `select coalesce((select policy_change_approval from cp.policy_settings where tenant_ref = $1), false)`, tenant).Scan(&p.ChangeApproval)
	return p, err
}

// AnomalyCounts counts first-seen signals in [from, to) by kind.
func (s *Store) AnomalyCounts(ctx context.Context, tenant string, from, to time.Time) (map[string]int64, error) {
	rows, err := s.db.Query(ctx, `select kind, count(*) from cp.anomalies where tenant_ref = $1 and seen_at >= $2 and seen_at < $3 group by 1`, tenant, from, to)
	if err != nil {
		return nil, err
	}
	out := map[string]int64{}
	for rows.Next() {
		var k string
		var n int64
		if err := rows.Scan(&k, &n); err != nil {
			rows.Close()
			return nil, err
		}
		out[k] = n
	}
	rows.Close()
	return out, rows.Err()
}

// SpendLeakChanges counts Pricing Leaks episodes found and resolved in [from, to).
func (s *Store) SpendLeakChanges(ctx context.Context, tenant string, from, to time.Time) (found, resolved int64, resolvedCents int64, err error) {
	err = s.db.QueryRow(ctx, `select count(*) filter (where first_seen_at >= $2 and first_seen_at < $3),
			count(*) filter (where resolved_at >= $2 and resolved_at < $3),
			coalesce(sum(savings_cents) filter (where resolved_at >= $2 and resolved_at < $3), 0)::bigint
		from cp.spend_leaks where tenant_ref = $1`, tenant, from, to).Scan(&found, &resolved, &resolvedCents)
	return
}

// InventoryBackfillDays is how far back migration 016 filled the rollups.
const InventoryBackfillDays = 35

// FirstRollupDay is the first day the inventory rollups cover: the day
// migration 016 ran, less its backfill. Earlier periods count nothing.
func (s *Store) FirstRollupDay(ctx context.Context, tenant string) (*time.Time, error) {
	var at time.Time
	err := s.db.QueryRow(ctx, `select applied_at from cp.schema_migrations where name = '016_inventory.sql'`).Scan(&at)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	at = at.UTC()
	d := time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -InventoryBackfillDays)
	return &d, nil
}
