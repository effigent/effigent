package main

import (
	"os"
	"testing"
)

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
