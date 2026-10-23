package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/api"
	"github.com/effigent/effigent/internal/endpoint/cpclient"
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

const gatePolicy = `
defaults:
  mode: denylist
agents:
  - name: grok-bot
    binary_names: [grok-bot]
    exec_deny: [/usr/bin/curl]
    command_deny: ["terraform destroy*"]
    command_approve: ["terraform apply*"]
  - name: grok-bot-monitor
    binary_names: [grok-bot-monitor]
    mode: monitor
    command_deny: ["terraform destroy*"]
`

type gateEvents struct {
	mu  sync.Mutex
	evs []event.Event
}

func (g *gateEvents) add(ev event.Event) { g.mu.Lock(); g.evs = append(g.evs, ev); g.mu.Unlock() }

func (g *gateEvents) last(t *testing.T) event.Event {
	t.Helper()
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.evs) == 0 {
		t.Fatal("no event emitted")
	}
	return g.evs[len(g.evs)-1]
}

func gateEngine(t *testing.T) (*engine.Engine, *gateEvents) {
	t.Helper()
	pol, err := policy.Parse([]byte(gatePolicy))
	if err != nil {
		t.Fatal(err)
	}
	evs := &gateEvents{}
	return engine.New(pol, []byte(gatePolicy), nil, evs.add, t.Logf, false), evs
}

// TestGateHandler: the gated argv is judged as a Bash call under the agent's
// rule; a deny or an approval that can't be requested refuses the launch.
func TestGateHandler(t *testing.T) {
	eng, evs := gateEngine(t)
	notEnrolled := func() *cpclient.Client { return nil }
	h := gateHandler(eng, notEnrolled)
	for _, tc := range []struct {
		name, agent string
		argv        []string
		allow       bool
		evType      event.Type
		reason      string // substring of the reason
	}{
		{"allowed", "grok-bot", []string{"terraform", "plan", "-out", "plan.bin"}, true, event.Exec, ""},
		{"command_deny", "grok-bot", []string{"terraform", "destroy", "-auto-approve"}, false, event.Blocked, "terraform destroy"},
		{"exec_deny by program name", "grok-bot", []string{"/opt/homebrew/bin/curl", "https://example.com"}, false, event.Blocked, "curl"},
		{"approval without a control plane", "grok-bot", []string{"terraform", "apply"}, false, event.Blocked, "not connected"},
		{"monitor mode reports, allows", "grok-bot-monitor", []string{"terraform", "destroy"}, true, event.WouldBlock, ""},
		// one argument holding a whole command line is still one argument
		{"metacharacters stay in their argument", "grok-bot", []string{"echo", "x; terraform destroy && curl https://example.com $(curl x) `curl y`"}, true, event.Exec, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := h(context.Background(), api.GateCall{Agent: tc.agent, Command: quoteArgs(tc.argv), Cwd: t.TempDir(),
				Budget: 28 * time.Second, OSUser: "grok-bot"})
			if err != nil {
				t.Fatal(err)
			}
			var d struct {
				Allow  bool
				Reason string
			}
			if err := json.Unmarshal(out, &d); err != nil {
				t.Fatalf("answer %s: %v", out, err)
			}
			if d.Allow != tc.allow || !strings.Contains(d.Reason, tc.reason) {
				t.Fatalf("allow=%v reason=%q, want allow=%v reason containing %q", d.Allow, d.Reason, tc.allow, tc.reason)
			}
			ev := evs.last(t)
			if ev.Type != tc.evType || ev.Agent != tc.agent || ev.OSUser != "grok-bot" {
				t.Fatalf("event %s agent %q user %q, want %s %q grok-bot", ev.Type, ev.Agent, ev.OSUser, tc.evType, tc.agent)
			}
		})
	}

	// under break-glass an approval list lets the launch through; deny lists still refuse
	eng.SetBreakGlass(context.Background(), "bg-1", time.Now().Add(time.Minute))
	for argv, allow := range map[string]bool{"terraform apply": true, "terraform destroy": false} {
		out, _ := h(context.Background(), api.GateCall{Agent: "grok-bot", Command: argv, Budget: 28 * time.Second})
		var d struct{ Allow bool }
		_ = json.Unmarshal(out, &d)
		if d.Allow != allow {
			t.Fatalf("break-glass %q: allow=%v, want %v (%s)", argv, d.Allow, allow, out)
		}
		if allow && evs.last(t).Type != event.BreakGlass {
			t.Fatalf("break-glass %q: event %s", argv, evs.last(t).Type)
		}
	}
}

// TestQuoteArgs: the command line the gate sends parses back, in a real
// shell, to exactly the argv it came from.
func TestQuoteArgs(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	argv := []string{"tool", "plain", "with space", "", "it's", `"double"`, "$HOME", "`id`", "$(id)", "a;b", "a&&b", "a|b",
		"*", "~", "#comment", "!x", "back\\slash", "tab\there", "new\nline", "x=y", "--flag=v a", "ünïcode", "'"}
	line := quoteArgs(argv)
	// eval the line as the shell would, then print each resulting argument NUL-terminated
	got, err := exec.Command(sh, "-c", "eval \"set -- $1\"; for a in \"$@\"; do printf '%s\\0' \"$a\"; done", "sh", line).Output()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(strings.TrimSuffix(string(got), "\x00"), "\x00")
	if len(parts) != len(argv) {
		t.Fatalf("%d args back, want %d: %q from %s", len(parts), len(argv), parts, line)
	}
	for i := range argv {
		if parts[i] != argv[i] {
			t.Errorf("arg %d: %q, want %q (line %s)", i, parts[i], argv[i], line)
		}
	}
	if quoteArgs([]string{"terraform", "plan", "-out", "x.bin"}) != "terraform plan -out x.bin" {
		t.Errorf("plain words are left bare: %s", quoteArgs([]string{"terraform", "plan", "-out", "x.bin"}))
	}
}

func writeExe(t *testing.T, path, script string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// TestResolveReal: the real binary is the first executable on PATH outside
// the shim dir; explicit paths are used as given.
func TestResolveReal(t *testing.T) {
	root := t.TempDir()
	shim, notExe, isDir, real := filepath.Join(root, "shim"), filepath.Join(root, "noexe"), filepath.Join(root, "dir"), filepath.Join(root, "real")
	writeExe(t, filepath.Join(shim, "gtool"), "echo shim")
	if err := os.MkdirAll(notExe, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(notExe, "gtool"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(isDir, "gtool"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeExe(t, filepath.Join(real, "gtool"), "echo real")

	t.Setenv("EFFIGENT_SHIM_DIR", shim)
	for _, path := range []string{
		strings.Join([]string{shim, "", notExe, isDir, real}, string(os.PathListSeparator)),
	} {
		t.Setenv("PATH", path)
		got, err := resolveReal("gtool")
		if err != nil || got != filepath.Join(real, "gtool") {
			t.Errorf("PATH=%s: %q %v, want %s", path, got, err, filepath.Join(real, "gtool"))
		}
	}
	t.Setenv("PATH", shim)
	if got, err := resolveReal("gtool"); err == nil {
		t.Errorf("only the shim on PATH: resolved %q, want an error", got)
	}
	if got, _ := resolveReal("./bin/gtool"); got != "./bin/gtool" {
		t.Errorf("explicit path: %q", got)
	}
}

// TestWithShims: one symlink per gated basename to effigentd itself, the shim
// dir first on PATH, EFFIGENT_AGENT / EFFIGENT_SHIM_DIR replaced.
func TestWithShims(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", base)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	self, _ = filepath.EvalSymlinks(self)

	env := []string{"HOME=/home/grok-bot", "PATH=/usr/local/bin:/usr/bin", "EFFIGENT_AGENT=old", "EFFIGENT_SHIM_DIR=/stale"}
	out := withShims("grok-bot", []string{"/usr/bin/terraform", "/opt/tf/terraform", "/usr/local/bin/kubectl"}, env)
	vars := map[string][]string{}
	for _, kv := range out {
		k, v, _ := strings.Cut(kv, "=")
		vars[k] = append(vars[k], v)
	}
	dirs := vars["EFFIGENT_SHIM_DIR"]
	if len(dirs) != 1 || filepath.Dir(dirs[0]) != base || !strings.HasPrefix(filepath.Base(dirs[0]), "effigent-shims-") {
		t.Fatalf("EFFIGENT_SHIM_DIR %q", dirs)
	}
	dir := dirs[0]
	if got := vars["EFFIGENT_AGENT"]; len(got) != 1 || got[0] != "grok-bot" {
		t.Errorf("EFFIGENT_AGENT %q", got)
	}
	if got := vars["PATH"]; len(got) != 1 || got[0] != dir+string(os.PathListSeparator)+"/usr/local/bin:/usr/bin" {
		t.Errorf("PATH %q", got)
	}
	if got := vars["HOME"]; len(got) != 1 || got[0] != "/home/grok-bot" {
		t.Errorf("HOME %q", got)
	}
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
		if target, err := os.Readlink(filepath.Join(dir, e.Name())); err != nil || target != self {
			t.Errorf("%s -> %q (%v), want %s", e.Name(), target, err, self)
		}
	}
	if strings.Join(names, ",") != "kubectl,terraform" {
		t.Errorf("shims %q", names)
	}

	// the gate run from a shim finds the real binary, not the shim
	real := filepath.Join(t.TempDir(), "kubectl")
	writeExe(t, real, "echo real")
	t.Setenv("EFFIGENT_SHIM_DIR", dir)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+filepath.Dir(real))
	if got, err := resolveReal("kubectl"); err != nil || got != real {
		t.Errorf("resolveReal through the shim env: %q %v", got, err)
	}

	// no PATH: a default one after the shim dir
	out = withShims("grok-bot", []string{"/usr/bin/terraform"}, []string{"HOME=/h"})
	for _, kv := range out {
		if p, ok := strings.CutPrefix(kv, "PATH="); ok && !strings.HasSuffix(p, string(os.PathListSeparator)+"/usr/local/bin:/usr/bin:/bin") {
			t.Errorf("default PATH %q", p)
		}
	}
	if !hasPrefix(out, "PATH=") {
		t.Error("no PATH added")
	}

	// nothing gated: env unchanged, no dir left behind
	before, _ := os.ReadDir(base)
	if got := withShims("grok-bot", nil, env); strings.Join(got, "\n") != strings.Join(env, "\n") {
		t.Errorf("nothing gated changed env: %q", got)
	}
	if after, _ := os.ReadDir(base); len(after) != len(before) {
		t.Errorf("nothing gated left a dir: %d -> %d entries", len(before), len(after))
	}
}

// TestGateChild is the gate process TestRunGate starts; it does nothing in a
// normal test run.
func TestGateChild(t *testing.T) {
	args := os.Getenv("EFFIGENT_GATE_TEST_ARGS")
	if args == "" {
		t.Skip("helper process")
	}
	var argv []string
	if err := json.Unmarshal([]byte(args), &argv); err != nil {
		t.Fatal(err)
	}
	gateCmd(argv) // execs the command or exits
	t.Fatal("gateCmd returned")
}

// TestRunGate runs `effigentd gate` end to end in a child process: the
// daemon's answer decides, an allowed command execs the real binary with its
// arguments intact, and every failure to get an answer refuses.
func TestRunGate(t *testing.T) {
	root := t.TempDir()
	shim, real := filepath.Join(root, "shim"), filepath.Join(root, "real")
	writeExe(t, filepath.Join(shim, "gtool"), "echo shim")
	writeExe(t, filepath.Join(real, "gtool"), `printf 'real'; printf ' [%s]' "$@"`)

	var mu sync.Mutex
	var gotPath, gotCommand, gotUser string
	allow := true
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Command, Cwd string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		gotPath, gotCommand, gotUser = r.URL.Path, body.Command, r.Header.Get("X-Effigent-OS-User")
		a := allow
		mu.Unlock()
		switch body.Command {
		case "gtool status-500":
			w.WriteHeader(http.StatusInternalServerError)
		case "gtool garbage":
			_, _ = w.Write([]byte("not json"))
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"allow": a, "reason": "Blocked by Effigent: gtool is gated"})
		}
	}))
	defer daemon.Close()
	addr := strings.TrimPrefix(daemon.URL, "http://")

	run := func(api string, argv ...string) (string, string, int) {
		t.Helper()
		b, _ := json.Marshal(argv)
		cmd := exec.Command(os.Args[0], "-test.run=^TestGateChild$")
		cmd.Env = append(os.Environ(), "EFFIGENT_GATE_TEST_ARGS="+string(b), "EFFIGENT_API="+api,
			"EFFIGENT_SHIM_DIR="+shim, "PATH="+shim+string(os.PathListSeparator)+real, "EFFIGENT_AGENT=")
		var stdout, stderr strings.Builder
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		return stdout.String(), stderr.String(), code
	}

	out, errOut, code := run(addr, "--agent", "grok-bot", "--", "gtool", "a b", "it's", "--flag")
	if code != 0 || out != "real [a b] [it's] [--flag]" {
		t.Fatalf("allowed: code %d stdout %q stderr %q", code, out, errOut)
	}
	mu.Lock()
	if gotPath != "/gate/grok-bot" || gotCommand != `gtool 'a b' 'it'\''s' --flag` || gotUser == "" {
		t.Errorf("daemon got %s %q user %q", gotPath, gotCommand, gotUser)
	}
	allow = false
	mu.Unlock()

	out, errOut, code = run(addr, "--", "gtool", "x")
	if code != 1 || out != "" || !strings.Contains(errOut, "gtool is gated") {
		t.Fatalf("denied: code %d stdout %q stderr %q", code, out, errOut)
	}
	mu.Lock()
	if gotPath != "/gate/claude" { // no agent named: the canonical one
		t.Errorf("default agent: %s", gotPath)
	}
	mu.Unlock()

	for _, argv := range [][]string{{"--", "gtool", "status-500"}, {"--", "gtool", "garbage"}} {
		out, errOut, code = run(addr, argv...)
		if code != 1 || out != "" || !strings.Contains(errOut, "could not decide") {
			t.Errorf("%q: code %d stdout %q stderr %q", argv, code, out, errOut)
		}
	}

	// nothing listening: refused
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := l.Addr().String()
	l.Close()
	out, errOut, code = run(dead, "--", "gtool")
	if code != 1 || out != "" || !strings.Contains(errOut, "not reachable") {
		t.Errorf("daemon down: code %d stdout %q stderr %q", code, out, errOut)
	}

	// not on PATH outside the shim dir: refused before asking
	out, errOut, code = run(addr, "--", "no-such-gtool")
	if code == 0 || out != "" || !strings.Contains(errOut, "not found on PATH") {
		t.Errorf("missing binary: code %d stdout %q stderr %q", code, out, errOut)
	}
}
