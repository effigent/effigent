package sink

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// backend records batches by id and answers with a status we control.
type backend struct {
	status  atomic.Int32
	mu      sync.Mutex
	batches map[string]int // batch id -> events
	posts   int
}

func (b *backend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BatchID string            `json:"batch_id"`
		Events  []json.RawMessage `json:"events"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	b.mu.Lock()
	b.posts++
	b.mu.Unlock()
	if st := int(b.status.Load()); st != 200 {
		w.WriteHeader(st)
		return
	}
	b.mu.Lock()
	b.batches[body.BatchID] = len(body.Events)
	b.mu.Unlock()
}

func (b *backend) events() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, c := range b.batches {
		n += c
	}
	return n
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for range 500 {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestHTTPSpool(t *testing.T) {
	be := &backend{batches: map[string]int{}}
	be.status.Store(503)
	srv := httptest.NewServer(be)
	defer srv.Close()
	dir := t.TempDir()
	h := NewHTTP(HTTPConfig{URL: srv.URL, BatchSize: 10, Interval: 20 * time.Millisecond, SpoolDir: dir, RetryWait: time.Millisecond})
	spoolCount := func() int { ents, _ := os.ReadDir(dir); return len(ents) }

	// backend down: batches wait on disk, nothing is dropped
	for i := range 35 {
		h.Write(event.Event{Time: time.Now(), Type: "exec", Severity: "info", Agent: "claude-code", Target: string(rune('a' + i%26))})
	}
	waitFor(t, "spooled batches", func() bool { return h.Spooled() == 35 })
	if spoolCount() < 3 {
		t.Fatalf("spool files: %d", spoolCount())
	}
	if _, dropped := h.Stats(); dropped != 0 {
		t.Fatalf("dropped %d while the backend was down", dropped)
	}
	if info, _ := os.Stat(dir); info.Mode().Perm() != 0o700 {
		t.Fatalf("spool dir mode %v", info.Mode().Perm())
	}

	// backend back: everything arrives, once, and the spool empties
	be.status.Store(200)
	h.Write(event.Event{Time: time.Now(), Type: "exec", Severity: "info", Target: "after"})
	waitFor(t, "replay", func() bool { return be.events() == 36 && spoolCount() == 0 })
	if sent, dropped := h.Stats(); sent != 36 || dropped != 0 {
		t.Fatalf("sent %d dropped %d", sent, dropped)
	}
	h.Close()

	// a refused batch (revoked endpoint: 401) is dropped, not spooled forever
	be2 := &backend{batches: map[string]int{}}
	be2.status.Store(401)
	srv2 := httptest.NewServer(be2)
	defer srv2.Close()
	dir2 := t.TempDir()
	h2 := NewHTTP(HTTPConfig{URL: srv2.URL, BatchSize: 5, Interval: 20 * time.Millisecond, SpoolDir: dir2, RetryWait: time.Millisecond})
	for range 5 {
		h2.Write(event.Event{Time: time.Now(), Type: "exec", Severity: "info"})
	}
	waitFor(t, "drop", func() bool { _, d := h2.Stats(); return d == 5 })
	if ents, _ := os.ReadDir(dir2); len(ents) != 0 || h2.Spooled() != 0 {
		t.Fatalf("401 spooled %d files", len(ents))
	}
	h2.Close()

	// spool over its size: the oldest batches go first
	be3 := &backend{batches: map[string]int{}}
	be3.status.Store(500)
	srv3 := httptest.NewServer(be3)
	defer srv3.Close()
	dir3 := t.TempDir()
	h3 := NewHTTP(HTTPConfig{URL: srv3.URL, BatchSize: 1, Interval: 10 * time.Millisecond, SpoolDir: dir3, RetryWait: time.Millisecond, SpoolMaxBytes: 600})
	for range 20 {
		h3.Write(event.Event{Time: time.Now(), Type: "exec", Severity: "info", Target: "0123456789012345678901234567890123456789"})
	}
	waitFor(t, "spool cap", func() bool { _, d := h3.Stats(); return h3.Spooled() == 20 && d > 0 })
	var total int64
	ents, _ := os.ReadDir(dir3)
	for _, e := range ents {
		info, _ := e.Info()
		total += info.Size()
	}
	if total > 600 {
		t.Fatalf("spool holds %d bytes, cap 600", total)
	}
	h3.Close()

	// shutting down with the backend down: the queue lands in the spool, and the next start sends it
	be4 := &backend{batches: map[string]int{}}
	be4.status.Store(503)
	srv4 := httptest.NewServer(be4)
	defer srv4.Close()
	dir4 := t.TempDir()
	h4 := NewHTTP(HTTPConfig{URL: srv4.URL, BatchSize: 100, Interval: time.Hour, SpoolDir: dir4, RetryWait: time.Millisecond})
	for range 7 {
		h4.Write(event.Event{Time: time.Now(), Type: "exec", Severity: "info"})
	}
	h4.Close()
	if h4.Spooled() != 7 {
		t.Fatalf("on close: spooled %d", h4.Spooled())
	}
	be4.status.Store(200)
	h5 := NewHTTP(HTTPConfig{URL: srv4.URL, Interval: 20 * time.Millisecond, SpoolDir: dir4, RetryWait: time.Millisecond})
	waitFor(t, "replay after restart", func() bool { return be4.events() == 7 })
	h5.Close()
}

// A backend that hangs can't hold a stopping daemon past CloseTimeout: the
// last batch goes to the spool instead.
func TestHTTPCloseTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	dir := t.TempDir()
	h := NewHTTP(HTTPConfig{URL: srv.URL, Interval: time.Hour, SpoolDir: dir, CloseTimeout: 200 * time.Millisecond})
	h.Write(event.Event{Time: time.Now(), Type: event.DaemonStop, Severity: "high"})
	start := time.Now()
	h.Close()
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("close took %v", d)
	}
	if h.Spooled() != 1 {
		t.Fatalf("spooled %d", h.Spooled())
	}
}
