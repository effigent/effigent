package main

import (
	"os"
	"runtime"
	"testing"
	"time"
)

func TestStopShutdown(t *testing.T) {
	cases := []struct {
		goos, why, state, want string
	}{
		{"linux", "SIGTERM", "stopping", shutdownSystem}, // systemd is shutting the machine down
		{"linux", "SIGTERM", "running", shutdownNo},      // systemctl stop / restart effigentd
		{"linux", "SIGTERM", "degraded", shutdownNo},
		{"linux", "SIGTERM", "", shutdownUnknown},  // no systemd (containers, sandboxes)
		{"linux", "SIGINT", "", shutdownNo},        // Ctrl-C
		{"darwin", "SIGTERM", "", shutdownUnknown}, // launchd: bootout and shutdown look the same
		{"darwin", "SIGINT", "", shutdownNo},
		{"windows", "system shutdown", "", shutdownSystem},
		{"windows", "service stop", "", shutdownNo},
		{"windows", "SIGINT", "", shutdownUnknown},
	}
	for _, c := range cases {
		if got := stopShutdown(c.goos, c.why, c.state); got != c.want {
			t.Errorf("stopShutdown(%s, %s, %q) = %s, want %s", c.goos, c.why, c.state, got, c.want)
		}
	}
}

func TestUncleanShutdown(t *testing.T) {
	started := time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)
	prev := &runMarker{PID: 42, Started: started}
	if got := uncleanShutdown(started.Add(time.Hour), prev); got != shutdownSystem {
		t.Errorf("booted after the run started (power loss): %s", got)
	}
	if got := uncleanShutdown(started.Add(-time.Hour), prev); got != shutdownNo {
		t.Errorf("same boot (kill -9, crash): %s", got)
	}
	if got := uncleanShutdown(time.Time{}, prev); got != shutdownUnknown {
		t.Errorf("unknown boot time: %s", got)
	}
	if got := uncleanShutdown(started, &runMarker{}); got != shutdownUnknown {
		t.Errorf("marker without a start time: %s", got)
	}
	if b := bootTime(); (runtime.GOOS == "linux" || runtime.GOOS == "darwin") && (b.IsZero() || b.After(time.Now())) {
		t.Errorf("bootTime() = %v", b)
	}
}

func TestRunMarker(t *testing.T) {
	dir := t.TempDir()
	if prev := startMarker(dir); prev != nil {
		t.Fatalf("fresh state dir: %+v", prev)
	}
	// still there at the next start: the run before didn't stop cleanly
	prev := startMarker(dir)
	if prev == nil || prev.PID != os.Getpid() || prev.Started.IsZero() {
		t.Fatalf("previous run %+v", prev)
	}
	clearMarker(dir)
	if prev := startMarker(dir); prev != nil {
		t.Fatalf("after a clean stop: %+v", prev)
	}
	// a newer run's marker is left alone
	if err := os.WriteFile(markerPath(dir), []byte(`{"pid":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	clearMarker(dir)
	if _, err := os.Stat(markerPath(dir)); err != nil {
		t.Fatal("removed another run's marker")
	}
}
