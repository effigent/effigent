package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/jackc/pgx/v5"
)

// Pricing Leaks (migration 009): vendor connectors, the seats and daily usage
// they (or CSV imports) brought back, the tenant's people directory and price
// overrides, and what effigentd observed — see internal/controlplane/spend.

// SpendConnector is one vendor's admin API connection. SecretEnc is sealed
// by the server and never leaves it.
type SpendConnector struct {
	Tenant        string            `json:"-"`
	Vendor        string            `json:"vendor"`
	SecretEnc     string            `json:"-"`
	SecretHint    string            `json:"key_hint,omitempty"`
	Settings      map[string]string `json:"settings"`
	Enabled       bool              `json:"enabled"`
	SyncStatus    string            `json:"sync_status"` // '' | running | ok | error
	SyncStartedAt *time.Time        `json:"sync_started_at,omitempty"`
	LastSyncAt    *time.Time        `json:"last_sync_at,omitempty"`
	LastError     string            `json:"last_error,omitempty"`
	LastCounts    map[string]int    `json:"last_counts,omitempty"`
	UpdatedBy     string            `json:"updated_by,omitempty"`
	UpdatedAt     time.Time         `json:"updated_at"`
	NextPollAt    *time.Time        `json:"next_poll_at,omitempty"`
	Failures      int               `json:"failures,omitempty"` // failed polls in a row
}

// Configured reports whether the connector has a key.
func (c SpendConnector) Configured() bool { return c.SecretEnc != "" }

const spendConnCols = `tenant_ref, vendor, secret_enc, secret_hint, settings, enabled, sync_status, sync_started_at, last_sync_at, last_error, last_counts, updated_by, updated_at, next_poll_at, failures`

func scanSpendConn(r pgx.Row) (SpendConnector, error) {
	var c SpendConnector
	var settings, counts []byte
	err := r.Scan(&c.Tenant, &c.Vendor, &c.SecretEnc, &c.SecretHint, &settings, &c.Enabled, &c.SyncStatus, &c.SyncStartedAt,
		&c.LastSyncAt, &c.LastError, &counts, &c.UpdatedBy, &c.UpdatedAt, &c.NextPollAt, &c.Failures)
	if err != nil {
		return c, err
	}
	_ = json.Unmarshal(settings, &c.Settings)
	_ = json.Unmarshal(counts, &c.LastCounts)
	if c.Settings == nil {
		c.Settings = map[string]string{}
	}
	return c, nil
}

func (s *Store) ListSpendConnectors(ctx context.Context, tenant string) ([]SpendConnector, error) {
	rows, err := s.db.Query(ctx, `select `+spendConnCols+` from cp.spend_connectors where tenant_ref = $1 order by vendor`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SpendConnector{}
	for rows.Next() {
		c, err := scanSpendConn(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetSpendConnector(ctx context.Context, tenant, vendor string) (SpendConnector, error) {
	c, err := scanSpendConn(s.db.QueryRow(ctx, `select `+spendConnCols+` from cp.spend_connectors where tenant_ref = $1 and vendor = $2`, tenant, vendor))
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// PutSpendConnector creates or updates a connector. An empty secretEnc
// keeps the stored key.
func (s *Store) PutSpendConnector(ctx context.Context, tenant, vendor, secretEnc, hint string, settings map[string]string, by string) (SpendConnector, error) {
	if settings == nil {
		settings = map[string]string{}
	}
	raw, _ := json.Marshal(settings)
	return scanSpendConn(s.db.QueryRow(ctx, `insert into cp.spend_connectors (tenant_ref, vendor, secret_enc, secret_hint, settings, updated_by, updated_at)
		values ($1, $2, $3, $4, $5, $6, now())
		on conflict (tenant_ref, vendor) do update set
		  secret_enc = case when $3 = '' then cp.spend_connectors.secret_enc else $3 end,
		  secret_hint = case when $3 = '' then cp.spend_connectors.secret_hint else $4 end,
		  settings = $5, enabled = true, updated_by = $6, updated_at = now()
		returning `+spendConnCols, tenant, vendor, secretEnc, hint, raw, by))
}

// DeleteSpendConnector removes a connector and the data its syncs brought
// (CSV imports stay).
func (s *Store) DeleteSpendConnector(ctx context.Context, tenant, vendor string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ct, err := tx.Exec(ctx, `delete from cp.spend_connectors where tenant_ref = $1 and vendor = $2`, tenant, vendor)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx, `delete from cp.spend_seats where tenant_ref = $1 and vendor = $2 and source = 'api'`, tenant, vendor); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `delete from cp.spend_usage where tenant_ref = $1 and vendor = $2 and source = 'api'`, tenant, vendor); err != nil {
		return err
	}
	if err := markSpendChanged(ctx, tx, tenant); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Vendor poller (migration 010). Each connector has a next_poll_at; a poll
// runs under a session advisory lock for its tenant+vendor (the
// RetentionLock pattern), so several control plane instances, or a click
// on Sync during a scheduled poll, never pull the same vendor twice at once.

// SpendPollLock takes the poll lock for one connector. ok=false: another
// poll holds it.
func (s *Store) SpendPollLock(ctx context.Context, tenant, vendor string) (release func(), ok bool, err error) {
	return s.tryLock(ctx, "cp.spend.poll:"+tenant+"/"+vendor)
}

// DueSpendPolls lists connectors (every tenant) whose next poll is due,
// oldest first.
func (s *Store) DueSpendPolls(ctx context.Context, limit int) ([]SpendConnector, error) {
	rows, err := s.db.Query(ctx, `select `+spendConnCols+` from cp.spend_connectors
		where secret_enc <> '' and enabled and coalesce(next_poll_at, 'epoch') <= now()
		order by coalesce(next_poll_at, 'epoch') limit $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpendConnector
	for rows.Next() {
		c, err := scanSpendConn(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// StartSpendSync marks a connector's poll as running (call it holding the
// poll lock) and returns the connector as it is now; ErrNotFound when it
// has no key, is disabled or (onlyIfDue) isn't due any more.
func (s *Store) StartSpendSync(ctx context.Context, tenant, vendor string, onlyIfDue bool) (SpendConnector, error) {
	c, err := scanSpendConn(s.db.QueryRow(ctx, `update cp.spend_connectors set sync_status = 'running', sync_started_at = now()
		where tenant_ref = $1 and vendor = $2 and secret_enc <> '' and enabled
		  and (not $3 or coalesce(next_poll_at, 'epoch') <= now())
		returning `+spendConnCols, tenant, vendor, onlyIfDue))
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// SpendRetryAfter is the wait after the nth failure in a row: 15 min
// doubling, never longer than the regular interval.
func SpendRetryAfter(failures int, every time.Duration) time.Duration {
	d := 15 * time.Minute
	for i := 1; i < failures && d < every; i++ {
		d *= 2
	}
	return min(d, every)
}

// FailSpendSync records a failed poll and when to retry; the data from the
// last good one stays.
func (s *Store) FailSpendSync(ctx context.Context, tenant, vendor, msg string, every time.Duration) error {
	var failures int
	if err := s.db.QueryRow(ctx, `select failures + 1 from cp.spend_connectors where tenant_ref = $1 and vendor = $2`, tenant, vendor).Scan(&failures); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // deleted while polling
		}
		return err
	}
	_, err := s.db.Exec(ctx, `update cp.spend_connectors set sync_status = 'error', last_error = $3, failures = $4,
		next_poll_at = now() + make_interval(secs => $5) where tenant_ref = $1 and vendor = $2`,
		tenant, vendor, msg, failures, SpendRetryAfter(failures, every).Seconds())
	return err
}

// FinishSpendSync replaces the vendor's API seats, and its API usage for
// the synced days, with what the poll brought back, and schedules the next.
func (s *Store) FinishSpendSync(ctx context.Context, tenant, vendor string, from, to time.Time, p spend.Pull, every time.Duration) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := replaceSeats(ctx, tx, tenant, vendor, "api", p.Seats); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `delete from cp.spend_usage where tenant_ref = $1 and vendor = $2 and source = 'api' and day >= $3 and day <= $4`,
		tenant, vendor, spend.Day(from), spend.Day(to)); err != nil {
		return err
	}
	if err := upsertUsage(ctx, tx, tenant, vendor, "api", p.Usage); err != nil {
		return err
	}
	counts, _ := json.Marshal(map[string]int{"seats": len(p.Seats), "usage_rows": len(p.Usage)})
	errMsg := strings.Join(p.Notes, "; ")
	if _, err := tx.Exec(ctx, `update cp.spend_connectors set sync_status = 'ok', last_sync_at = now(), last_error = $3, last_counts = $4,
		failures = 0, next_poll_at = now() + make_interval(secs => $5)
		where tenant_ref = $1 and vendor = $2`, tenant, vendor, errMsg, counts, every.Seconds()); err != nil {
		return err
	}
	if err := markSpendChanged(ctx, tx, tenant); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ImportSpendCSV stores a CSV import: seats replace the vendor's previous
// CSV seats; usage rows replace the same days.
func (s *Store) ImportSpendCSV(ctx context.Context, tenant, vendor string, r spend.CSVResult) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if len(r.Seats) > 0 {
		if err := replaceSeats(ctx, tx, tenant, vendor, "csv", r.Seats); err != nil {
			return err
		}
	}
	if err := upsertUsage(ctx, tx, tenant, vendor, "csv", r.Usage); err != nil {
		return err
	}
	if err := markSpendChanged(ctx, tx, tenant); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ClearSpendCSV forgets a vendor's CSV imports.
func (s *Store) ClearSpendCSV(ctx context.Context, tenant, vendor string) error {
	if _, err := s.db.Exec(ctx, `delete from cp.spend_seats where tenant_ref = $1 and vendor = $2 and source = 'csv'`, tenant, vendor); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `delete from cp.spend_usage where tenant_ref = $1 and vendor = $2 and source = 'csv'`, tenant, vendor); err != nil {
		return err
	}
	return markSpendChanged(ctx, s.db, tenant)
}

func replaceSeats(ctx context.Context, tx pgx.Tx, tenant, vendor, source string, seats []spend.Seat) error {
	if _, err := tx.Exec(ctx, `delete from cp.spend_seats where tenant_ref = $1 and vendor = $2 and source = $3`, tenant, vendor, source); err != nil {
		return err
	}
	seen := map[string]bool{}
	var rows [][]any
	for _, x := range seats {
		id := strings.ToLower(strings.TrimSpace(x.Identity))
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		rows = append(rows, []any{tenant, vendor, id, source, clipS(x.Name, 200), clipS(x.Plan, 60), x.PriceCents, x.AssignedAt, x.LastActivity})
	}
	_, err := tx.CopyFrom(ctx, pgx.Identifier{"cp", "spend_seats"},
		[]string{"tenant_ref", "vendor", "identity", "source", "name", "plan", "price_cents", "assigned_at", "last_activity_at"}, pgx.CopyFromRows(rows))
	return err
}

func upsertUsage(ctx context.Context, tx pgx.Tx, tenant, vendor, source string, usage []spend.UsageDay) error {
	if len(usage) == 0 {
		return nil
	}
	b := &pgx.Batch{}
	for _, u := range usage {
		b.Queue(`insert into cp.spend_usage (tenant_ref, vendor, day, identity, source, cost_cents, requests, tokens, estimated)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			on conflict (tenant_ref, vendor, source, day, identity) do update set
			  cost_cents = excluded.cost_cents, requests = excluded.requests, tokens = excluded.tokens, estimated = excluded.estimated, synced_at = now()`,
			tenant, vendor, spend.Day(u.Day), strings.ToLower(strings.TrimSpace(u.Identity)), source, u.CostCents, u.Requests, u.Tokens, u.Estimated)
	}
	return tx.SendBatch(ctx, b).Close()
}

func clipS(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// SpendData returns the tenant's seats and its usage since a day.
func (s *Store) SpendData(ctx context.Context, tenant string, since time.Time) ([]spend.Seat, []spend.UsageDay, error) {
	seats := []spend.Seat{}
	rows, err := s.db.Query(ctx, `select vendor, identity, source, name, plan, price_cents, assigned_at, last_activity_at
		from cp.spend_seats where tenant_ref = $1 order by vendor, identity, source`, tenant)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var x spend.Seat
		if err := rows.Scan(&x.Vendor, &x.Identity, &x.Source, &x.Name, &x.Plan, &x.PriceCents, &x.AssignedAt, &x.LastActivity); err != nil {
			rows.Close()
			return nil, nil, err
		}
		seats = append(seats, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	usage := []spend.UsageDay{}
	// API rows win over CSV rows for the same vendor, day and person
	rows, err = s.db.Query(ctx, `select distinct on (vendor, day, identity) vendor, day, identity, source, cost_cents, requests, tokens, estimated
		from cp.spend_usage where tenant_ref = $1 and day >= $2
		order by vendor, day, identity, (source = 'api') desc`, tenant, spend.Day(since))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var u spend.UsageDay
		if err := rows.Scan(&u.Vendor, &u.Day, &u.Identity, &u.Source, &u.CostCents, &u.Requests, &u.Tokens, &u.Estimated); err != nil {
			return nil, nil, err
		}
		u.Day = spend.Day(u.Day)
		usage = append(usage, u)
	}
	return seats, usage, rows.Err()
}

// SpendObservations is effigentd's side: every machine that isn't revoked
// (owner, hostname, OS users from its approval requests) and, per machine,
// agent and day, how many events it reported since a day.
func (s *Store) SpendObservations(ctx context.Context, tenant string, since time.Time) ([]spend.Machine, []spend.Observation, error) {
	eps, err := s.ListEndpoints(ctx, tenant)
	if err != nil {
		return nil, nil, err
	}
	osUsers := map[string][]string{}
	rows, err := s.db.Query(ctx, `select distinct endpoint_id::text, os_user from cp.approvals
		where tenant_ref = $1 and os_user <> '' and requested_at >= $2 order by 1, 2`, tenant, since)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var id, u string
		if err := rows.Scan(&id, &u); err != nil {
			rows.Close()
			return nil, nil, err
		}
		osUsers[id] = append(osUsers[id], u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	byID := map[string]spend.Machine{}
	machines := []spend.Machine{}
	for _, e := range eps {
		if e.Revoked {
			continue
		}
		m := spend.Machine{ID: e.ID, Hostname: e.Hostname, Owner: e.Owner, OSUsers: osUsers[e.ID], LastSeen: e.LastSeen}
		byID[e.ID] = m
		machines = append(machines, m)
	}
	// the daily rollup kept at ingest (migration 010), not a scan of cp.events
	rows, err = s.db.Query(ctx, `select endpoint_id::text, agent, day, os_user, git_email, sum(events)::bigint
		from cp.agent_activity_daily where tenant_ref = $1 and day >= $2
		group by 1, 2, 3, 4, 5`, tenant, spend.Day(since))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	obs := []spend.Observation{}
	for rows.Next() {
		var o spend.Observation
		if err := rows.Scan(&o.EndpointID, &o.Agent, &o.Day, &o.OSUser, &o.GitEmail, &o.Events); err != nil {
			return nil, nil, err
		}
		m, ok := byID[o.EndpointID]
		if !ok {
			continue // revoked machine
		}
		o.Day, o.Hostname, o.Owner, o.OSUsers = spend.Day(o.Day), m.Hostname, m.Owner, m.OSUsers
		obs = append(obs, o)
	}
	return machines, obs, rows.Err()
}

// SpendSettings is the tenant's price overrides and alert settings (people
// live in cp.people since migration 010).
type SpendSettings struct {
	Prices    spend.Prices `json:"prices"`
	Alerts    SpendAlerts  `json:"alerts"`
	UpdatedBy string       `json:"updated_by,omitempty"`
	UpdatedAt *time.Time   `json:"updated_at,omitempty"`
}

// SpendAlerts: runaway cost alerts (on unless turned off) and who gets them
// by email (empty: the approval notification recipients).
type SpendAlerts struct {
	RunawayCost *bool    `json:"runaway_cost,omitempty"`
	Emails      []string `json:"emails"`
}

// RunawayOn reports whether runaway cost alerts are on.
func (a SpendAlerts) RunawayOn() bool { return a.RunawayCost == nil || *a.RunawayCost }

func (s *Store) GetSpendSettings(ctx context.Context, tenant string) (SpendSettings, error) {
	var c SpendSettings
	var raw []byte
	var by string
	var at time.Time
	err := s.db.QueryRow(ctx, `select config, updated_by, updated_at from cp.spend_settings where tenant_ref = $1`, tenant).Scan(&raw, &by, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return SpendSettings{Prices: spend.Prices{Seat: map[string]int64{}, Personal: map[string]int64{}}, Alerts: SpendAlerts{Emails: []string{}}}, nil
	} else if err != nil {
		return c, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	if c.Prices.Seat == nil {
		c.Prices.Seat = map[string]int64{}
	}
	if c.Prices.Personal == nil {
		c.Prices.Personal = map[string]int64{}
	}
	if c.Alerts.Emails == nil {
		c.Alerts.Emails = []string{}
	}
	c.UpdatedBy, c.UpdatedAt = by, &at
	return c, nil
}

func (s *Store) PutSpendSettings(ctx context.Context, tenant, by string, c SpendSettings) error {
	c.UpdatedBy, c.UpdatedAt = "", nil
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	if _, err = s.db.Exec(ctx, `insert into cp.spend_settings (tenant_ref, config, updated_by, updated_at) values ($1, $2, $3, now())
		on conflict (tenant_ref) do update set config = $2, updated_by = $3, updated_at = now()`, tenant, raw, by); err != nil {
		return err
	}
	return markSpendChanged(ctx, s.db, tenant)
}
