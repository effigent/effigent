package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ReportSchedule is a tenant's posture report email (migration 017).
type ReportSchedule struct {
	Enabled    bool            `json:"enabled"`
	Cadence    string          `json:"cadence"` // weekly | monthly
	Emails     []string        `json:"emails"`  // empty: the notification emails
	NextAt     *time.Time      `json:"next_at"`
	LastSentAt *time.Time      `json:"last_sent_at"`
	LastResult json.RawMessage `json:"last_result"`
	UpdatedBy  string          `json:"updated_by,omitempty"`
	UpdatedAt  *time.Time      `json:"updated_at,omitempty"`
}

// nextReportSQL is the next send time after now for a cadence: Mondays
// 08:00 UTC (weekly), the 1st of the month 08:00 UTC (monthly).
const nextReportSQL = `(case $C when 'monthly' then date_trunc('month', now() at time zone 'UTC') + interval '1 month 8 hours'
	else date_trunc('week', now() at time zone 'UTC') + interval '1 week 8 hours' end) at time zone 'UTC'`

func nextReport(cadence string) string { return strings.ReplaceAll(nextReportSQL, "$C", cadence) }

func (s *Store) GetReportSchedule(ctx context.Context, tenant string) (ReportSchedule, error) {
	r := ReportSchedule{Cadence: "weekly", Emails: []string{}}
	var at time.Time
	err := s.db.QueryRow(ctx, `select enabled, cadence, emails, next_at, last_sent_at, last_result, updated_by, updated_at
		from cp.report_schedules where tenant_ref = $1`, tenant).Scan(&r.Enabled, &r.Cadence, &r.Emails, &r.NextAt, &r.LastSentAt, &r.LastResult, &r.UpdatedBy, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, nil
	}
	if err == nil {
		r.UpdatedAt = &at
	}
	return r, err
}

// PutReportSchedule saves the schedule. Turning it on or changing the
// cadence schedules the next send at the cadence's next boundary.
func (s *Store) PutReportSchedule(ctx context.Context, tenant string, r ReportSchedule, by string) (ReportSchedule, error) {
	_, err := s.db.Exec(ctx, `insert into cp.report_schedules as s (tenant_ref, enabled, cadence, emails, next_at, updated_by, updated_at)
		values ($1, $2, $3, $4, case when $2 then `+nextReport("$3::text")+` end, $5, now())
		on conflict (tenant_ref) do update set enabled = $2, cadence = $3, emails = $4, updated_by = $5, updated_at = now(),
			next_at = case when not $2 then null
			               when s.enabled and s.cadence = $3 and s.next_at is not null then s.next_at
			               else `+nextReport("$3::text")+` end`,
		tenant, r.Enabled, r.Cadence, r.Emails, by)
	if err != nil {
		return r, err
	}
	return s.GetReportSchedule(ctx, tenant)
}

// DueReport is a schedule whose send this instance claimed.
type DueReport struct {
	Tenant  string
	Cadence string
	Emails  []string
}

// ClaimDueReports moves every due schedule's next_at to its next boundary
// and returns them: each send is claimed by exactly one instance (the row
// lock + skip locked, and the moved next_at for anyone after).
func (s *Store) ClaimDueReports(ctx context.Context, limit int) ([]DueReport, error) {
	rows, err := s.db.Query(ctx, `update cp.report_schedules s set next_at = `+nextReport("s.cadence")+`, last_sent_at = now()
		where s.tenant_ref in (select tenant_ref from cp.report_schedules where enabled and next_at <= now()
			order by next_at limit $1 for update skip locked)
		returning s.tenant_ref, s.cadence, s.emails`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (DueReport, error) {
		var d DueReport
		err := r.Scan(&d.Tenant, &d.Cadence, &d.Emails)
		return d, err
	})
}

// SetReportResult records where the last send went.
func (s *Store) SetReportResult(ctx context.Context, tenant string, res map[string]string) error {
	b, _ := json.Marshal(res)
	_, err := s.db.Exec(ctx, `update cp.report_schedules set last_result = $2 where tenant_ref = $1`, tenant, b)
	return err
}
