// Package store is the control plane's Postgres layer.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

var ErrNotFound = errors.New("not found")

type Store struct{ db *pgxpool.Pool }

func Open(ctx context.Context, url string) (*Store, error) {
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(ctx); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() { s.db.Close() }

// Migrate applies embedded migrations once each, tracked in cp.schema_migrations.
func (s *Store) Migrate(ctx context.Context) error {
	// Only create the schema when it's missing: in production the control
	// plane's role owns schema cp but may not create schemas in the database,
	// and Postgres checks that permission even for "if not exists".
	var haveSchema bool
	if err := s.db.QueryRow(ctx, `select exists(select 1 from pg_namespace where nspname = 'cp')`).Scan(&haveSchema); err != nil {
		return err
	}
	if !haveSchema {
		if _, err := s.db.Exec(ctx, `create schema cp`); err != nil {
			return err
		}
	}
	if _, err := s.db.Exec(ctx, `create table if not exists cp.schema_migrations (name text primary key, applied_at timestamptz not null default now())`); err != nil {
		return err
	}
	ents, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, n := range names {
		var done bool
		if err := s.db.QueryRow(ctx, `select exists(select 1 from cp.schema_migrations where name=$1)`, n).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, _ := migrations.ReadFile("migrations/" + n)
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("migration %s: %w", n, err)
		}
		if _, err := tx.Exec(ctx, `insert into cp.schema_migrations (name) values ($1)`, n); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

func randomToken(prefix string) string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

func hash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// ---- enrollment ----

type EnrollmentToken struct {
	ID        string    `json:"id"`
	Token     string    `json:"token,omitempty"` // only returned at creation
	Label     string    `json:"label"`
	ExpiresAt time.Time `json:"expires_at"`
	MaxUses   int       `json:"max_uses"`
	Uses      int       `json:"uses"`
}

func (s *Store) CreateEnrollmentToken(ctx context.Context, tenant, label, by string, ttl time.Duration, maxUses int) (EnrollmentToken, error) {
	t := EnrollmentToken{Token: randomToken("eft_"), Label: label, ExpiresAt: time.Now().Add(ttl), MaxUses: maxUses}
	err := s.db.QueryRow(ctx, `insert into cp.enrollment_tokens (tenant_ref, token_hash, label, created_by, expires_at, max_uses)
		values ($1,$2,$3,$4,$5,$6) returning id`, tenant, hash(t.Token), label, by, t.ExpiresAt, maxUses).Scan(&t.ID)
	return t, err
}

type EndpointInfo struct {
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Version  string `json:"version"`
}

// Enroll consumes one use of an enrollment token and registers an endpoint.
// It returns the endpoint's id and its secret (shown once, stored hashed).
func (s *Store) Enroll(ctx context.Context, token string, info EndpointInfo) (id, secret, tenant string, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	var tokID string
	err = tx.QueryRow(ctx, `update cp.enrollment_tokens set uses = uses + 1
		where token_hash = $1 and uses < max_uses and expires_at > now()
		returning id, tenant_ref`, hash(token)).Scan(&tokID, &tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
		return
	}
	if err != nil {
		return
	}
	secret = randomToken("eps_")
	err = tx.QueryRow(ctx, `insert into cp.endpoints (tenant_ref, secret_hash, hostname, os, arch, version)
		values ($1,$2,$3,$4,$5,$6) returning id`, tenant, hash(secret), info.Hostname, info.OS, info.Arch, info.Version).Scan(&id)
	if err != nil {
		return
	}
	err = tx.Commit(ctx)
	return
}

type Endpoint struct {
	ID            string     `json:"id"`
	Tenant        string     `json:"-"`
	Hostname      string     `json:"hostname"`
	OS            string     `json:"os"`
	Arch          string     `json:"arch"`
	Version       string     `json:"version"`
	EnrolledAt    time.Time  `json:"enrolled_at"`
	LastSeen      *time.Time `json:"last_seen"`
	PolicyVersion int64      `json:"policy_version"`
	Revoked       bool       `json:"revoked"`
	Owner         string     `json:"owner"` // console user id or email; central rules scoped to users match it
	Teams         []string   `json:"teams"`
}

const endpointCols = `id, tenant_ref, hostname, os, arch, version, enrolled_at, last_seen, policy_version, revoked_at is not null, owner, teams`

func scanEndpoint(r pgx.Row) (Endpoint, error) {
	var e Endpoint
	err := r.Scan(&e.ID, &e.Tenant, &e.Hostname, &e.OS, &e.Arch, &e.Version, &e.EnrolledAt, &e.LastSeen, &e.PolicyVersion, &e.Revoked, &e.Owner, &e.Teams)
	return e, err
}

// AuthEndpoint resolves an endpoint by its secret; revoked endpoints fail.
func (s *Store) AuthEndpoint(ctx context.Context, secret string) (Endpoint, error) {
	e, err := scanEndpoint(s.db.QueryRow(ctx, `select `+endpointCols+` from cp.endpoints
		where secret_hash = $1 and revoked_at is null`, hash(secret)))
	if errors.Is(err, pgx.ErrNoRows) {
		return e, ErrNotFound
	}
	return e, err
}

func (s *Store) Heartbeat(ctx context.Context, id string, policyVersion int64) error {
	_, err := s.db.Exec(ctx, `update cp.endpoints set last_seen = now(), policy_version = $2 where id = $1`, id, policyVersion)
	return err
}

func (s *Store) ListEndpoints(ctx context.Context, tenant string) ([]Endpoint, error) {
	rows, err := s.db.Query(ctx, `select `+endpointCols+` from cp.endpoints where tenant_ref = $1 order by enrolled_at desc`, tenant)
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

func (s *Store) GetEndpoint(ctx context.Context, tenant, id string) (Endpoint, error) {
	e, err := scanEndpoint(s.db.QueryRow(ctx, `select `+endpointCols+` from cp.endpoints where tenant_ref = $1 and id = $2`, tenant, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return e, ErrNotFound
	}
	return e, err
}

// SetEndpointOwner records who uses a machine, for central rules scoped to
// users and teams.
func (s *Store) SetEndpointOwner(ctx context.Context, tenant, id, owner string, teams []string) (Endpoint, error) {
	if teams == nil {
		teams = []string{}
	}
	e, err := scanEndpoint(s.db.QueryRow(ctx, `update cp.endpoints set owner = $3, teams = $4
		where tenant_ref = $1 and id = $2 and revoked_at is null returning `+endpointCols, tenant, id, owner, teams))
	if errors.Is(err, pgx.ErrNoRows) {
		return e, ErrNotFound
	}
	return e, err
}

func (s *Store) RevokeEndpoint(ctx context.Context, tenant, id string) error {
	ct, err := s.db.Exec(ctx, `update cp.endpoints set revoked_at = now() where tenant_ref = $1 and id = $2 and revoked_at is null`, tenant, id)
	if err == nil && ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// ---- policy ----

type PolicyVersion struct {
	Version   int64     `json:"version"`
	Body      string    `json:"body,omitempty"`
	Comment   string    `json:"comment"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	// Source holds the central policies (JSON array) compiled onto Body per
	// machine; nil means Body is served to every endpoint as is.
	Source json.RawMessage `json:"policies,omitempty"`
}

// PutPolicy stores a new version (previous + 1) and returns it. at is the
// publish time; central policies are compiled against it (rule expiry), so it
// is stored exactly rather than taken from the database clock.
func (s *Store) PutPolicy(ctx context.Context, tenant, body string, source json.RawMessage, comment, by string, at time.Time) (int64, error) {
	var v int64
	err := s.db.QueryRow(ctx, `insert into cp.policy_versions (tenant_ref, version, body, source, comment, created_by, created_at)
		select $1, coalesce(max(version), 0) + 1, $2, $3, $4, $5, $6 from cp.policy_versions where tenant_ref = $1
		returning version`, tenant, body, source, comment, by, at).Scan(&v)
	return v, err
}

func (s *Store) LatestPolicy(ctx context.Context, tenant string) (PolicyVersion, error) {
	var p PolicyVersion
	err := s.db.QueryRow(ctx, `select version, body, source, comment, created_by, created_at from cp.policy_versions
		where tenant_ref = $1 order by version desc limit 1`, tenant).Scan(&p.Version, &p.Body, &p.Source, &p.Comment, &p.CreatedBy, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

func (s *Store) PolicyHistory(ctx context.Context, tenant string) ([]PolicyVersion, error) {
	rows, err := s.db.Query(ctx, `select version, comment, created_by, created_at from cp.policy_versions
		where tenant_ref = $1 order by version desc limit 100`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PolicyVersion{}
	for rows.Next() {
		var p PolicyVersion
		if err := rows.Scan(&p.Version, &p.Comment, &p.CreatedBy, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ---- events ----

type Event struct {
	ID         int64           `json:"id"`
	EndpointID string          `json:"endpoint_id"`
	Time       time.Time       `json:"time"`
	Type       string          `json:"type"`
	Severity   string          `json:"severity"`
	Agent      string          `json:"agent"`
	Body       json.RawMessage `json:"body"`
}

func (s *Store) InsertEvents(ctx context.Context, tenant, endpointID string, evs []Event) error {
	batch := &pgx.Batch{}
	for _, e := range evs {
		batch.Queue(`insert into cp.events (tenant_ref, endpoint_id, event_time, type, severity, agent, body)
			values ($1,$2,$3,$4,$5,$6,$7)`, tenant, endpointID, e.Time, e.Type, e.Severity, e.Agent, e.Body)
	}
	return s.db.SendBatch(ctx, batch).Close()
}

func (s *Store) ListEvents(ctx context.Context, tenant string, limit int, typ string) ([]Event, error) {
	rows, err := s.db.Query(ctx, `select id, endpoint_id, event_time, type, severity, agent, body from cp.events
		where tenant_ref = $1 and ($3 = '' or type = $3) order by event_time desc, id desc limit $2`, tenant, limit, typ)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.EndpointID, &e.Time, &e.Type, &e.Severity, &e.Agent, &e.Body); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LatestSources returns each tenant's newest policy version whose source
// mentions exceptions (the exception-expiry job republishes them).
func (s *Store) LatestSources(ctx context.Context) (map[string]PolicyVersion, error) {
	rows, err := s.db.Query(ctx, `select distinct on (tenant_ref) tenant_ref, version, body, source, comment, created_by, created_at
		from cp.policy_versions order by tenant_ref, version desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]PolicyVersion{}
	for rows.Next() {
		var t string
		var p PolicyVersion
		if err := rows.Scan(&t, &p.Version, &p.Body, &p.Source, &p.Comment, &p.CreatedBy, &p.CreatedAt); err != nil {
			return nil, err
		}
		if strings.Contains(string(p.Source), `"exceptions"`) {
			out[t] = p
		}
	}
	return out, rows.Err()
}
