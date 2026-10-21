package main

import (
	"os"
	"path/filepath"

	"github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/endpoint/procscan"
)

// gateExemptPaths is effigentd's own binary paths (FR Q3): the processes the
// kernel lets exec a gated binary, so `effigentd gate -- <bin>` runs while a
// direct exec by the agent is refused. The standard install path plus this
// daemon's resolved executable, so a non-standard install still works.
func gateExemptPaths() []string {
	paths := map[string]bool{"/usr/local/bin/effigentd": true}
	if exe, err := os.Executable(); err == nil {
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			paths[r] = true
		} else {
			paths[exe] = true
		}
	}
	out := make([]string, 0, len(paths))
	for p := range paths {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// guardKillMax caps KillPIDs. task_kill matches arg 0 (an int) with the Equal
// operator, and Tetragon limits a numeric Equal to 4 values; more would make
// the whole -guard policy fail to load. effigentd itself plus up to 3 Tetragon
// pids is plenty.
const guardKillMax = 4

// buildGuard assembles the kernel self-protection target (FR Q20): the path
// prefixes a tracked agent may not write/unlink/rename, and the pids it may
// not signal. It is best-effort and never fails — anything it can't resolve is
// simply left out, and SelfProtectionOn in the policy still governs whether it
// is rendered at all.
//
// Paths are matched by prefix in the kernel, so each entry protects its whole
// subtree (and, as a documented limit, same-prefixed siblings). The set is a
// standard deployment layout plus the paths this daemon actually uses, so a
// non-standard install still protects its own binary and state dir.
//
// KillPIDs only make sense where effigentd shares a pid namespace with the
// agents and with Tetragon, i.e. where procfs scanning is on (Linux host). On
// macOS (no procfs, kernel enforcement lives in a separate VM) they are empty
// and the task_kill hook isn't rendered.
func buildGuard(stateDir, procfs string, logf func(string, ...any)) *policy.SelfProtect {
	// Self-protection runs only in the kernel (Linux), so the protected set is
	// the Linux deployment layout, regardless of the daemon's own OS (on a Mac
	// dev box the daemon drives Tetragon in a Linux VM whose paths are these).
	paths := map[string]bool{
		// Standard install layout.
		"/usr/local/bin/effigentd":              true,
		"/var/lib/effigent":                     true,
		"/etc/systemd/system/effigentd.service": true,
		// Tetragon: binary, config and its export log.
		"/usr/bin/tetragon":       true,
		"/usr/local/bin/tetragon": true,
		"/etc/tetragon":           true,
		"/var/log/tetragon":       true,
		// The managed agent-hook configs effigentd writes (Linux paths).
		"/etc/claude-code/managed-settings.json": true,
		"/etc/codex/requirements.toml":           true,
		"/etc/gemini-cli/settings.json":          true,
		"/etc/cursor/hooks.json":                 true,
	}
	// This daemon's own binary and state dir, resolved, so a non-standard
	// install still protects what it actually uses.
	if exe, err := os.Executable(); err == nil {
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			paths[r] = true
		} else {
			paths[exe] = true
		}
	}
	if stateDir != "" {
		if r, err := filepath.EvalSymlinks(stateDir); err == nil {
			paths[r] = true
		} else {
			paths[stateDir] = true
		}
	}
	list := make([]string, 0, len(paths))
	for p := range paths {
		if p != "" {
			list = append(list, p)
		}
	}

	var kill []uint32
	if procfs != "" {
		kill = append(kill, uint32(os.Getpid()))
		if procs, _, err := procscan.Scan(procfs); err == nil {
			for _, p := range procs {
				if len(kill) >= guardKillMax {
					break
				}
				if filepath.Base(p.Binary) == "tetragon" {
					kill = append(kill, p.PID)
				}
			}
		} else if logf != nil {
			logf("self-protection: proc scan for tetragon: %v", err)
		}
	}
	return &policy.SelfProtect{KillPIDs: kill, Paths: list}
}
