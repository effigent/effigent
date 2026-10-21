package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestLegalHold: a held workspace's events are never deleted (retention
// skips it, the database guard refuses it), its archive objects follow the
// hold, and a retention override moves its cutoff.
func TestLegalHold(t *testing.T) {
	dbURL := testDatabaseURL(t)
	ctx := context.Background()
	st, err := store.Open(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close(ctx)
	backdate := func(sql string, args ...any) {
		t.Helper()
		for _, stmt := range []string{`alter table cp.events disable trigger events_append_only`, `alter table cp.event_batches disable trigger event_batches_append_only`} {
			if _, err := owner.Exec(ctx, stmt); err != nil {
				t.Fatal(err)
			}
		}
		defer func() {
			_, _ = owner.Exec(ctx, `alter table cp.events enable trigger events_append_only`)
			_, _ = owner.Exec(ctx, `alter table cp.event_batches enable trigger event_batches_append_only`)
		}()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}

	tenant := fmt.Sprintf("org:hold-%d", time.Now().UnixNano())
	arch := &memArchive{objs: map[string][]byte{}}
	s := &Server{Store: st, Key: key2(), Auth: mustAuth(t, tenant), Logf: t.Logf, Archive: arch, RetentionDays: 365}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	call := func(method, path string, body any, out any) int {
		t.Helper()
		var rd io.Reader = http.NoBody
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, srv.URL+path, rd)
		req.Header.Set("Authorization", "Bearer t0ken")
		req.Header.Set("X-Effigent-Tenant", tenant)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if out != nil {
			_ = json.NewDecoder(res.Body).Decode(out)
		}
		return res.StatusCode
	}
	ep := uuid.NewString()
	mk := func(batch string, age time.Duration) {
		evs := []store.Event{{Time: time.Now(), Type: "exec", Agent: "claude-code", Body: json.RawMessage(`{"target":"x"}`)}}
		if _, _, err := st.IngestBatch(ctx, tenant, ep, batch, evs); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(-age).UTC()
		backdate(`update cp.event_batches set received_at = $3 where tenant_ref = $1 and client_batch_id = $2`, tenant, batch, at)
		backdate(`update cp.events set ingested_at = $3 where batch_id = (select id from cp.event_batches where tenant_ref = $1 and client_batch_id = $2)`, tenant, batch, at)
	}
	count := func() (n int) {
		_ = owner.QueryRow(ctx, `select count(*) from cp.events where tenant_ref = $1`, tenant).Scan(&n)
		return
	}
	mine := func() (objs, held int) {
		arch.mu.Lock()
		defer arch.mu.Unlock()
		for k := range arch.objs {
			if strings.HasPrefix(k, archivePrefix(tenant)) {
				objs++
				if arch.held[k] {
					held++
				}
			}
		}
		return
	}
	// settle runs the hold sync (the PUT also starts one in the background,
	// which may hold the lock) until it reaches the wanted state
	settle := func(want string) map[string]any {
		t.Helper()
		var v map[string]any
		for range 100 {
			s.syncHolds(ctx)
			call("GET", "/api/v1/events/retention", nil, &v)
			if v["hold_sync"].(map[string]any)["state"] == want {
				return v
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("hold sync never reached %s: %v", want, v["hold_sync"])
		return nil
	}
	mk("d200", 200*24*time.Hour)
	mk("d120", 120*24*time.Hour)
	mk("d10", 10*24*time.Hour)

	// the default (365 days) keeps everything; an override of 150 archives the 200-day-old day
	s.runRetention(ctx)
	if count() != 3 {
		t.Fatalf("default retention deleted: %d left", count())
	}
	if code := call("PUT", "/api/v1/events/retention", map[string]any{"retention_days": 30}, nil); code != 400 {
		t.Fatalf("under 90 days accepted: %d", code)
	}
	var v map[string]any
	if code := call("PUT", "/api/v1/events/retention", map[string]any{"retention_days": 150}, &v); code != 200 || v["retention_days"] != float64(150) || v["default_days"] != float64(365) {
		t.Fatalf("override: %d %v", code, v)
	}
	s.runRetention(ctx)
	if objs, _ := mine(); count() != 2 || objs != 1 {
		t.Fatalf("after override: %d events, %d objects", count(), objs)
	}

	// a hold needs a reason; on: the existing archive is held, nothing more is deleted
	if code := call("PUT", "/api/v1/events/retention", map[string]any{"legal_hold": true}, nil); code != 400 {
		t.Fatalf("hold without a reason: %d", code)
	}
	arch.holdFail = true // S3 refuses first: recorded, retried
	if code := call("PUT", "/api/v1/events/retention", map[string]any{"legal_hold": true, "hold_reason": "Matter 2026-17 (Acme v. Example)", "retention_days": 90}, &v); code != 200 || v["legal_hold"] != true {
		t.Fatalf("hold on: %d %v", code, v)
	}
	v = settle("error")
	if sync := v["hold_sync"].(map[string]any); !strings.Contains(fmt.Sprint(sync["error"]), "AccessDenied") {
		t.Fatalf("failed sync: %v", v["hold_sync"])
	}
	arch.holdFail = false
	v = settle("done")
	if objs, held := mine(); held != 1 || objs != 1 || v["hold_sync"].(map[string]any)["objects"] != float64(1) {
		t.Fatalf("held objects %d/%d, sync %v", held, objs, v["hold_sync"])
	}
	s.runRetention(ctx) // 90 days now covers the 120-day-old day, but it is held
	if count() != 2 {
		t.Fatalf("retention deleted under a hold: %d left", count())
	}
	// the database refuses too, even with the retention switch on
	tx, _ := owner.Begin(ctx)
	_, _ = tx.Exec(ctx, `set local effigent.retention = 'on'`)
	if _, err := tx.Exec(ctx, `delete from cp.events where tenant_ref = $1 and ingested_at < now() - interval '100 days'`, tenant); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("guard let a held tenant's events go: %v", err)
	}
	_ = tx.Rollback(ctx)
	// archiving a day as the hold lands: nothing deleted, the object put on hold
	if err := s.archiveDay(ctx, store.ArchiveDay{Tenant: tenant, Day: time.Now().Add(-120 * 24 * time.Hour).UTC().Truncate(24 * time.Hour)}); err != store.ErrLegalHold {
		t.Fatalf("archiving under a hold: %v", err)
	}

	// released: the objects are released and retention resumes
	if code := call("PUT", "/api/v1/events/retention", map[string]any{"legal_hold": false}, &v); code != 200 || v["legal_hold"] != false || v["hold_reason"] == "" {
		t.Fatalf("hold off: %d %v", code, v)
	}
	settle("done")
	if _, held := mine(); held != 0 {
		t.Fatalf("still held after release: %d", held)
	}
	s.runRetention(ctx)
	if objs, _ := mine(); count() != 1 || objs != 2 {
		t.Fatalf("after release: %d events, %d objects", count(), objs)
	}
	// the download link names the archived version
	var link struct{ URL string }
	day := time.Now().Add(-120 * 24 * time.Hour).UTC().Format("2006-01-02")
	if code := call("POST", "/api/v1/events/archives/"+day+"/link", nil, &link); code != 200 || !strings.Contains(link.URL, "versionId=v") {
		t.Fatalf("download link: %d %+v", code, link)
	}
	var audit []store.AuditEntry
	for _, act := range []string{"events.legal_hold.on", "events.legal_hold.off", "events.retention.update", "events.legal_hold.sync"} {
		call("GET", "/api/v1/audit?action="+act, nil, &audit)
		if len(audit) == 0 {
			t.Errorf("no %s in the audit trail", act)
		}
	}
}
