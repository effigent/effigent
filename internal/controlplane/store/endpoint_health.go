package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Endpoint health (migration 014): the hook report effigentd sends with its
// heartbeat, its last daemon_stop, and the offline detector's marks.

// SetEndpointHooks replaces an endpoint's hook report with next(previous)
// and returns the previous one (nil the first time). The row is locked for
// the swap, so two heartbeats can't both build on the same previous report.
func (s *Store) SetEndpointHooks(ctx context.Context, id string, next func(prev json.RawMessage) json.RawMessage) (prev json.RawMessage, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `select hooks from cp.endpoints where id = $1 for update`, id).Scan(&prev); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `update cp.endpoints set hooks = $2, hooks_reported_at = now(),
		hooks_changed_at = case when hooks is distinct from $2::jsonb then now() else hooks_changed_at end
		where id = $1`, id, next(prev)); err != nil {
		return nil, err
	}
	return prev, tx.Commit(ctx)
}

// RecordEndpointStop keeps the newest daemon_stop an endpoint sent (a stop
// spooled by an earlier run may arrive after a newer one).
func (s *Store) RecordEndpointStop(ctx context.Context, id string, at time.Time, stop json.RawMessage) error {
	_, err := s.db.Exec(ctx, `update cp.endpoints set stopped_at = $2, stop = $3
		where id = $1 and (stopped_at is null or stopped_at < $2)`, id, at, stop)
	return err
}

// EndpointHealthLock is held while one control plane instance runs the
// offline detector (the RetentionLock pattern).
func (s *Store) EndpointHealthLock(ctx context.Context) (release func(), ok bool, err error) {
	return s.tryLock(ctx, "cp.endpoints.health")
}

// endpointColsOf is endpointCols qualified with a table alias.
func endpointColsOf(alias string) string {
	cols := strings.Split(endpointCols, ",")
	for i, c := range cols {
		cols[i] = alias + "." + strings.TrimSpace(c)
	}
	return strings.Join(cols, ", ")
}

// MarkEndpointsOffline marks endpoints silent for longer than their tenant's
// threshold (defaultAfter where the tenant has none) and returns them. Each
// silence is marked once: a row already marked doesn't match again until
// MarkEndpointsOnline clears it.
func (s *Store) MarkEndpointsOffline(ctx context.Context, defaultAfter time.Duration, limit int) ([]Endpoint, error) {
	return s.queryEndpoints(ctx, `update cp.endpoints set offline_at = now() where id in (
			select e.id from cp.endpoints e left join cp.endpoint_health_settings h on h.tenant_ref = e.tenant_ref
			where e.revoked_at is null and e.offline_at is null and e.last_seen is not null
				and e.last_seen < now() - make_interval(secs => coalesce(h.offline_after_seconds, $1))
			order by e.last_seen limit $2 for update of e skip locked)
		returning `+endpointCols, int(defaultAfter.Seconds()), limit)
}

// MarkEndpointsOnline clears the offline mark of endpoints heard from since,
// and returns them with the time they had been marked offline.
func (s *Store) MarkEndpointsOnline(ctx context.Context, limit int) ([]Endpoint, error) {
	return s.queryEndpoints(ctx, `with back as (select id, offline_at from cp.endpoints
			where offline_at is not null and revoked_at is null and last_seen > offline_at
			limit $1 for update skip locked)
		update cp.endpoints e set offline_at = null from back where e.id = back.id
		returning `+strings.Replace(endpointColsOf("e"), "e.offline_at", "back.offline_at", 1), limit)
}

func (s *Store) queryEndpoints(ctx context.Context, sql string, args ...any) ([]Endpoint, error) {
	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Endpoint{}
	for rows.Next() {
		e, err := scanEndpoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// EndpointHealthSettings is a tenant's offline threshold and email choices.
type EndpointHealthSettings struct {
	OfflineAfterSeconds int       `json:"offline_after_seconds"`
	EmailOffline        bool      `json:"email_offline"`
	EmailHooks          bool      `json:"email_hooks"`
	UpdatedBy           string    `json:"updated_by,omitempty"`
	UpdatedAt           time.Time `json:"updated_at,omitzero"`
	Saved               bool      `json:"saved"` // false: the defaults, nothing stored yet
}

// GetEndpointHealthSettings returns the tenant's settings, or the defaults
// (defaultAfter, both emails on) when it has none.
func (s *Store) GetEndpointHealthSettings(ctx context.Context, tenant string, defaultAfter time.Duration) (EndpointHealthSettings, error) {
	h := EndpointHealthSettings{Saved: true}
	err := s.db.QueryRow(ctx, `select offline_after_seconds, email_offline, email_hooks, updated_by, updated_at
		from cp.endpoint_health_settings where tenant_ref = $1`, tenant).
		Scan(&h.OfflineAfterSeconds, &h.EmailOffline, &h.EmailHooks, &h.UpdatedBy, &h.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return EndpointHealthSettings{OfflineAfterSeconds: int(defaultAfter.Seconds()), EmailOffline: true, EmailHooks: true}, nil
	}
	return h, err
}

func (s *Store) PutEndpointHealthSettings(ctx context.Context, tenant string, h EndpointHealthSettings, by string) error {
	_, err := s.db.Exec(ctx, `insert into cp.endpoint_health_settings (tenant_ref, offline_after_seconds, email_offline, email_hooks, updated_by, updated_at)
		values ($1, $2, $3, $4, $5, now())
		on conflict (tenant_ref) do update set offline_after_seconds = $2, email_offline = $3, email_hooks = $4, updated_by = $5, updated_at = now()`,
		tenant, h.OfflineAfterSeconds, h.EmailOffline, h.EmailHooks, by)
	return err
}
