package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/cpclient"
	"github.com/effigent/effigent/internal/endpoint/event"
)

func TestSessionMarks(t *testing.T) {
	known := sessionMarks(filepath.Join(t.TempDir(), "s"))
	if known("claude-code/a") || !known("claude-code/a") || known("claude-code/b") {
		t.Fatal("first call of a session must be new, later ones known")
	}
}

func TestShipEventsSpool(t *testing.T) {
	var status atomic.Int32
	status.Store(503)
	var got atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer eps_x" || r.URL.Path != "/ep/v1/events" {
			w.WriteHeader(401)
			return
		}
		if s := int(status.Load()); s != 200 {
			w.WriteHeader(s)
			return
		}
		got.Add(1)
	}))
	defer srv.Close()
	st := &cpclient.State{Server: srv.URL, Secret: "eps_x"}
	spool := filepath.Join(t.TempDir(), "spool")
	ev := []event.Event{{Time: time.Now(), Type: event.Exec}}
	ctx := context.Background()
	count := func() int { n, _ := filepath.Glob(filepath.Join(spool, "*.json")); return len(n) }

	shipEvents(ctx, st, spool, ev, true)  // 503: spooled
	shipEvents(ctx, st, spool, ev, false) // known down: spooled without trying
	if count() != 2 || got.Load() != 0 {
		t.Fatalf("spool %d, sent %d", count(), got.Load())
	}
	status.Store(200)
	shipEvents(ctx, st, spool, ev, true) // sent, then the two spooled replayed
	if count() != 0 || got.Load() != 3 {
		t.Fatalf("after recovery: spool %d, sent %d", count(), got.Load())
	}
	status.Store(400) // refused outright: not kept
	shipEvents(ctx, st, spool, ev, true)
	if count() != 0 {
		t.Fatal("a refused batch was spooled")
	}
	os.RemoveAll(spool)
}
