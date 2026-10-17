package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// memArchive stands in for S3.
type memArchive struct {
	mu   sync.Mutex
	objs map[string][]byte
	fail bool
}

func (m *memArchive) Put(_ context.Context, key string, r io.Reader) (int64, error) {
	b, err := io.ReadAll(r)
	if err != nil {
		return 0, err
	}
	if m.fail {
		return 0, errors.New("s3 is down")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objs[key] = b
	return int64(len(b)), nil
}

func (m *memArchive) Check(context.Context) error { return nil }

func (m *memArchive) PresignGet(_ context.Context, key, filename string, _ time.Duration) (string, error) {
	return "https://s3.example/" + key + "?name=" + filename, nil
}

// TestEventsPagingIntegrityRetention needs a throwaway Postgres database (see TestCentralPolicyEndToEnd).
func TestEventsPagingIntegrityRetention(t *testing.T) {
	dbURL := os.Getenv("EFFIGENT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("EFFIGENT_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	st, err := store.Open(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := pgx.Connect(ctx, dbURL) // the table owner can switch the guards off: what an attacker with DB access would do
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close(ctx)

	tenant := fmt.Sprintf("org:events-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	call := func(method, path, bearer string, body any, out any) int {
		t.Helper()
		var rd io.Reader = http.NoBody
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, srv.URL+path, rd)
		if bearer == "" {
			req.Header.Set("Authorization", "Bearer t0ken")
			req.Header.Set("X-Effigent-Tenant", tenant)
		} else {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if out != nil && res.StatusCode < 300 {
			_ = json.NewDecoder(res.Body).Decode(out)
		}
		return res.StatusCode
	}
	enroll := func(host string) EnrollResponse {
		var tok struct {
			Token struct{ Token string } `json:"token"`
		}
		call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
		var er EnrollResponse
		call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": host}}, &er)
		return er
	}
	laptop, server := enroll("dana-mbp"), enroll("build-1")
	base := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	send := func(ep EnrollResponse, batchID string, from, n int) (accepted int, dup bool) {
		t.Helper()
		var evs []map[string]any
		for i := from; i < from+n; i++ {
			typ := "exec"
			if i%10 == 0 {
				typ = "blocked"
			}
			evs = append(evs, map[string]any{"time": base.Add(time.Duration(i) * time.Second), "type": typ, "severity": "info", "agent": "claude-code",
				"body": map[string]any{"target": fmt.Sprintf("Bash: make target-%d", i), "big": 1e3, "dup": 1}})
		}
		var r struct {
			Accepted  int  `json:"accepted"`
			Duplicate bool `json:"duplicate"`
		}
		if code := call("POST", "/ep/v1/events", ep.Secret, map[string]any{"batch_id": batchID, "events": evs}, &r); code != 200 {
			t.Fatalf("ingest: %d", code)
		}
		return r.Accepted, r.Duplicate
	}
	// 3 batches from the laptop, 1 from the server; the same batch sent twice is stored once
	send(laptop, "b1", 0, 40)
	send(laptop, "b2", 40, 40)
	if n, dup := send(laptop, "b2", 40, 40); n != 40 || !dup {
		t.Fatalf("replayed batch: accepted %d duplicate %v", n, dup)
	}
	send(laptop, "b3", 80, 30)
	send(server, "s1", 200, 25)
	// an old effigentd (no batch id) still works
	if code := call("POST", "/ep/v1/events", server.Secret, map[string]any{"events": []map[string]any{{"type": "exec", "time": base, "agent": "codex", "body": map[string]any{"target": "ls"}}}}, nil); code != 200 {
		t.Fatalf("ingest without batch id: %d", code)
	}

	// ---- paging: every event once, newest first ----
	type page struct {
		Events     []store.Event `json:"events"`
		NextBefore string        `json:"next_before"`
	}
	get := func(q url.Values) page {
		t.Helper()
		q.Set("paged", "1")
		var p page
		if code := call("GET", "/api/v1/events?"+q.Encode(), "", nil, &p); code != 200 {
			t.Fatalf("events %s: %d", q.Encode(), code)
		}
		return p
	}
	seen := map[int64]bool{}
	var last time.Time
	q := url.Values{"limit": {"17"}}
	for pages := 0; ; pages++ {
		p := get(q)
		for _, e := range p.Events {
			if seen[e.ID] {
				t.Fatalf("event %d twice", e.ID)
			}
			if !last.IsZero() && e.Time.After(last) {
				t.Fatal("not newest first")
			}
			seen[e.ID], last = true, e.Time
		}
		if p.NextBefore == "" {
			break
		}
		if pages > 20 {
			t.Fatal("paging does not end")
		}
		q.Set("before", p.NextBefore)
	}
	if len(seen) != 136 {
		t.Fatalf("walked %d events, want 136 (the replay must not double them)", len(seen))
	}
	if p := get(url.Values{"type": {"blocked"}, "limit": {"100"}}); len(p.Events) != 14 {
		t.Fatalf("type filter: %d", len(p.Events))
	}
	if p := get(url.Values{"endpoint": {server.EndpointID}, "limit": {"100"}}); len(p.Events) != 26 {
		t.Fatalf("endpoint filter: %d", len(p.Events))
	}
	if p := get(url.Values{"agent": {"codex"}}); len(p.Events) != 1 {
		t.Fatalf("agent filter: %d", len(p.Events))
	}
	if p := get(url.Values{"q": {"target-205"}}); len(p.Events) != 1 {
		t.Fatalf("search: %d", len(p.Events))
	}
	if p := get(url.Values{"since": {base.Add(100 * time.Second).Format(time.RFC3339)}, "until": {base.Add(110 * time.Second).Format(time.RFC3339)}}); len(p.Events) != 10 {
		t.Fatalf("time range: %d", len(p.Events))
	}
	if code := call("GET", "/api/v1/events?paged=1&before=nonsense", "", nil, nil); code != 400 {
		t.Fatalf("bad cursor: %d", code)
	}

	// ---- integrity ----
	verify := func() store.EventVerification {
		t.Helper()
		var v store.EventVerification
		if code := call("GET", "/api/v1/events/verify", "", nil, &v); code != 200 {
			t.Fatalf("verify: %d", code)
		}
		return v
	}
	if v := verify(); !v.OK || v.Batches != 5 || v.Events != 136 || v.Endpoints != 2 {
		t.Fatalf("clean verify: %+v", v)
	}
	// the guards: no updates, no deletes, even of old rows outside retention
	if _, err := owner.Exec(ctx, `update cp.events set type = 'exec' where tenant_ref = $1`, tenant); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("update allowed: %v", err)
	}
	if _, err := owner.Exec(ctx, `delete from cp.events where tenant_ref = $1`, tenant); err == nil {
		t.Fatal("delete allowed")
	}
	if _, err := owner.Exec(ctx, `delete from cp.event_batches where tenant_ref = $1`, tenant); err == nil {
		t.Fatal("batch delete allowed")
	}
	tamper := func(sql string, args ...any) {
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
	var b2 int64
	_ = owner.QueryRow(ctx, `select id from cp.event_batches where endpoint_id = $1 and client_batch_id = 'b2'`, laptop.EndpointID).Scan(&b2)
	// 1. an attacker rewrites a blocked event as allowed
	tamper(`update cp.events set type = 'exec' where batch_id = $1 and type = 'blocked' and id = (select min(id) from cp.events where batch_id = $1 and type = 'blocked')`, b2)
	if v := verify(); v.OK || len(v.Problems) != 1 || v.Problems[0].Batch != b2 || !strings.Contains(v.Problems[0].Reason, "modified") {
		t.Fatalf("modified event not caught: %+v", v)
	}
	tamper(`update cp.events set type = 'blocked' where batch_id = $1 and id = (select min(id) from cp.events where batch_id = $1 and body::text like '%target-40"%')`, b2)
	if v := verify(); !v.OK {
		t.Fatalf("restored: %+v", v)
	}
	// 2. an event deleted
	tamper(`delete from cp.events where id = (select max(id) from cp.events where batch_id = $1)`, b2)
	if v := verify(); v.OK || v.Problems[0].Batch != b2 {
		t.Fatalf("deleted event not caught: %+v", v)
	}
	// 3. a whole batch removed from the middle of the chain
	var b1 int64
	_ = owner.QueryRow(ctx, `select id from cp.event_batches where endpoint_id = $1 and client_batch_id = 'b1'`, laptop.EndpointID).Scan(&b1)
	tamper(`delete from cp.event_batches where id = $1`, b1)
	if v := verify(); v.OK || !strings.Contains(fmt.Sprint(v.Problems), "does not link") {
		t.Fatalf("removed batch not caught: %+v", v)
	}
	// 4. an event slipped in outside any batch
	tamper(`insert into cp.events (tenant_ref, endpoint_id, event_time, type, body) values ($1, $2, now(), 'exec', '{}')`, tenant, laptop.EndpointID)
	if v := verify(); v.Unbatched != 1 {
		t.Fatalf("unbatched event not caught: %+v", v)
	}

	// ---- retention ----
	t2 := fmt.Sprintf("org:retention-%d", time.Now().UnixNano())
	st2 := s.Store
	ep2 := uuid.NewString() // an endpoint of the second tenant
	mk := func(batch string, n int) {
		var evs []store.Event
		for i := range n {
			evs = append(evs, store.Event{Time: base, Type: "exec", Agent: "claude-code", Body: json.RawMessage(fmt.Sprintf(`{"target":"t%d"}`, i))})
		}
		if _, _, err := st2.IngestBatch(ctx, t2, ep2, batch, evs); err != nil {
			t.Fatal(err)
		}
	}
	mk("old-1", 5)
	mk("old-2", 3)
	mk("new-1", 4)
	old := time.Now().Add(-100 * 24 * time.Hour).UTC()
	tamper(`update cp.event_batches set received_at = $2 where tenant_ref = $1 and client_batch_id like 'old-%'`, t2, old)
	tamper(`update cp.events set ingested_at = $2 where tenant_ref = $1 and batch_id in (select id from cp.event_batches where tenant_ref = $1 and client_batch_id like 'old-%')`, t2, old)
	// the batch hashes cover received_at: re-seal the backdated rows the way ingest would have
	tamper(`update cp.event_batches set hash = cp.event_batch_hash(tenant_ref, endpoint_id, client_batch_id, received_at, first_id, last_id, count, content_hash, prev_hash) where tenant_ref = $1 and client_batch_id = 'old-1'`, t2)
	tamper(`update cp.event_batches b set prev_hash = (select hash from cp.event_batches where tenant_ref = $1 and client_batch_id = 'old-1') where tenant_ref = $1 and client_batch_id = 'old-2'`, t2)
	tamper(`update cp.event_batches set hash = cp.event_batch_hash(tenant_ref, endpoint_id, client_batch_id, received_at, first_id, last_id, count, content_hash, prev_hash) where tenant_ref = $1 and client_batch_id = 'old-2'`, t2)
	tamper(`update cp.event_batches b set prev_hash = (select hash from cp.event_batches where tenant_ref = $1 and client_batch_id = 'old-2') where tenant_ref = $1 and client_batch_id = 'new-1'`, t2)
	tamper(`update cp.event_batches set hash = cp.event_batch_hash(tenant_ref, endpoint_id, client_batch_id, received_at, first_id, last_id, count, content_hash, prev_hash) where tenant_ref = $1 and client_batch_id = 'new-1'`, t2)
	if v, _ := st2.VerifyEvents(ctx, t2); !v.OK {
		t.Fatalf("retention fixture: %+v", v)
	}
	count := func() (n int) {
		_ = owner.QueryRow(ctx, `select count(*) from cp.events where tenant_ref = $1`, t2).Scan(&n)
		return
	}
	// no archive configured: nothing is ever deleted
	s.runRetention(ctx)
	if count() != 12 {
		t.Fatal("retention deleted without an archive")
	}
	// the archive fails: nothing deleted
	arch := &memArchive{objs: map[string][]byte{}, fail: true}
	s.Archive = arch
	s.runRetention(ctx)
	if count() != 12 {
		t.Fatal("retention deleted although the upload failed")
	}
	// the archive works: the old day moves to S3, the recent batch stays, the chain still verifies
	arch.fail = false
	s.runRetention(ctx)
	if count() != 4 {
		t.Fatalf("after retention: %d events left, want 4", count())
	}
	if v, _ := st2.VerifyEvents(ctx, t2); !v.OK || v.ArchivedBatches != 2 || v.Events != 4 {
		t.Fatalf("verify after retention: %+v", v)
	}
	objKey := "events/" + t2 + "/" + old.Format("2006/01/02") + ".jsonl.gz"
	obj, ok := arch.objs[objKey]
	if !ok {
		t.Fatalf("no archive object %s (have %v)", objKey, arch.objs)
	}
	zr, err := gzip.NewReader(bytes.NewReader(obj))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(zr)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2+8 || !strings.Contains(lines[0], `"batch"`) || !strings.Contains(lines[1], `"hashed"`) {
		t.Fatalf("archive content: %d lines: %s", len(lines), lines[0])
	}
	var archives struct {
		Archives []store.EventArchive `json:"archives"`
	}
	// the archive list and download link are per tenant
	s2 := &Server{Store: st, Key: key2(), Auth: mustAuth(t, t2), Logf: t.Logf, Archive: arch}
	srv2 := httptest.NewServer(s2.Handler())
	defer srv2.Close()
	req, _ := http.NewRequest("GET", srv2.URL+"/api/v1/events/archives", nil)
	req.Header.Set("Authorization", "Bearer t0ken")
	req.Header.Set("X-Effigent-Tenant", t2)
	res, _ := http.DefaultClient.Do(req)
	_ = json.NewDecoder(res.Body).Decode(&archives)
	res.Body.Close()
	if len(archives.Archives) != 1 || archives.Archives[0].Events != 8 || archives.Archives[0].Day != old.Format("2006-01-02") {
		t.Fatalf("archives: %+v", archives)
	}
	req, _ = http.NewRequest("POST", srv2.URL+"/api/v1/events/archives/"+old.Format("2006-01-02")+"/link", nil)
	req.Header.Set("Authorization", "Bearer t0ken")
	req.Header.Set("X-Effigent-Tenant", t2)
	res, _ = http.DefaultClient.Do(req)
	var link struct{ URL string }
	_ = json.NewDecoder(res.Body).Decode(&link)
	res.Body.Close()
	if !strings.Contains(link.URL, objKey) {
		t.Fatalf("download link: %+v", link)
	}
	// another tenant can't fetch it
	if code := call("POST", "/api/v1/events/archives/"+old.Format("2006-01-02")+"/link", "", nil, nil); code == 200 {
		t.Fatal("another tenant got the link")
	}
	// running again changes nothing
	s.runRetention(ctx)
	mine := 0
	for k := range arch.objs { // retention runs for every tenant in the database
		if strings.HasPrefix(k, "events/"+t2+"/") {
			mine++
		}
	}
	if count() != 4 || mine != 1 {
		t.Fatalf("second run: %d events, %d objects", count(), mine)
	}
}

func key2() ed25519.PrivateKey { _, k, _ := ed25519.GenerateKey(nil); return k }

func mustAuth(t *testing.T, tenant string) *Authenticator {
	a, err := NewAuthenticator(context.Background(), Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	if err != nil {
		t.Fatal(err)
	}
	return a
}
