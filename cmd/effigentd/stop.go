package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

// How this effigentd was started, for the daemon_stop event. A signal
// doesn't say who sent it, so the OS user is only reported for a daemon run
// from a terminal (the user who ran it, or sudo's caller); under a service
// manager the stop came from an admin or the system, and the event says
// which manager ("systemd", "launchd", "windows-service"), else "background".
func runContext() (via, osUser string) {
	switch {
	case runtime.GOOS == "windows":
		if serviceMode {
			return "windows-service", ""
		}
	case os.Getenv("INVOCATION_ID") != "":
		return "systemd", ""
	case runtime.GOOS == "darwin" && os.Getenv("XPC_SERVICE_NAME") == "ai.effigent.effigentd":
		return "launchd", "" // deploy/macos/ai.effigent.effigentd.plist
	case os.Getppid() == 1:
		// another launchd job, an init script, or a process left running after
		// its shell exited (nohup … &): no telling which
		return "background", ""
	}
	if fi, err := os.Stdin.Stat(); err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return "background", ""
	}
	if u := os.Getenv("SUDO_USER"); u != "" {
		return "terminal", u
	}
	if u, err := user.Current(); err == nil {
		return "terminal", u.Username
	}
	return "terminal", ""
}

// signalName: "SIGTERM", "SIGINT"; Windows service requests pass their own.
func signalName(s os.Signal) string {
	switch s {
	case os.Interrupt:
		return "SIGINT"
	case syscall.SIGTERM:
		return "SIGTERM"
	}
	return s.String()
}

// The run marker is written at start and removed on a clean stop; one left
// behind means the previous run ended without one (kill -9, crash, power).
type runMarker struct {
	PID     int       `json:"pid"`
	Started time.Time `json:"started"`
	Version string    `json:"version"`
}

func markerPath(dir string) string { return filepath.Join(dir, "running") }

// startMarker writes this run's marker and returns the previous run's, if it
// didn't stop cleanly.
func startMarker(dir string) (prev *runMarker) {
	if b, err := os.ReadFile(markerPath(dir)); err == nil {
		prev = &runMarker{}
		_ = json.Unmarshal(b, prev)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil
	}
	b, _ := json.Marshal(runMarker{PID: os.Getpid(), Started: time.Now().UTC(), Version: version})
	_ = os.WriteFile(markerPath(dir), b, 0o600)
	return prev
}

func clearMarker(dir string) { _ = os.Remove(markerPath(dir)) }

func uncleanMessage(m *runMarker) string {
	s := "effigentd's previous run ended without stopping cleanly (killed, crashed or the machine lost power)"
	if !m.Started.IsZero() {
		s = fmt.Sprintf("effigentd's previous run (pid %d, started %s) ended without stopping cleanly (killed, crashed or the machine lost power)",
			m.PID, m.Started.Format(time.RFC3339))
	}
	return s
}
