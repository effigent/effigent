package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/inventory"
	"github.com/jackc/pgx/v5"
)

// Anomaly is one first-seen signal (migration 017).
type Anomaly struct {
	ID         int64      `json:"id"`
	EndpointID string     `json:"endpoint_id"`
	Agent      string     `json:"agent"`
	Kind       string     `json:"kind"`
	Value      string     `json:"value"`
	SeenAt     time.Time  `json:"seen_at"`
	EventType  string     `json:"event_type"`
	PrevLastAt *time.Time `json:"prev_last_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

// applyBaselines records a batch's baseline values and returns the
// first-seen signals it raised. It runs in IngestBatch's transaction, after
// the inventory rollups (an agent's warm-up starts at its first
// agent_inventory sighting) and under the endpoint's advisory lock, so one
// machine's baselines are never updated concurrently.
func applyBaselines(ctx context.Context, tx pgx.Tx, tenant, endpointID string, seen []inventory.Seen) ([]Anomaly, error) {
	if len(seen) == 0 {
		return nil, nil
	}
	var agents, kAgents, kKinds, vAgents, vKinds, vValues []string
	ag := map[string]bool{}
	kk := map[string]bool{}
	for _, s := range seen {
		if !ag[s.Agent] {
			ag[s.Agent] = true
			agents = append(agents, s.Agent)
		}
		if k := inventory.KeyKey(s.Agent, s.Kind); !kk[k] {
			kk[k] = true
			kAgents, kKinds = append(kAgents, s.Agent), append(kKinds, s.Kind)
		}
		vAgents, vKinds, vValues = append(vAgents, s.Agent), append(vKinds, s.Kind), append(vValues, s.Value)
	}
	first := map[string]time.Time{}
	rows, err := tx.Query(ctx, `select agent, first_at from cp.agent_inventory where tenant_ref = $1 and endpoint_id = $2 and agent = any($3)`,
		tenant, endpointID, agents)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a string
		var t time.Time
		if err := rows.Scan(&a, &t); err != nil {
			rows.Close()
			return nil, err
		}
		first[a] = t
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	keys := map[string]*inventory.KeyState{}
	rows, err = tx.Query(ctx, `select k.agent, k.kind, k.values_n, k.signals_day, k.signals from cp.baseline_keys k
		join unnest($3::text[], $4::text[]) x(agent, kind) on x.agent = k.agent and x.kind = k.kind
		where k.tenant_ref = $1 and k.endpoint_id = $2`, tenant, endpointID, kAgents, kKinds)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a, k string
		var day *time.Time
		var st inventory.KeyState
		if err := rows.Scan(&a, &k, &st.Values, &day, &st.Signals); err != nil {
			rows.Close()
			return nil, err
		}
		if day != nil {
			st.SignalsDay = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
		}
		keys[inventory.KeyKey(a, k)] = &st
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	last := map[string]time.Time{}
	rows, err = tx.Query(ctx, `select v.agent, v.kind, v.value, v.last_at from cp.baseline_values v
		join unnest($3::text[], $4::text[], $5::text[]) x(agent, kind, value) on x.agent = v.agent and x.kind = v.kind and x.value = v.value
		where v.tenant_ref = $1 and v.endpoint_id = $2`, tenant, endpointID, vAgents, vKinds, vValues)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a, k, v string
		var t time.Time
		if err := rows.Scan(&a, &k, &v, &t); err != nil {
			rows.Close()
			return nil, err
		}
		last[inventory.ValueKey(a, k, v)] = t
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	decisions, overflow, suppressed := inventory.Decide(seen, first, keys, last)

	b := &pgx.Batch{}
	for _, d := range decisions {
		if !d.Store {
			continue
		}
		b.Queue(`insert into cp.baseline_values as v (tenant_ref, endpoint_id, agent, kind, value, first_at, last_at, seen)
			values ($1, $2, $3, $4, $5, $6, $6, $7)
			on conflict (tenant_ref, endpoint_id, agent, kind, value) do update
			set first_at = least(v.first_at, excluded.first_at), last_at = greatest(v.last_at, excluded.last_at), seen = v.seen + excluded.seen`,
			tenant, endpointID, d.Agent, d.Kind, d.Value, d.At, d.Count)
	}
	for k, st := range keys {
		agent, kind, _ := strings.Cut(k, "\x00")
		var day *time.Time
		if !st.SignalsDay.IsZero() {
			d := st.SignalsDay
			day = &d
		}
		b.Queue(`insert into cp.baseline_keys as k (tenant_ref, endpoint_id, agent, kind, values_n, overflow, signals_day, signals, suppressed)
			values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)
			on conflict (tenant_ref, endpoint_id, agent, kind) do update
			set values_n = excluded.values_n, overflow = k.overflow + excluded.overflow, signals_day = excluded.signals_day,
			    signals = excluded.signals, suppressed = k.suppressed + excluded.suppressed`,
			tenant, endpointID, agent, kind, st.Values, overflow[k], day, st.Signals, suppressed[k])
	}
	var out []Anomaly
	var signalled []int
	for i, d := range decisions {
		if !d.Signal {
			continue
		}
		signalled = append(signalled, i)
		b.Queue(`insert into cp.anomalies (tenant_ref, endpoint_id, agent, kind, value, seen_at, event_type, prev_last_at)
			values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, created_at`,
			tenant, endpointID, d.Agent, d.Kind, d.Value, d.At, d.EventType, d.PrevLast)
	}
	br := tx.SendBatch(ctx, b)
	defer br.Close()
	n := b.Len() - len(signalled)
	for i := 0; i < n; i++ {
		if _, err := br.Exec(); err != nil {
			return nil, fmt.Errorf("baselines: %w", err)
		}
	}
	for _, i := range signalled {
		d := decisions[i]
		a := Anomaly{EndpointID: endpointID, Agent: d.Agent, Kind: d.Kind, Value: d.Value, SeenAt: d.At, EventType: d.EventType, PrevLastAt: d.PrevLast}
		if err := br.QueryRow().Scan(&a.ID, &a.CreatedAt); err != nil {
			return nil, fmt.Errorf("baselines: %w", err)
		}
		out = append(out, a)
	}
	return out, br.Close()
}

// AnomalyQuery filters GET /api/v1/anomalies. Zero values mean no filter.
type AnomalyQuery struct {
	Limit    int
	Before   string // cursor: "<unix nanos>_<id>"
	Kinds    []string
	Agent    string
	Endpoint string
	Q        string // substring of the value
	Since    time.Time
}

// QueryAnomalies returns one page, newest first, and the next cursor.
func (s *Store) QueryAnomalies(ctx context.Context, tenant string, q AnomalyQuery) ([]Anomaly, string, error) {
	where := []string{"tenant_ref = $1"}
	args := []any{tenant}
	arg := func(v any) string { args = append(args, v); return fmt.Sprintf("$%d", len(args)) }
	if len(q.Kinds) > 0 {
		where = append(where, "kind = any("+arg(q.Kinds)+"::text[])")
	}
	if q.Agent != "" {
		where = append(where, "agent = "+arg(q.Agent))
	}
	if q.Endpoint != "" {
		where = append(where, "endpoint_id::text = "+arg(q.Endpoint))
	}
	if q.Q != "" {
		where = append(where, "value ilike '%' || "+arg(likeEscape(q.Q))+" || '%'")
	}
	if !q.Since.IsZero() {
		where = append(where, "seen_at >= "+arg(q.Since))
	}
	if q.Before != "" {
		ns, id, ok := strings.Cut(q.Before, "_")
		n, err1 := strconv.ParseInt(ns, 10, 64)
		i, err2 := strconv.ParseInt(id, 10, 64)
		if !ok || err1 != nil || err2 != nil {
			return nil, "", errors.New("bad cursor")
		}
		where = append(where, "(seen_at, id) < ("+arg(time.Unix(0, n).UTC())+", "+arg(i)+")")
	}
	rows, err := s.db.Query(ctx, `select id, endpoint_id::text, agent, kind, value, seen_at, event_type, prev_last_at, created_at
		from cp.anomalies where `+strings.Join(where, " and ")+` order by seen_at desc, id desc limit `+arg(q.Limit+1), args...)
	if err != nil {
		return nil, "", err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Anomaly, error) {
		var a Anomaly
		err := r.Scan(&a.ID, &a.EndpointID, &a.Agent, &a.Kind, &a.Value, &a.SeenAt, &a.EventType, &a.PrevLastAt, &a.CreatedAt)
		return a, err
	})
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > q.Limit {
		out = out[:q.Limit]
		l := out[len(out)-1]
		next = fmt.Sprintf("%d_%d", l.SeenAt.UnixNano(), l.ID)
	}
	return out, next, nil
}

// BaselineStats is how much each kind has learned across the tenant.
type BaselineStats struct {
	Kind       string `json:"kind"`
	Keys       int64  `json:"keys"`        // machine+agent pairs with a baseline of this kind
	Values     int64  `json:"values"`      // distinct values kept
	AtCap      int64  `json:"keys_at_cap"` // keys that stopped learning
	Overflow   int64  `json:"overflow"`    // sightings not kept (cap)
	Suppressed int64  `json:"suppressed"`  // signals over the daily cap
}

func (s *Store) BaselineStats(ctx context.Context, tenant string) ([]BaselineStats, error) {
	caps := make([]int32, len(inventory.Kinds))
	for i, k := range inventory.Kinds {
		caps[i] = int32(inventory.Caps[k])
	}
	rows, err := s.db.Query(ctx, `select k.kind, count(*), coalesce(sum(values_n), 0)::bigint,
			count(*) filter (where values_n >= c.cap), coalesce(sum(overflow), 0)::bigint, coalesce(sum(suppressed), 0)::bigint
		from cp.baseline_keys k join unnest($2::text[], $3::int[]) c(kind, cap) on c.kind = k.kind
		where tenant_ref = $1 group by 1 order by 1`, tenant, inventory.Kinds, caps)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (BaselineStats, error) {
		var b BaselineStats
		err := r.Scan(&b.Kind, &b.Keys, &b.Values, &b.AtCap, &b.Overflow, &b.Suppressed)
		return b, err
	})
}

// PruneAnomalies removes signals older than keep.
func (s *Store) PruneAnomalies(ctx context.Context, keep time.Duration) (int64, error) {
	t, err := s.db.Exec(ctx, `delete from cp.anomalies where seen_at < now() - make_interval(secs => $1)`, keep.Seconds())
	return t.RowsAffected(), err
}
