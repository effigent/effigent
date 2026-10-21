package store

import (
	"context"
	"strings"
	"time"
)

// ConsoleUser is a person who signed in to the console through OIDC
// (migration 020).
type ConsoleUser struct {
	UserID    string    `json:"user_id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Role      string    `json:"role"`
	Groups    []string  `json:"groups"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
}

// SeeConsoleUser records a sign-in (insert, or refresh what the token said).
func (s *Store) SeeConsoleUser(ctx context.Context, tenant string, u ConsoleUser) error {
	if u.Groups == nil {
		u.Groups = []string{}
	}
	_, err := s.db.Exec(ctx, `insert into cp.console_users (tenant_ref, user_id, email, name, role, groups)
		values ($1, $2, $3, $4, $5, $6)
		on conflict (tenant_ref, user_id) do update set email = excluded.email, name = excluded.name,
		  role = excluded.role, groups = excluded.groups, last_seen = now()`,
		tenant, u.UserID, strings.ToLower(u.Email), u.Name, u.Role, u.Groups)
	return err
}

// ListConsoleUsers returns the tenant's users seen since `since` (zero: all),
// most recent first.
func (s *Store) ListConsoleUsers(ctx context.Context, tenant string, since time.Time) ([]ConsoleUser, error) {
	rows, err := s.db.Query(ctx, `select user_id, email, name, role, groups, first_seen, last_seen
		from cp.console_users where tenant_ref = $1 and last_seen >= $2 order by last_seen desc limit 1000`, tenant, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConsoleUser{}
	for rows.Next() {
		var u ConsoleUser
		if err := rows.Scan(&u.UserID, &u.Email, &u.Name, &u.Role, &u.Groups, &u.FirstSeen, &u.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ConsoleUserByEmail finds the user seen since `since` with this verified
// email (the most recent one if several share it), or ok=false.
func (s *Store) ConsoleUserByEmail(ctx context.Context, tenant, email string, since time.Time) (u ConsoleUser, ok bool, err error) {
	rows, err := s.db.Query(ctx, `select user_id, email, name, role, groups, first_seen, last_seen
		from cp.console_users where tenant_ref = $1 and email <> '' and lower(email) = lower($2) and last_seen >= $3
		order by last_seen desc limit 1`, tenant, strings.TrimSpace(email), since)
	if err != nil {
		return u, false, err
	}
	defer rows.Close()
	if rows.Next() {
		err = rows.Scan(&u.UserID, &u.Email, &u.Name, &u.Role, &u.Groups, &u.FirstSeen, &u.LastSeen)
		return u, err == nil, err
	}
	return u, false, rows.Err()
}

// ConsoleUserByID returns one user (any age), or ok=false.
func (s *Store) ConsoleUserByID(ctx context.Context, tenant, userID string) (u ConsoleUser, ok bool, err error) {
	rows, err := s.db.Query(ctx, `select user_id, email, name, role, groups, first_seen, last_seen
		from cp.console_users where tenant_ref = $1 and user_id = $2`, tenant, userID)
	if err != nil {
		return u, false, err
	}
	defer rows.Close()
	if rows.Next() {
		err = rows.Scan(&u.UserID, &u.Email, &u.Name, &u.Role, &u.Groups, &u.FirstSeen, &u.LastSeen)
		return u, err == nil, err
	}
	return u, false, rows.Err()
}
