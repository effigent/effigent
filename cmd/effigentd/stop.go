package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
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

// Values of event.Event.Shutdown. The control plane alerts on a stop or an
// unclean restart only when it's "no": a machine shutting down, rebooting or
// losing power is not someone switching effigentd off.
const (
	shutdownSystem  = "system"
	shutdownNo      = "no"
	shutdownUnknown = "unknown"
)

// stopShutdown says whether a stop (why = signalName or the Windows service
// reason) is part of the machine shutting down. systemState is systemd's
// `systemctl is-system-running` ("" without systemd). macOS gives no
// reliable sign: launchd sends the same SIGTERM for `launchctl bootout`
// and for a shutdown, so that stays unknown.
func stopShutdown(goos, why, systemState string) string {
	if goos == "windows" {
		switch why {
		case "system shutdown":
			return shutdownSystem
		case "service stop":
			return shutdownNo
		}
		return shutdownUnknown
	}
	switch systemState {
	case "stopping":
		return shutdownSystem
	case "running", "degraded", "maintenance", "starting", "initializing":
		return shutdownNo
	}
	if why == "SIGINT" { // Ctrl-C or kill -INT: a shutdown sends SIGTERM
		return shutdownNo
	}
	return shutdownUnknown
}

// systemdState is `systemctl is-system-running` ("stopping" during a
// shutdown or reboot), or "" without systemd or when it doesn't answer in
// time. It exits non-zero for any state but "running", so only the output counts.
func systemdState() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "systemctl", "is-system-running").Output()
	return strings.TrimSpace(string(out))
}

// uncleanShutdown says whether the previous run ended because the machine
// went down: it booted after that run started (power loss, a crash of the
// OS, a forced power-off) → "system"; it was already up → "no" (effigentd
// was killed or crashed). boot is zero when unknown.
func uncleanShutdown(boot time.Time, prev *runMarker) string {
	if boot.IsZero() || prev == nil || prev.Started.IsZero() {
		return shutdownUnknown
	}
	if boot.After(prev.Started) {
		return shutdownSystem
	}
	return shutdownNo
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

// clearMarker removes this run's marker (not one a newer run already wrote).
func clearMarker(dir string) {
	var m runMarker
	if b, err := os.ReadFile(markerPath(dir)); err == nil && json.Unmarshal(b, &m) == nil && m.PID != os.Getpid() {
		return
	}
	_ = os.Remove(markerPath(dir))
}

func uncleanMessage(m *runMarker) string {
	s := "effigentd's previous run ended without stopping cleanly (killed, crashed or the machine lost power)"
	if !m.Started.IsZero() {
		s = fmt.Sprintf("effigentd's previous run (pid %d, started %s) ended without stopping cleanly (killed, crashed or the machine lost power)",
			m.PID, m.Started.Format(time.RFC3339))
	}
	return s
}
