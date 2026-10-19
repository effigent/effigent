package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Pricing Leaks history and alerts (migration 011): each tenant's report
// rolled up per day, every leak with when it was first and last seen, and
// which runaway leaks were announced.

// execer is the pool or a transaction.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// markSpendChanged flags a tenant's report for a fresh rollup (a sync, an
// import, new prices…).
func markSpendChanged(ctx context.Context, q execer, tenant string) error {
	_, err := q.Exec(ctx, `insert into cp.spend_rollups (tenant_ref, changed_at) values ($1, now())
		on conflict (tenant_ref) do update set changed_at = now()`, tenant)
	return err
}

// tryLock takes a session advisory lock (the RetentionLock pattern) until
// release is called; ok=false: someone else holds it.
func (s *Store) tryLock(ctx context.Context, key string) (release func(), ok bool, err error) {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	if err := conn.QueryRow(ctx, `select pg_try_advisory_lock(hashtext($1))`, key).Scan(&ok); err != nil || !ok {
		conn.Release()
		return nil, false, err
	}
	return func() {
		_, _ = conn.Exec(context.Background(), `select pg_advisory_unlock(hashtext($1))`, key)
		conn.Release()
	}, true, nil
}

// SpendRollupLock is held while a tenant's report is rolled up and its
// alerts sent.
func (s *Store) SpendRollupLock(ctx context.Context, tenant string) (release func(), ok bool, err error) {
	return s.tryLock(ctx, "cp.spend.rollup:"+tenant)
}

// DueSpendRollups lists tenants whose spend data changed since their last
// rollup, or that weren't rolled up in `every`.
func (s *Store) DueSpendRollups(ctx context.Context, every time.Duration, limit int) ([]string, error) {
	rows, err := s.db.Query(ctx, `select tenant_ref from cp.spend_rollups
		where rolled_at is null or rolled_at < changed_at or rolled_at < now() - make_interval(secs => $1)
		order by rolled_at nulls first limit $2`, every.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// FailSpendRollup records a failed rollup; it is tried again after `every`
// or when the data changes.
func (s *Store) FailSpendRollup(ctx context.Context, tenant, msg string) error {
	_, err := s.db.Exec(ctx, `insert into cp.spend_rollups (tenant_ref, rolled_at, last_error) values ($1, now(), $2)
		on conflict (tenant_ref) do update set rolled_at = now(), last_error = $2`, tenant, msg)
	return err
}

// RecordSpendReport stores the report as its day's rows and updates the leak
// log: leaks in the report are (re)opened and seen now, the others resolved.
// started is when the report's inputs were read: a change after it triggers
// another rollup.
func (s *Store) RecordSpendReport(ctx context.Context, tenant string, rep spend.Report, started time.Time) error {
	day := spend.Day(rep.GeneratedAt)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	b := &pgx.Batch{}
	b.Queue(`delete from cp.spend_report_daily where tenant_ref = $1 and day = $2`, tenant, day)
	for _, v := range rep.Vendors {
		b.Queue(`insert into cp.spend_report_daily (tenant_ref, day, vendor, seats, active_seats, seat_cents, usage_cents, monthly_cents, estimated, connected)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			tenant, day, v.Vendor, v.Seats, v.ActiveSeats, v.SeatCents, v.UsageCents, v.MonthlyCents, v.Estimated, v.Connected)
	}
	b.Queue(`delete from cp.spend_leaks_daily where tenant_ref = $1 and day = $2`, tenant, day)
	type agg struct{ n, save, risk int64 }
	byType := map[[2]string]*agg{}
	ids := make([]string, 0, len(rep.Leaks))
	for _, l := range rep.Leaks {
		k := [2]string{l.Type, l.Vendor}
		if byType[k] == nil {
			byType[k] = &agg{}
		}
		byType[k].n++
		byType[k].save += l.MonthlySavingsCents
		byType[k].risk += l.AtRiskCents
		ids = append(ids, l.ID)
		ev, _ := json.Marshal(l.Evidence)
		b.Queue(`insert into cp.spend_leaks (tenant_ref, leak_id, leak_type, vendor, person, name, title, evidence, confidence,
				savings_cents, at_risk_cents, first_seen_at, last_seen_at)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
			on conflict (tenant_ref, leak_id) do update set
			  leak_type = excluded.leak_type, vendor = excluded.vendor, person = excluded.person, name = excluded.name,
			  title = excluded.title, evidence = excluded.evidence, confidence = excluded.confidence,
			  savings_cents = excluded.savings_cents, at_risk_cents = excluded.at_risk_cents, last_seen_at = excluded.last_seen_at,
			  first_seen_at = case when cp.spend_leaks.resolved_at is null then cp.spend_leaks.first_seen_at else excluded.first_seen_at end,
			  notified_at = case when cp.spend_leaks.resolved_at is null then cp.spend_leaks.notified_at end,
			  notify_result = case when cp.spend_leaks.resolved_at is null then cp.spend_leaks.notify_result else '{}' end,
			  resolved_at = null`,
			tenant, l.ID, l.Type, l.Vendor, l.Person, clipS(l.Name, 200), clipS(l.Title, 300), ev, l.Confidence,
			l.MonthlySavingsCents, l.AtRiskCents, rep.GeneratedAt)
	}
	for k, a := range byType {
		b.Queue(`insert into cp.spend_leaks_daily (tenant_ref, day, leak_type, vendor, leaks, savings_cents, at_risk_cents)
			values ($1, $2, $3, $4, $5, $6, $7)`, tenant, day, k[0], k[1], a.n, a.save, a.risk)
	}
	b.Queue(`update cp.spend_leaks set resolved_at = $3 where tenant_ref = $1 and resolved_at is null and not (leak_id = any($2))`,
		tenant, ids, rep.GeneratedAt)
	b.Queue(`insert into cp.spend_rollups (tenant_ref, changed_at, rolled_at) values ($1, $2, $2)
		on conflict (tenant_ref) do update set rolled_at = $2, last_error = ''`, tenant, started)
	if err := tx.SendBatch(ctx, b).Close(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SpendLeak is one leak in the log.
type SpendLeak struct {
	ID           string            `json:"id"`
	Type         string            `json:"type"`
	Vendor       string            `json:"vendor"`
	Person       string            `json:"person"`
	Name         string            `json:"name,omitempty"`
	Title        string            `json:"title"`
	Evidence     []string          `json:"evidence"`
	Confidence   string            `json:"confidence"`
	SavingsCents int64             `json:"monthly_savings_cents"`
	AtRiskCents  int64             `json:"at_risk_cents"`
	FirstSeenAt  time.Time         `json:"first_seen_at"`
	LastSeenAt   time.Time         `json:"last_seen_at"`
	ResolvedAt   *time.Time        `json:"resolved_at,omitempty"`
	NotifiedAt   *time.Time        `json:"notified_at,omitempty"`
	NotifyResult map[string]string `json:"notify_result,omitempty"` // channel -> sent | error: … | off
}

const spendLeakCols = `leak_id, leak_type, vendor, person, name, title, evidence, confidence, savings_cents, at_risk_cents,
	first_seen_at, last_seen_at, resolved_at, notified_at, notify_result`

func scanSpendLeaks(rows pgx.Rows) ([]SpendLeak, error) {
	defer rows.Close()
	out := []SpendLeak{}
	for rows.Next() {
		var l SpendLeak
		var ev, res []byte
		if err := rows.Scan(&l.ID, &l.Type, &l.Vendor, &l.Person, &l.Name, &l.Title, &ev, &l.Confidence, &l.SavingsCents, &l.AtRiskCents,
			&l.FirstSeenAt, &l.LastSeenAt, &l.ResolvedAt, &l.NotifiedAt, &res); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(ev, &l.Evidence)
		_ = json.Unmarshal(res, &l.NotifyResult)
		if l.Evidence == nil {
			l.Evidence = []string{}
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ClaimSpendAlerts marks open leaks of the given types as announced and
// returns them: ones never announced in this episode, or announced more than
// `repeat` ago. The update is the claim, so with several control plane
// instances each leak is announced once.
func (s *Store) ClaimSpendAlerts(ctx context.Context, tenant string, types []string, repeat time.Duration) ([]SpendLeak, error) {
	rows, err := s.db.Query(ctx, `update cp.spend_leaks set notified_at = now(), notify_result = '{}'
		where tenant_ref = $1 and resolved_at is null and leak_type = any($2)
		  and (notified_at is null or notified_at < now() - make_interval(secs => $3))
		returning `+spendLeakCols, tenant, types, repeat.Seconds())
	if err != nil {
		return nil, err
	}
	return scanSpendLeaks(rows)
}

// SetSpendAlertResult records where an announcement went.
func (s *Store) SetSpendAlertResult(ctx context.Context, tenant, leakID string, result map[string]string) error {
	raw, _ := json.Marshal(result)
	_, err := s.db.Exec(ctx, `update cp.spend_leaks set notify_result = $3 where tenant_ref = $1 and leak_id = $2`, tenant, leakID, raw)
	return err
}

// SpendLeakLog lists logged leaks of the given types (all when empty), the
// most recently seen first.
func (s *Store) SpendLeakLog(ctx context.Context, tenant string, types []string, limit int) ([]SpendLeak, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(ctx, `select `+spendLeakCols+` from cp.spend_leaks
		where tenant_ref = $1 and (cardinality($2::text[]) = 0 or leak_type = any($2))
		order by last_seen_at desc, leak_id limit $3`, tenant, types, limit)
	if err != nil {
		return nil, err
	}
	return scanSpendLeaks(rows)
}

// OpenSpendLeaks is when each open leak was first seen.
func (s *Store) OpenSpendLeaks(ctx context.Context, tenant string) (map[string]time.Time, error) {
	rows, err := s.db.Query(ctx, `select leak_id, first_seen_at from cp.spend_leaks where tenant_ref = $1 and resolved_at is null`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var id string
		var at time.Time
		if err := rows.Scan(&id, &at); err != nil {
			return nil, err
		}
		out[id] = at
	}
	return out, rows.Err()
}

// SpendReportDay is one vendor's line of a day's report.
type SpendReportDay struct {
	Day          time.Time `json:"day"`
	Vendor       string    `json:"vendor"`
	Seats        int       `json:"seats"`
	ActiveSeats  int       `json:"active_seats"`
	SeatCents    int64     `json:"seat_cents"`
	UsageCents   int64     `json:"usage_cents"`
	MonthlyCents int64     `json:"monthly_cents"`
	Estimated    bool      `json:"estimated,omitempty"`
	Connected    bool      `json:"connected"`
}

// SpendLeakDay is a day's leaks of one type and vendor.
type SpendLeakDay struct {
	Day          time.Time `json:"day"`
	Type         string    `json:"type"`
	Vendor       string    `json:"vendor"`
	Leaks        int       `json:"leaks"`
	SavingsCents int64     `json:"savings_cents"`
	AtRiskCents  int64     `json:"at_risk_cents"`
}

// SpendHistory returns the rolled-up reports since a day.
func (s *Store) SpendHistory(ctx context.Context, tenant string, since time.Time) ([]SpendReportDay, []SpendLeakDay, error) {
	rows, err := s.db.Query(ctx, `select day, vendor, seats, active_seats, seat_cents, usage_cents, monthly_cents, estimated, connected
		from cp.spend_report_daily where tenant_ref = $1 and day >= $2 order by day, vendor`, tenant, spend.Day(since))
	if err != nil {
		return nil, nil, err
	}
	report, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (SpendReportDay, error) {
		var d SpendReportDay
		err := r.Scan(&d.Day, &d.Vendor, &d.Seats, &d.ActiveSeats, &d.SeatCents, &d.UsageCents, &d.MonthlyCents, &d.Estimated, &d.Connected)
		return d, err
	})
	if err != nil {
		return nil, nil, err
	}
	rows, err = s.db.Query(ctx, `select day, leak_type, vendor, leaks, savings_cents, at_risk_cents
		from cp.spend_leaks_daily where tenant_ref = $1 and day >= $2 order by day, leak_type, vendor`, tenant, spend.Day(since))
	if err != nil {
		return nil, nil, err
	}
	leaks, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (SpendLeakDay, error) {
		var d SpendLeakDay
		err := r.Scan(&d.Day, &d.Type, &d.Vendor, &d.Leaks, &d.SavingsCents, &d.AtRiskCents)
		return d, err
	})
	return report, leaks, err
}

// AgentActivity is effigentd's activity rollup per day, agent and machine
// since a day (summed over OS users, git emails and models).
func (s *Store) AgentActivity(ctx context.Context, tenant string, since time.Time) ([]spend.ActivityRow, error) {
	rows, err := s.db.Query(ctx, `select day, agent, endpoint_id::text, sum(events)::bigint from cp.agent_activity_daily
		where tenant_ref = $1 and day >= $2 group by 1, 2, 3`, tenant, spend.Day(since))
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (spend.ActivityRow, error) {
		var a spend.ActivityRow
		err := r.Scan(&a.Day, &a.Agent, &a.EndpointID, &a.Events)
		return a, err
	})
}
