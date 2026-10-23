package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

// TestBreakGlassSurvivesRestart: an activated window is written to the state
// dir and a new run picks it up until it ends; the code stays single-use.
func TestBreakGlassSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if _, _, ok := bgActiveWindow(dir, now); ok {
		t.Fatal("no state file: no window")
	}
	until := now.Add(30 * time.Minute).Truncate(time.Second)
	if used, err := bgMarkUsed(dir, "g1", until); err != nil || used {
		t.Fatalf("first activation: used=%v err=%v", used, err)
	}
	id, got, ok := bgActiveWindow(dir, now)
	if !ok || id != "g1" || !got.Equal(until) {
		t.Fatalf("restored %q %v %v, want g1 %v", id, got, ok, until)
	}
	if used, _ := bgMarkUsed(dir, "g1", until); !used {
		t.Fatal("a code must not be activated twice on one machine")
	}

	// a second code replaces the window, like a second activation does live
	until2 := now.Add(10 * time.Minute).Truncate(time.Second)
	if _, err := bgMarkUsed(dir, "g2", until2); err != nil {
		t.Fatal(err)
	}
	if id, got, _ := bgActiveWindow(dir, now); id != "g2" || !got.Equal(until2) {
		t.Fatalf("restored %q %v, want g2 %v", id, got, until2)
	}

	// ended, or longer than any code can last: nothing restored
	if _, _, ok := bgActiveWindow(dir, until2.Add(time.Second)); ok {
		t.Fatal("an ended window was restored")
	}
	if _, _, ok := bgActiveWindow(dir, now.Add(-9*time.Hour)); ok {
		t.Fatal("a window longer than 8h was restored")
	}
	if err := os.WriteFile(bgStatePath(dir), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := bgActiveWindow(dir, now); ok {
		t.Fatal("a corrupt state file opened a window")
	}
	// a file written before windows were kept has only used codes
	if err := os.WriteFile(bgStatePath(dir), []byte(`{"used":{"g3":"`+until.Format(time.RFC3339)+`"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := bgActiveWindow(dir, now); ok {
		t.Fatal("no active window recorded: nothing to restore")
	}
}

// TestBreakGlassRestoreIntoEngine: what main does at start opens the window in
// a fresh engine, and it closes on its own at the end.
func TestBreakGlassRestoreIntoEngine(t *testing.T) {
	dir := t.TempDir()
	until := time.Now().Add(300 * time.Millisecond)
	if _, err := bgMarkUsed(dir, "g1", until); err != nil {
		t.Fatal(err)
	}
	pol, err := policy.Parse(policy.DefaultYAML)
	if err != nil {
		t.Fatal(err)
	}
	eng := engine.New(pol, policy.DefaultYAML, nil, func(event.Event) {}, t.Logf, false)
	id, u, ok := bgActiveWindow(dir, time.Now())
	if !ok {
		t.Fatal("window not found")
	}
	eng.SetBreakGlass(context.Background(), id, u)
	if gid, _, active := eng.BreakGlass(); !active || gid != "g1" {
		t.Fatalf("engine window %q active=%v", gid, active)
	}
	time.Sleep(time.Until(until) + 200*time.Millisecond)
	if _, _, active := eng.BreakGlass(); active {
		t.Fatal("the restored window didn't end")
	}
}
