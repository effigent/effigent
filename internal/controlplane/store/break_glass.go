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
