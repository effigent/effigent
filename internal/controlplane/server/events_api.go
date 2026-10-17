package server

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
)

// Agent events: the paged API, tamper verification, and retention — events
// older than RetentionDays (at least 90) move to S3 (one gzip'd JSON-lines
// object per tenant-day) and leave the database. Without an archive bucket
// nothing is ever deleted.

// MinRetentionDays is the floor; the database's delete guard enforces it too.
const MinRetentionDays = 90

// Archiver stores archived tenant-days (archive.S3 in production).
type Archiver interface {
	// Put stores r at key and returns the stored size as the store reports it.
	Put(ctx context.Context, key string, r io.Reader) (int64, error)
	PresignGet(ctx context.Context, key, filename string, ttl time.Duration) (string, error)
}

func (s *Server) retentionDays() int { return max(s.RetentionDays, MinRetentionDays) }

// listEvents returns the newest events (?limit, ?type). With ?paged=1 it
// returns one page {events, next_before} and also takes ?before (cursor),
// comma-separated ?type, ?agent, ?endpoint, ?q (words), ?since and ?until
// (RFC 3339).
func (s *Server) listEvents(w http.ResponseWriter, r *http.Request, p Principal) {
	qs := r.URL.Query()
	limit, _ := strconv.Atoi(qs.Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if qs.Get("paged") != "1" {
		evs, err := s.Store.ListEvents(r.Context(), p.Tenant, limit, qs.Get("type"))
		if err != nil {
			s.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, evs)
		return
	}
	q := store.EventQuery{Limit: limit, Before: qs.Get("before"), Types: splitList(qs.Get("type")), Agent: qs.Get("agent"),
		Endpoint: qs.Get("endpoint"), Q: clip(qs.Get("q"), 200)}
	for name, t := range map[string]*time.Time{"since": &q.Since, "until": &q.Until} {
		if v := qs.Get(name); v != "" {
			var err error
			if *t, err = time.Parse(time.RFC3339, v); err != nil {
				writeErr(w, http.StatusBadRequest, name+" must be an RFC 3339 time")
				return
			}
		}
	}
	evs, next, err := s.Store.QueryEvents(r.Context(), p.Tenant, q)
	if err != nil {
		if err.Error() == "bad cursor" {
			writeErr(w, http.StatusBadRequest, "bad cursor")
			return
		}
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": evs, "next_before": next, "retention_days": s.retentionDays()})
}

func (s *Server) verifyEvents(w http.ResponseWriter, r *http.Request, p Principal) {
	v, err := s.Store.VerifyEvents(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) listEventArchives(w http.ResponseWriter, r *http.Request, p Principal) {
	as, err := s.Store.ListArchives(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"retention_days": s.retentionDays(), "archive_enabled": s.Archive != nil, "archives": as})
}

// eventArchiveLink returns a 10-minute download link for one archived day.
func (s *Server) eventArchiveLink(w http.ResponseWriter, r *http.Request, p Principal) {
	day := r.PathValue("day")
	if _, err := time.Parse("2006-01-02", day); err != nil {
		writeErr(w, http.StatusBadRequest, "day must be YYYY-MM-DD")
		return
	}
	if s.Archive == nil {
		writeErr(w, http.StatusServiceUnavailable, "event archiving is not set up on this control plane")
		return
	}
	key, err := s.Store.ArchiveKeyOf(r.Context(), p.Tenant, day)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no archive for that day")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	u, err := s.Archive.PresignGet(r.Context(), key, "effigent-events-"+day+".jsonl.gz", 10*time.Minute)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "events.archive.download", day, map[string]any{"key": key})
	writeJSON(w, http.StatusOK, map[string]any{"url": u, "expires_in": 600})
}

// ---- retention ----

func archiveKey(a store.ArchiveDay) string {
	return fmt.Sprintf("events/%s/%s.jsonl.gz", strings.NewReplacer("/", "_", "..", "_").Replace(a.Tenant), a.Day.Format("2006/01/02"))
}

// runRetention archives every tenant-day older than the retention period,
// oldest first. One control plane instance at a time; fails closed: no
// archiver, no deletes.
func (s *Server) runRetention(ctx context.Context) {
	if s.Archive == nil {
		return
	}
	release, ok, err := s.Store.RetentionLock(ctx)
	if err != nil || !ok {
		if err != nil {
			s.Logf("event retention: %v", err)
		}
		return
	}
	defer release()
	cutoff := time.Now().Add(-time.Duration(s.retentionDays()) * 24 * time.Hour)
	days, err := s.Store.DueArchiveDays(ctx, cutoff, 100)
	if err != nil {
		s.Logf("event retention: %v", err)
		return
	}
	for _, d := range days {
		if err := s.archiveDay(ctx, d); err != nil {
			s.Logf("event retention %s %s: %v", d.Tenant, d.Day.Format("2006-01-02"), err)
			return // try again next run; nothing was deleted
		}
	}
}

func (s *Server) archiveDay(ctx context.Context, d store.ArchiveDay) error {
	key := archiveKey(d)
	pr, pw := io.Pipe()
	h := sha256.New()
	var written int64
	var contents store.ArchiveContents
	done := make(chan struct{})
	go func() {
		defer close(done)
		cw := &countWriter{w: io.MultiWriter(pw, h), n: &written}
		gz := gzip.NewWriter(cw)
		c, err := s.Store.WriteArchiveDay(ctx, d, gz)
		if cerr := gz.Close(); err == nil {
			err = cerr
		}
		contents = c
		pw.CloseWithError(err)
	}()
	size, err := s.Archive.Put(ctx, key, pr)
	if err == nil {
		err = errors.New("upload finished") // only matters if the writer is still going
	}
	_ = pr.CloseWithError(err) // stop the writer if the upload gave up
	<-done
	if err != nil && err.Error() != "upload finished" {
		return err
	}
	if size != written {
		return fmt.Errorf("archive %s: wrote %d bytes, the store has %d", key, written, size)
	}
	if len(contents.BatchIDs) == 0 && contents.Legacy == 0 {
		return nil
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if err := s.Store.CompleteArchiveDay(ctx, d, contents, key, sum, size); err != nil {
		return err
	}
	p := Principal{UserID: "system", Tenant: d.Tenant, Role: "admin", Via: "system"}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/internal/retention", nil)
	s.audit(req, p, "events.archive", d.Day.Format("2006-01-02"), map[string]any{"key": key, "sha256": sum, "bytes": size,
		"batches": len(contents.BatchIDs), "events": contents.Events, "legacy_events": contents.Legacy, "retention_days": s.retentionDays()})
	return nil
}

type countWriter struct {
	w io.Writer
	n *int64
}

func (c *countWriter) Write(b []byte) (int, error) {
	n, err := c.w.Write(b)
	*c.n += int64(n)
	return n, err
}
