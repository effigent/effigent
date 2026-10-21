package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// EventRetention is a tenant's retention override and legal hold.
type EventRetention struct {
	RetentionDays int        `json:"retention_days"` // 0 = the control plane's default
	LegalHold     bool       `json:"legal_hold"`
	HoldReason    string     `json:"hold_reason"`
	HoldSetBy     string     `json:"hold_set_by,omitempty"`
	HoldSetAt     *time.Time `json:"hold_set_at,omitempty"`
	// the archive objects' legal hold sync
	HoldGeneration int        `json:"-"`
	HoldSynced     int        `json:"-"`
	HoldObjects    int        `json:"hold_objects"`
	HoldSyncedAt   *time.Time `json:"hold_synced_at,omitempty"`
	HoldError      string     `json:"hold_error,omitempty"`
	UpdatedBy      string     `json:"updated_by,omitempty"`
	UpdatedAt      *time.Time `json:"updated_at,omitempty"`
}

// HoldInSync reports whether the archive objects carry the current hold state.
func (e EventRetention) HoldInSync() bool { return e.HoldSynced == e.HoldGeneration }

// ErrLegalHold: the tenant's events are under a legal hold.
var ErrLegalHold = errors.New("the workspace's events are under a legal hold")

const retentionCols = `retention_days, legal_hold, hold_reason, hold_set_by, hold_set_at, hold_generation, hold_synced, hold_objects,
	hold_synced_at, hold_error, updated_by, updated_at`

func scanRetention(r pgx.Row) (EventRetention, error) {
	var e EventRetention
	var at time.Time
	err := r.Scan(&e.RetentionDays, &e.LegalHold, &e.HoldReason, &e.HoldSetBy, &e.HoldSetAt, &e.HoldGeneration, &e.HoldSynced, &e.HoldObjects,
		&e.HoldSyncedAt, &e.HoldError, &e.UpdatedBy, &at)
	if err == nil {
		e.UpdatedAt = &at
	}
	return e, err
}

func (s *Store) GetEventRetention(ctx context.Context, tenant string) (EventRetention, error) {
	e, err := scanRetention(s.db.QueryRow(ctx, `select `+retentionCols+` from cp.event_retention where tenant_ref = $1`, tenant))
	if errors.Is(err, pgx.ErrNoRows) {
		return EventRetention{}, nil
	}
	return e, err
}

// holdLock serialises a tenant's hold changes with archiving (CompleteArchiveDay).
const holdLock = `select pg_advisory_xact_lock(hashtext('cp.event_retention:' || $1))`

// PutEventRetention saves the retention override and hold. Changing the
// hold bumps the generation, so the archive objects are synced again.
func (s *Store) PutEventRetention(ctx context.Context, tenant string, days int, hold bool, reason, by string) (EventRetention, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return EventRetention{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, holdLock, tenant); err != nil {
		return EventRetention{}, err
	}
	e, err := scanRetention(tx.QueryRow(ctx, `insert into cp.event_retention (tenant_ref, retention_days, legal_hold, hold_reason, hold_set_by, hold_set_at,
			hold_generation, updated_by)
		values ($1, $2, $3, $4, $5, case when $3 then now() end, case when $3 then 1 else 0 end, $5)
		on conflict (tenant_ref) do update set retention_days = $2, legal_hold = $3, hold_reason = $4,
			hold_set_by = case when cp.event_retention.legal_hold is distinct from $3 then $5 else cp.event_retention.hold_set_by end,
			hold_set_at = case when cp.event_retention.legal_hold is distinct from $3 then now() else cp.event_retention.hold_set_at end,
			hold_generation = cp.event_retention.hold_generation + case when cp.event_retention.legal_hold is distinct from $3 then 1 else 0 end,
			hold_error = case when cp.event_retention.legal_hold is distinct from $3 then '' else cp.event_retention.hold_error end,
			updated_by = $5, updated_at = now()
		returning `+retentionCols, tenant, days, hold, reason, by))
	if err != nil {
		return e, err
	}
	return e, tx.Commit(ctx)
}

// HoldSyncDue lists the tenants whose archive objects don't carry their
// current hold state yet.
func (s *Store) HoldSyncDue(ctx context.Context) (map[string]EventRetention, error) {
	rows, err := s.db.Query(ctx, `select tenant_ref, `+retentionCols+` from cp.event_retention where hold_synced <> hold_generation`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]EventRetention{}
	for rows.Next() {
		var t string
		var e EventRetention
		var at time.Time
		if err := rows.Scan(&t, &e.RetentionDays, &e.LegalHold, &e.HoldReason, &e.HoldSetBy, &e.HoldSetAt, &e.HoldGeneration, &e.HoldSynced,
			&e.HoldObjects, &e.HoldSyncedAt, &e.HoldError, &e.UpdatedBy, &at); err != nil {
			return nil, err
		}
		out[t] = e
	}
	return out, rows.Err()
}

// HoldSyncDone records a finished sync of generation gen (a later change
// keeps the tenant due); errMsg != "" records a failed one.
func (s *Store) HoldSyncDone(ctx context.Context, tenant string, gen, objects int, errMsg string) error {
	if errMsg != "" {
		_, err := s.db.Exec(ctx, `update cp.event_retention set hold_error = $2 where tenant_ref = $1`, tenant, errMsg)
		return err
	}
	_, err := s.db.Exec(ctx, `update cp.event_retention set hold_synced = greatest(hold_synced, $2), hold_objects = $3, hold_synced_at = now(), hold_error = ''
		where tenant_ref = $1 and hold_generation >= $2`, tenant, gen, objects)
	return err
}

// LegalHold reports whether a tenant's events are on hold.
func (s *Store) LegalHold(ctx context.Context, tenant string) (bool, error) {
	var on bool
	err := s.db.QueryRow(ctx, `select legal_hold from cp.event_retention where tenant_ref = $1`, tenant).Scan(&on)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return on, err
}

// HoldLock holds the cluster-wide legal hold sync lock until release.
func (s *Store) HoldLock(ctx context.Context) (release func(), ok bool, err error) {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	if err := conn.QueryRow(ctx, `select pg_try_advisory_lock(hashtext('cp.events.legal_hold'))`).Scan(&ok); err != nil || !ok {
		conn.Release()
		return nil, false, err
	}
	return func() {
		_, _ = conn.Exec(context.Background(), `select pg_advisory_unlock(hashtext('cp.events.legal_hold'))`)
		conn.Release()
	}, true, nil
}
