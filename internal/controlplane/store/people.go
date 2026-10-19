package store

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/jackc/pgx/v5"
)

// People mapping (migration 010): who the workspace's people are, by work
// email, and the identities each goes by (spend.Kinds). Pricing Leaks joins
// vendor seats and effigentd's activity through it.

// PersonIdentity is one identity of a person.
type PersonIdentity struct {
	Kind      string    `json:"kind"`
	Value     string    `json:"value"`
	Email     string    `json:"email"`
	Source    string    `json:"source"` // manual | suggestion
	CreatedBy string    `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// PersonRow is one person and their identities.
type PersonRow struct {
	Email      string           `json:"email"`
	Name       string           `json:"name"`
	Identities []PersonIdentity `json:"identities"`
	UpdatedBy  string           `json:"updated_by,omitempty"`
	UpdatedAt  time.Time        `json:"updated_at"`
}

// IdentityConflict: an identity already belongs to someone else.
type IdentityConflict struct {
	Kind, Value, Email string
}

func (e *IdentityConflict) Error() string {
	return fmt.Sprintf("%s %q is already mapped to %s", e.Kind, e.Value, e.Email)
}

// ListPeople returns the tenant's people, by email.
func (s *Store) ListPeople(ctx context.Context, tenant string) ([]PersonRow, error) {
	rows, err := s.db.Query(ctx, `select email, name, updated_by, updated_at from cp.people where tenant_ref = $1 order by email`, tenant)
	if err != nil {
		return nil, err
	}
	out := []PersonRow{}
	idx := map[string]int{}
	for rows.Next() {
		var p PersonRow
		if err := rows.Scan(&p.Email, &p.Name, &p.UpdatedBy, &p.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		p.Identities = []PersonIdentity{}
		idx[p.Email] = len(out)
		out = append(out, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = s.db.Query(ctx, `select kind, value, email, source, created_by, created_at from cp.person_identities
		where tenant_ref = $1 order by email, kind, value`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var x PersonIdentity
		if err := rows.Scan(&x.Kind, &x.Value, &x.Email, &x.Source, &x.CreatedBy, &x.CreatedAt); err != nil {
			return nil, err
		}
		if i, ok := idx[x.Email]; ok {
			out[i].Identities = append(out[i].Identities, x)
		}
	}
	return out, rows.Err()
}

// GetPerson returns one person.
func (s *Store) GetPerson(ctx context.Context, tenant, email string) (PersonRow, error) {
	all, err := s.ListPeople(ctx, tenant) // a workspace has hundreds of people at most
	if err != nil {
		return PersonRow{}, err
	}
	for _, p := range all {
		if p.Email == email {
			return p, nil
		}
	}
	return PersonRow{}, ErrNotFound
}

// SpendPeople is the mapping as the spend package reads it.
func (s *Store) SpendPeople(ctx context.Context, tenant string) ([]spend.Person, error) {
	rows, err := s.ListPeople(ctx, tenant)
	if err != nil {
		return nil, err
	}
	out := make([]spend.Person, 0, len(rows))
	for _, p := range rows {
		sp := spend.Person{Email: p.Email, Name: p.Name, Aliases: []string{}}
		for _, x := range p.Identities {
			sp.Aliases = append(sp.Aliases, x.Kind+":"+x.Value)
		}
		out = append(out, sp)
	}
	return out, nil
}

// PutPerson creates or updates a person and replaces their identities. An
// identity that belongs to someone else is an *IdentityConflict.
func (s *Store) PutPerson(ctx context.Context, tenant, email, name string, ids []PersonIdentity, by string) (created bool, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `insert into cp.people (tenant_ref, email, name, created_by, updated_by) values ($1, $2, $3, $4, $4)
		on conflict (tenant_ref, email) do update set name = $3, updated_by = $4, updated_at = now()
		returning (xmax = 0)`, tenant, email, name, by).Scan(&created); err != nil {
		return false, err
	}
	keep := map[string]bool{}
	for _, x := range ids {
		keep[x.Kind+":"+x.Value] = true
	}
	old, err := identitiesOf(ctx, tx, tenant, email)
	if err != nil {
		return false, err
	}
	for _, x := range old {
		if !keep[x.Kind+":"+x.Value] {
			if _, err := tx.Exec(ctx, `delete from cp.person_identities where tenant_ref = $1 and kind = $2 and value = $3`, tenant, x.Kind, x.Value); err != nil {
				return false, err
			}
		}
	}
	for _, x := range ids {
		if err := addIdentity(ctx, tx, tenant, x.Kind, x.Value, email, cmpStr(x.Source, "manual"), by); err != nil {
			return false, err
		}
	}
	return created, tx.Commit(ctx)
}

// AddPersonIdentity maps one identity to a person, creating the person
// (with name) if needed.
func (s *Store) AddPersonIdentity(ctx context.Context, tenant, kind, value, email, name, source, by string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `insert into cp.people (tenant_ref, email, name, created_by, updated_by) values ($1, $2, $3, $4, $4)
		on conflict (tenant_ref, email) do update set name = case when cp.people.name = '' then $3 else cp.people.name end`,
		tenant, email, name, by); err != nil {
		return err
	}
	if kind != spend.KindPerson {
		if err := addIdentity(ctx, tx, tenant, kind, value, email, source, by); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func addIdentity(ctx context.Context, tx pgx.Tx, tenant, kind, value, email, source, by string) error {
	var owner string
	err := tx.QueryRow(ctx, `select email from cp.person_identities where tenant_ref = $1 and kind = $2 and value = $3`, tenant, kind, value).Scan(&owner)
	switch {
	case err == nil && owner != email:
		return &IdentityConflict{Kind: kind, Value: value, Email: owner}
	case err == nil:
		return nil
	case !errors.Is(err, pgx.ErrNoRows):
		return err
	}
	_, err = tx.Exec(ctx, `insert into cp.person_identities (tenant_ref, kind, value, email, source, created_by) values ($1, $2, $3, $4, $5, $6)`,
		tenant, kind, value, email, source, by)
	return err
}

func identitiesOf(ctx context.Context, tx pgx.Tx, tenant, email string) ([]PersonIdentity, error) {
	rows, err := tx.Query(ctx, `select kind, value from cp.person_identities where tenant_ref = $1 and email = $2`, tenant, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PersonIdentity
	for rows.Next() {
		var x PersonIdentity
		if err := rows.Scan(&x.Kind, &x.Value); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// DeletePerson removes a person and their identities.
func (s *Store) DeletePerson(ctx context.Context, tenant, email string) error {
	ct, err := s.db.Exec(ctx, `delete from cp.people where tenant_ref = $1 and email = $2`, tenant, email)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeletePersonIdentity unmaps one identity and returns whose it was.
func (s *Store) DeletePersonIdentity(ctx context.Context, tenant, kind, value string) (string, error) {
	var email string
	err := s.db.QueryRow(ctx, `delete from cp.person_identities where tenant_ref = $1 and kind = $2 and value = $3 returning email`,
		tenant, kind, value).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return email, err
}

// Sightings lists who effigentd saw on each (not revoked) machine since a
// day: one row per machine, OS user and git email, from the daily rollup.
func (s *Store) Sightings(ctx context.Context, tenant string, since time.Time) ([]spend.Sighting, error) {
	rows, err := s.db.Query(ctx, `select a.endpoint_id::text, e.hostname, coalesce(e.owner, ''), a.os_user, a.git_email,
		       array_agg(distinct a.agent order by a.agent), sum(a.events)::bigint, max(a.last_at)
		from cp.agent_activity_daily a join cp.endpoints e on e.id = a.endpoint_id and e.tenant_ref = a.tenant_ref
		where a.tenant_ref = $1 and a.day >= $2 and e.revoked_at is null
		group by 1, 2, 3, 4, 5
		order by 2, 4, 5`, tenant, spend.Day(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []spend.Sighting{}
	for rows.Next() {
		var x spend.Sighting
		if err := rows.Scan(&x.EndpointID, &x.Hostname, &x.Owner, &x.OSUser, &x.GitEmail, &x.Agents, &x.Events, &x.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// NormIdentity validates and normalises a mapping identity.
func NormIdentity(kind, value string) (string, string, error) {
	kind, value = strings.ToLower(strings.TrimSpace(kind)), strings.ToLower(strings.TrimSpace(value))
	if !spend.IsKind(kind) {
		return "", "", fmt.Errorf("kind must be one of %s", strings.Join(spend.Kinds, ", "))
	}
	if value == "" || len(value) > 254 || strings.ContainsAny(value, " \t\r\n") {
		return "", "", fmt.Errorf("%s: a value without spaces, at most 254 characters", kind)
	}
	switch kind {
	case spend.KindGitEmail, spend.KindEmail:
		if !strings.Contains(value, "@") {
			return "", "", fmt.Errorf("%s: %q is not an email", kind, value)
		}
	case spend.KindHost, spend.KindGitHub, spend.KindAPIKey:
		if strings.Contains(value, "@") && kind != spend.KindAPIKey {
			return "", "", fmt.Errorf("%s: %q has an @", kind, value)
		}
	}
	return kind, value, nil
}

// SortIdentities orders identities as the console lists kinds.
func SortIdentities(ids []PersonIdentity) {
	rank := map[string]int{}
	for i, k := range spend.Kinds {
		rank[k] = i
	}
	sort.SliceStable(ids, func(i, j int) bool {
		if ids[i].Kind != ids[j].Kind {
			return rank[ids[i].Kind] < rank[ids[j].Kind]
		}
		return ids[i].Value < ids[j].Value
	})
}

func cmpStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
