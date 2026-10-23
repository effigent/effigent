package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Break-glass codes (migration 018): signed offline grants that lift a
// machine's approval lists. The code itself is never stored.

type BreakGlassCode struct {
	ID            string     `json:"id"`
	Tenant        string     `json:"-"`
	EndpointID    string     `json:"endpoint_id"` // "" = all machines
	Reason        string     `json:"reason"`
	Expiry        time.Time  `json:"expiry"`
	CreatedBy     string     `json:"created_by"`
	CreatedByName string     `json:"created_by_name"`
	CreatedVia    string     `json:"created_via"`
	CreatedAt     time.Time  `json:"created_at"`
	RevokedAt     *time.Time `json:"revoked_at"`
	UsedAt        *time.Time `json:"used_at"`
	UsedBy        string     `json:"used_by"`
	UsedOn        string     `json:"used_on"`
}

func (s *Store) CreateBreakGlass(ctx context.Context, c BreakGlassCode) error {
	_, err := s.db.Exec(ctx, `insert into cp.break_glass_codes
		(id, tenant_ref, endpoint_id, reason, expiry, created_by, created_by_name, created_via)
		values ($1,$2,$3,$4,$5,$6,$7,$8)`,
		c.ID, c.Tenant, c.EndpointID, c.Reason, c.Expiry, c.CreatedBy, c.CreatedByName, c.CreatedVia)
	return err
}

const bgCols = `id, endpoint_id, reason, expiry, created_by, created_by_name, created_via, created_at, revoked_at, used_at, used_by, used_on`

func scanBreakGlass(r pgx.Row) (BreakGlassCode, error) {
	var c BreakGlassCode
	err := r.Scan(&c.ID, &c.EndpointID, &c.Reason, &c.Expiry, &c.CreatedBy, &c.CreatedByName, &c.CreatedVia,
		&c.CreatedAt, &c.RevokedAt, &c.UsedAt, &c.UsedBy, &c.UsedOn)
	return c, err
}

func (s *Store) ListBreakGlass(ctx context.Context, tenant string, limit int) ([]BreakGlassCode, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.db.Query(ctx, `select `+bgCols+` from cp.break_glass_codes
		where tenant_ref = $1 order by created_at desc limit $2`, tenant, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BreakGlassCode
	for rows.Next() {
		c, err := scanBreakGlass(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetBreakGlass(ctx context.Context, tenant, id string) (BreakGlassCode, error) {
	c, err := scanBreakGlass(s.db.QueryRow(ctx, `select `+bgCols+` from cp.break_glass_codes
		where tenant_ref = $1 and id = $2`, tenant, id))
	if err == pgx.ErrNoRows {
		return BreakGlassCode{}, ErrNotFound
	}
	return c, err
}

// RevokeBreakGlass marks a code revoked (an admin changed their mind). It
// can't reach a machine that is already offline.
func (s *Store) RevokeBreakGlass(ctx context.Context, tenant, id string) error {
	ct, err := s.db.Exec(ctx, `update cp.break_glass_codes set revoked_at = now()
		where tenant_ref = $1 and id = $2 and revoked_at is null`, tenant, id)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// BreakGlassActivity is the posture report's break-glass section for
// [from, to): codes issued and revoked (cp.break_glass_codes) and every
// activation a machine reported (the audit trail's break_glass.used: an
// all-machines code keeps only its first use on the row).
type BreakGlassActivity struct {
	Issued            int64           `json:"issued"`
	IssuedAllMachines int64           `json:"issued_all_machines"`
	Revoked           int64           `json:"revoked"`
	ExpiredUnused     int64           `json:"expired_unused"`
	Activations       int64           `json:"activations"`
	Machines          int64           `json:"machines"`
	UnknownCodes      int64           `json:"unknown_codes"` // used codes this control plane didn't issue
	Uses              []BreakGlassUse `json:"uses"`          // newest first, ≤ 50
}

type BreakGlassUse struct {
	At         time.Time `json:"at"`
	ID         string    `json:"id"`
	EndpointID string    `json:"endpoint_id"`
	Hostname   string    `json:"hostname"`
	OSUser     string    `json:"os_user"`
	Reason     string    `json:"reason"`
	CreatedBy  string    `json:"created_by"`
}

func (s *Store) BreakGlassActivity(ctx context.Context, tenant string, from, to time.Time) (BreakGlassActivity, error) {
	a := BreakGlassActivity{Uses: []BreakGlassUse{}}
	if err := s.db.QueryRow(ctx, `select
			count(*) filter (where created_at >= $2 and created_at < $3),
			count(*) filter (where created_at >= $2 and created_at < $3 and endpoint_id = ''),
			count(*) filter (where revoked_at >= $2 and revoked_at < $3),
			count(*) filter (where expiry >= $2 and expiry < least($3, now()) and used_at is null and revoked_at is null)
		from cp.break_glass_codes where tenant_ref = $1`, tenant, from, to).
		Scan(&a.Issued, &a.IssuedAllMachines, &a.Revoked, &a.ExpiredUnused); err != nil {
		return a, err
	}
	if err := s.db.QueryRow(ctx, `select count(*), count(distinct details->>'endpoint_id'),
			count(*) filter (where (details->>'unknown_code')::boolean)
		from cp.audit_log where tenant_ref = $1 and action = 'break_glass.used' and at >= $2 and at < $3`, tenant, from, to).
		Scan(&a.Activations, &a.Machines, &a.UnknownCodes); err != nil {
		return a, err
	}
	rows, err := s.db.Query(ctx, `select at, target, coalesce(details->>'endpoint_id', ''), coalesce(details->>'hostname', ''),
			coalesce(details->>'os_user', ''), coalesce(details->>'reason', ''), coalesce(details->>'created_by', '')
		from cp.audit_log where tenant_ref = $1 and action = 'break_glass.used' and at >= $2 and at < $3
		order by seq desc limit 50`, tenant, from, to)
	if err != nil {
		return a, err
	}
	defer rows.Close()
	for rows.Next() {
		var u BreakGlassUse
		if err := rows.Scan(&u.At, &u.ID, &u.EndpointID, &u.Hostname, &u.OSUser, &u.Reason, &u.CreatedBy); err != nil {
			return a, err
		}
		a.Uses = append(a.Uses, u)
	}
	return a, rows.Err()
}

// MarkBreakGlassUsed records the first use of a code (an all-machines code may
// be used on several machines; only the first is kept on the row). It returns
// the code's metadata so the caller can notify, and whether this was the
// first use.
func (s *Store) MarkBreakGlassUsed(ctx context.Context, tenant, id string, at time.Time, osUser, endpointID string) (BreakGlassCode, bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return BreakGlassCode{}, false, err
	}
	defer tx.Rollback(ctx)
	c, err := scanBreakGlass(tx.QueryRow(ctx, `select `+bgCols+` from cp.break_glass_codes
		where tenant_ref = $1 and id = $2 for update`, tenant, id))
	if err == pgx.ErrNoRows {
		return BreakGlassCode{}, false, ErrNotFound
	} else if err != nil {
		return BreakGlassCode{}, false, err
	}
	first := c.UsedAt == nil
	if first {
		if _, err := tx.Exec(ctx, `update cp.break_glass_codes set used_at = $3, used_by = $4, used_on = $5
			where tenant_ref = $1 and id = $2`, tenant, id, at, osUser, endpointID); err != nil {
			return BreakGlassCode{}, false, err
		}
		c.UsedAt, c.UsedBy, c.UsedOn = &at, osUser, endpointID
	}
	return c, first, tx.Commit(ctx)
}
