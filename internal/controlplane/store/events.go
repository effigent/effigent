package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Agent events arrive in batches. Each batch is one row in cp.event_batches,
// chained per endpoint (migration 007): see IngestBatch, VerifyEvents and the
// retention functions below.

const eventGenesis = "genesis"

// IngestBatch stores one batch from an endpoint. clientBatchID makes it
// idempotent: a batch sent again (a retry, a replay from the endpoint's disk
// spool) is not stored twice, and the answer is the same.
func (s *Store) IngestBatch(ctx context.Context, tenant, endpointID, clientBatchID string, evs []Event) (accepted int, duplicate bool, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback(ctx)
	// one chain per endpoint: its batches are serialized, other endpoints aren't
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtext('cp.events:' || $1))`, endpointID); err != nil {
		return 0, false, err
	}
	var n int
	err = tx.QueryRow(ctx, `select count from cp.event_batches where endpoint_id = $1 and client_batch_id = $2`, endpointID, clientBatchID).Scan(&n)
	if err == nil {
		return n, true, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, err
	}
	prev := eventGenesis
	err = tx.QueryRow(ctx, `select hash from cp.event_batches where endpoint_id = $1 order by id desc limit 1`, endpointID).Scan(&prev)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, err
	}
	var batchID int64
	if err := tx.QueryRow(ctx, `select nextval('cp.event_batches_id_seq')`).Scan(&batchID); err != nil {
		return 0, false, err
	}
	if len(evs) > 0 {
		b := &pgx.Batch{}
		for _, e := range evs {
			b.Queue(`insert into cp.events (tenant_ref, endpoint_id, event_time, type, severity, agent, body, batch_id)
				values ($1,$2,$3,$4,$5,$6,$7,$8)`, tenant, endpointID, e.Time, e.Type, e.Severity, e.Agent, e.Body, batchID)
		}
		if err := tx.SendBatch(ctx, b).Close(); err != nil {
			return 0, false, err
		}
		// daily activity per machine, agent and person (Pricing Leaks, People)
		if _, err := tx.Exec(ctx, `insert into cp.agent_activity_daily as d
			(tenant_ref, endpoint_id, day, agent, os_user, git_email, model, events, first_at, last_at)
			select tenant_ref, endpoint_id, (event_time at time zone 'UTC')::date, left(agent, 120),
			       left(lower(coalesce(body->>'os_user', '')), 200), left(lower(coalesce(body->>'git_email', '')), 254),
			       left(coalesce(body->>'model', ''), 120), count(*), min(event_time), max(event_time)
			from cp.events where batch_id = $1 and agent <> '' and agent not like 'mcp:%'
			group by 1, 2, 3, 4, 5, 6, 7
			on conflict (tenant_ref, endpoint_id, day, agent, os_user, git_email, model) do update
			set events = d.events + excluded.events, first_at = least(d.first_at, excluded.first_at), last_at = greatest(d.last_at, excluded.last_at)`,
			batchID); err != nil {
			return 0, false, err
		}
	}
	// hashes are computed by Postgres from what it stored, the same way VerifyEvents recomputes them
	_, err = tx.Exec(ctx, `with s as (select min(id) f, max(id) l, count(*)::int n, cp.event_batch_content($1) c, now() r from cp.events where batch_id = $1)
		insert into cp.event_batches (id, tenant_ref, endpoint_id, client_batch_id, received_at, first_id, last_id, count, content_hash, prev_hash, hash)
		select $1, $2, $3, $4, s.r, s.f, s.l, s.n, s.c, $5, cp.event_batch_hash($2, $3, $4, s.r, s.f, s.l, s.n, s.c, $5) from s`,
		batchID, tenant, endpointID, clientBatchID, prev)
	if err != nil {
		return 0, false, err
	}
	return len(evs), false, tx.Commit(ctx)
}

// EventQuery filters and pages GET /api/v1/events. Zero values mean no filter.
type EventQuery struct {
	Limit    int
	Before   string   // cursor from the previous page: "<unix nanos>_<id>"
	Types    []string // event types
	Agent    string
	Endpoint string
	Q        string // every word must appear in the type, agent or body
	Since    time.Time
	Until    time.Time
}

func eventCursor(e Event) string { return fmt.Sprintf("%d_%d", e.Time.UnixNano(), e.ID) }

// QueryEvents returns one page, newest first, and the cursor for the next
// (older) one ("" when this is the last page).
func (s *Store) QueryEvents(ctx context.Context, tenant string, q EventQuery) ([]Event, string, error) {
	where := []string{"tenant_ref = $1"}
	args := []any{tenant}
	arg := func(v any) string { args = append(args, v); return fmt.Sprintf("$%d", len(args)) }
	if len(q.Types) > 0 {
		where = append(where, "type = any("+arg(q.Types)+"::text[])")
	}
	if q.Agent != "" {
		where = append(where, "agent = "+arg(q.Agent))
	}
	if q.Endpoint != "" {
		where = append(where, "endpoint_id::text = "+arg(q.Endpoint))
	}
	for _, w := range strings.Fields(q.Q) {
		where = append(where, "concat_ws(' ', type, agent, body::text) ilike '%' || "+arg(likeEscape(w))+" || '%'")
	}
	if !q.Since.IsZero() {
		where = append(where, "event_time >= "+arg(q.Since))
	}
	if !q.Until.IsZero() {
		where = append(where, "event_time < "+arg(q.Until))
	}
	if q.Before != "" {
		ns, id, ok := strings.Cut(q.Before, "_")
		n, err1 := strconv.ParseInt(ns, 10, 64)
		i, err2 := strconv.ParseInt(id, 10, 64)
		if !ok || err1 != nil || err2 != nil {
			return nil, "", errors.New("bad cursor")
		}
		where = append(where, "(event_time, id) < ("+arg(time.Unix(0, n).UTC())+", "+arg(i)+")")
	}
	rows, err := s.db.Query(ctx, `select id, endpoint_id, event_time, type, severity, agent, body from cp.events where `+
		strings.Join(where, " and ")+` order by event_time desc, id desc limit `+arg(q.Limit+1), args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.EndpointID, &e.Time, &e.Type, &e.Severity, &e.Agent, &e.Body); err != nil {
			return nil, "", err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > q.Limit {
		out = out[:q.Limit]
		next = eventCursor(out[len(out)-1])
	}
	return out, next, nil
}

// EventVerification is the result of recomputing every batch's hashes.
type EventVerification struct {
	OK              bool          `json:"ok"`
	Batches         int           `json:"batches"`
	Events          int64         `json:"events"`           // events whose content was rechecked
	ArchivedBatches int           `json:"archived_batches"` // in S3: chain checked, content not (it's in the archive)
	Endpoints       int           `json:"endpoints"`
	Legacy          int64         `json:"legacy_events"`    // stored before tamper protection: not covered
	Unbatched       int64         `json:"unbatched_events"` // after protection started but in no batch: added around the chain
	Problems        []EventBreach `json:"problems"`
	Since           *time.Time    `json:"protected_since,omitempty"`
}

type EventBreach struct {
	Batch    int64  `json:"batch"`
	Endpoint string `json:"endpoint_id"`
	Reason   string `json:"reason"`
}

// VerifyEvents recomputes the tenant's batch chains: links, batch hashes, and
// the content of every batch still in the database.
func (s *Store) VerifyEvents(ctx context.Context, tenant string) (EventVerification, error) {
	v := EventVerification{Problems: []EventBreach{}}
	rows, err := s.db.Query(ctx, `select b.id, b.endpoint_id::text, b.prev_hash, b.hash, b.count, b.archived_at is not null,
			cp.event_batch_hash(b.tenant_ref, b.endpoint_id, b.client_batch_id, b.received_at, b.first_id, b.last_id, b.count, b.content_hash, b.prev_hash) = b.hash,
			case when b.archived_at is null then cp.event_batch_content(b.id) = b.content_hash else true end
		from cp.event_batches b where b.tenant_ref = $1 order by b.endpoint_id, b.id`, tenant)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	lastEP, prev := "", ""
	for rows.Next() {
		var (
			id                          int64
			ep, prevHash, hash          string
			n                           int
			archived, hashOK, contentOK bool
		)
		if err := rows.Scan(&id, &ep, &prevHash, &hash, &n, &archived, &hashOK, &contentOK); err != nil {
			return v, err
		}
		if ep != lastEP {
			lastEP, prev = ep, eventGenesis
			v.Endpoints++
		}
		v.Batches++
		switch {
		case prevHash != prev:
			v.Problems = append(v.Problems, EventBreach{id, ep, "does not link to the batch before it (a batch was removed or reordered)"})
		case !hashOK:
			v.Problems = append(v.Problems, EventBreach{id, ep, "batch record was modified"})
		case !contentOK:
			v.Problems = append(v.Problems, EventBreach{id, ep, "events in this batch were modified, added or removed"})
		}
		if archived {
			v.ArchivedBatches++
		} else {
			v.Events += int64(n)
		}
		prev = hash
	}
	if err := rows.Err(); err != nil {
		return v, err
	}
	var since *time.Time
	if err := s.db.QueryRow(ctx, `select applied_at from cp.schema_migrations where name = '007_event_integrity.sql'`).Scan(&since); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return v, err
	}
	v.Since = since
	if since != nil {
		if err := s.db.QueryRow(ctx, `select count(*) filter (where ingested_at < $2), count(*) filter (where ingested_at >= $2)
			from cp.events where tenant_ref = $1 and batch_id is null`, tenant, *since).Scan(&v.Legacy, &v.Unbatched); err != nil {
			return v, err
		}
		if v.Unbatched > 0 {
			v.Problems = append(v.Problems, EventBreach{0, "", fmt.Sprintf("%d events were added outside any batch", v.Unbatched)})
		}
	}
	v.OK = len(v.Problems) == 0
	return v, nil
}

// ---- retention ----

// ArchiveDay is one tenant's events received on one UTC day.
type ArchiveDay struct {
	Tenant string
	Day    time.Time // 00:00 UTC
}

// DueArchiveDays lists the tenant-days whose events were all received before
// cutoff and are still in the database, oldest first.
func (s *Store) DueArchiveDays(ctx context.Context, cutoff time.Time, limit int) ([]ArchiveDay, error) {
	day := func(col string) string { return `date_trunc('day', ` + col + ` at time zone 'UTC')` }
	rows, err := s.db.Query(ctx, `select tenant_ref, d from (
			select tenant_ref, `+day("received_at")+` d from cp.event_batches where archived_at is null and received_at < $1
			union
			select tenant_ref, `+day("ingested_at")+` d from cp.events where batch_id is null and ingested_at < $1
		) x where d + interval '1 day' <= $1 at time zone 'UTC' order by d, tenant_ref limit $2`, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ArchiveDay
	for rows.Next() {
		var a ArchiveDay
		var d time.Time
		if err := rows.Scan(&a.Tenant, &d); err != nil {
			return nil, err
		}
		a.Day = time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)
		out = append(out, a)
	}
	return out, rows.Err()
}

// ArchiveContents is what WriteArchiveDay put in the archive.
type ArchiveContents struct {
	BatchIDs []int64
	Events   int64
	Legacy   int64
}

// WriteArchiveDay streams one tenant-day as JSON lines to w: for each batch a
// {"batch": …} line (with its hashes) followed by its events, then the events
// from before tamper protection ({"legacy": true}).
func (s *Store) WriteArchiveDay(ctx context.Context, a ArchiveDay, w io.Writer) (ArchiveContents, error) {
	var c ArchiveContents
	from, to := a.Day, a.Day.Add(24*time.Hour)
	enc := json.NewEncoder(w)
	type batchRow struct {
		ID            int64     `json:"id"`
		EndpointID    string    `json:"endpoint_id"`
		ClientBatchID string    `json:"client_batch_id"`
		ReceivedAt    time.Time `json:"received_at"`
		FirstID       *int64    `json:"first_id"`
		LastID        *int64    `json:"last_id"`
		Count         int       `json:"count"`
		ContentHash   string    `json:"content_hash"`
		PrevHash      string    `json:"prev_hash"`
		Hash          string    `json:"hash"`
	}
	rows, err := s.db.Query(ctx, `select id, endpoint_id::text, client_batch_id, received_at, first_id, last_id, count, content_hash, prev_hash, hash
		from cp.event_batches where tenant_ref = $1 and archived_at is null and received_at >= $2 and received_at < $3 order by id`, a.Tenant, from, to)
	if err != nil {
		return c, err
	}
	var batches []batchRow
	for rows.Next() {
		var b batchRow
		if err := rows.Scan(&b.ID, &b.EndpointID, &b.ClientBatchID, &b.ReceivedAt, &b.FirstID, &b.LastID, &b.Count, &b.ContentHash, &b.PrevHash, &b.Hash); err != nil {
			rows.Close()
			return c, err
		}
		batches = append(batches, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return c, err
	}
	writeEvents := func(legacy bool, query string, args ...any) (int64, error) {
		rows, err := s.db.Query(ctx, `select id, endpoint_id::text, event_time, ingested_at, type, severity, agent, body, cp.event_text(e) from cp.events e where `+query+` order by id`, args...)
		if err != nil {
			return 0, err
		}
		defer rows.Close()
		var n int64
		for rows.Next() {
			var ev struct {
				ID         int64           `json:"id"`
				EndpointID string          `json:"endpoint_id"`
				Time       time.Time       `json:"time"`
				IngestedAt time.Time       `json:"ingested_at"`
				Type       string          `json:"type"`
				Severity   string          `json:"severity"`
				Agent      string          `json:"agent"`
				Body       json.RawMessage `json:"body"`
				Hashed     string          `json:"hashed"` // the exact text the batch's content hash covers
				Legacy     bool            `json:"legacy,omitempty"`
			}
			if err := rows.Scan(&ev.ID, &ev.EndpointID, &ev.Time, &ev.IngestedAt, &ev.Type, &ev.Severity, &ev.Agent, &ev.Body, &ev.Hashed); err != nil {
				return n, err
			}
			ev.Legacy = legacy
			if err := enc.Encode(map[string]any{"event": ev}); err != nil {
				return n, err
			}
			n++
		}
		return n, rows.Err()
	}
	for _, b := range batches {
		if err := enc.Encode(map[string]any{"batch": b}); err != nil {
			return c, err
		}
		n, err := writeEvents(false, `batch_id = $1`, b.ID)
		if err != nil {
			return c, err
		}
		if n != int64(b.Count) {
			return c, fmt.Errorf("batch %d has %d events, its record says %d: run verify before archiving", b.ID, n, b.Count)
		}
		c.BatchIDs = append(c.BatchIDs, b.ID)
		c.Events += n
	}
	n, err := writeEvents(true, `tenant_ref = $1 and batch_id is null and ingested_at >= $2 and ingested_at < $3`, a.Tenant, from, to)
	if err != nil {
		return c, err
	}
	c.Legacy = n
	return c, nil
}

// CompleteArchiveDay removes an archived tenant-day from the database (the
// events; the batch records stay, marked archived with the object's key and
// sha256).
func (s *Store) CompleteArchiveDay(ctx context.Context, a ArchiveDay, c ArchiveContents, key, sha string, size int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `set local effigent.retention = 'on'`); err != nil {
		return err
	}
	if len(c.BatchIDs) > 0 {
		if _, err := tx.Exec(ctx, `delete from cp.events where batch_id = any($1)`, c.BatchIDs); err != nil {
			return err
		}
		t, err := tx.Exec(ctx, `update cp.event_batches set archived_at = now(), archive_key = $2, archive_sha256 = $3 where id = any($1) and archived_at is null`,
			c.BatchIDs, key, sha)
		if err != nil {
			return err
		}
		if t.RowsAffected() != int64(len(c.BatchIDs)) {
			return errors.New("batches changed while archiving")
		}
	}
	if c.Legacy > 0 {
		t, err := tx.Exec(ctx, `delete from cp.events where tenant_ref = $1 and batch_id is null and ingested_at >= $2 and ingested_at < $3`,
			a.Tenant, a.Day, a.Day.Add(24*time.Hour))
		if err != nil {
			return err
		}
		if t.RowsAffected() != c.Legacy {
			return errors.New("legacy events changed while archiving")
		}
	}
	if _, err := tx.Exec(ctx, `insert into cp.event_archives (tenant_ref, day, key, sha256, size, batches, events, legacy)
		values ($1, $2::date, $3, $4, $5, $6, $7, $8)
		on conflict (tenant_ref, day) do update set key = $3, sha256 = $4, size = $5, batches = cp.event_archives.batches + $6,
			events = cp.event_archives.events + $7, legacy = cp.event_archives.legacy + $8, archived_at = now()`,
		a.Tenant, a.Day, key, sha, size, len(c.BatchIDs), c.Events, c.Legacy); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// EventArchive is one archived tenant-day (one S3 object).
type EventArchive struct {
	Day        string    `json:"day"` // YYYY-MM-DD (UTC, by when the events were received)
	Key        string    `json:"key"`
	SHA256     string    `json:"sha256"`
	Size       int64     `json:"size"`
	Batches    int       `json:"batches"`
	Events     int64     `json:"events"`
	Legacy     int64     `json:"legacy_events"`
	ArchivedAt time.Time `json:"archived_at"`
}

// ListArchives lists a tenant's archived days, newest first.
func (s *Store) ListArchives(ctx context.Context, tenant string) ([]EventArchive, error) {
	rows, err := s.db.Query(ctx, `select to_char(day, 'YYYY-MM-DD'), key, sha256, size, batches, events, legacy, archived_at
		from cp.event_archives where tenant_ref = $1 order by day desc limit 2000`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EventArchive{}
	for rows.Next() {
		var a EventArchive
		if err := rows.Scan(&a.Day, &a.Key, &a.SHA256, &a.Size, &a.Batches, &a.Events, &a.Legacy, &a.ArchivedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ArchiveKeyOf returns the S3 key of one of the tenant's archived days.
func (s *Store) ArchiveKeyOf(ctx context.Context, tenant, day string) (string, error) {
	var key string
	err := s.db.QueryRow(ctx, `select key from cp.event_archives where tenant_ref = $1 and day = $2::date`, tenant, day).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return key, err
}

// RetentionLock holds the cluster-wide retention lock until release is
// called; ok is false when another control plane instance holds it.
func (s *Store) RetentionLock(ctx context.Context) (release func(), ok bool, err error) {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	if err := conn.QueryRow(ctx, `select pg_try_advisory_lock(hashtext('cp.events.retention'))`).Scan(&ok); err != nil || !ok {
		conn.Release()
		return nil, false, err
	}
	return func() {
		_, _ = conn.Exec(context.Background(), `select pg_advisory_unlock(hashtext('cp.events.retention'))`)
		conn.Release()
	}, true, nil
}
