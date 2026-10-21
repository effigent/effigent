package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/hookstate"
)

// install-hooks writes what hookstate reads back as installed; edits a user
// or admin could make show up as modified / missing.
func TestInstallHooksRoundTrip(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "bin", "effigentd")
	if err := os.MkdirAll(filepath.Dir(self), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(self, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home", "dana")
	o := hookstate.Options{
		Sensor: "hooks",
		Claude: filepath.Join(dir, "claude", "managed-settings.json"),
		Codex:  filepath.Join(dir, "codex", "requirements.toml"),
		Gemini: filepath.Join(dir, "gemini", "settings.json"),
		Cur:    filepath.Join(dir, "cursor", "hooks.json"),
		Homes:  []string{home},
	}
	// an admin's own Cursor hook is kept
	writeTestFile(t, o.Cur, `{"version":1,"hooks":{"beforeShellExecution":[{"command":"/opt/audit.sh"}]}}`)
	install := func(remove bool) {
		t.Helper()
		for _, err := range []error{
			second(installClaude(o.Claude, hookCommand(self, "claude"), false, remove)),
			second(installCodex(o.Codex, hookCommand(self, "codex"), false, remove)),
			second(installGemini(o.Gemini, hookCommand(self, "gemini"), remove)),
			second(installCursor(o.Cur, hookCommand(self, "cursor"), remove)),
		} {
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	state := func() map[string]string {
		r := hookstate.Check(o)
		out := map[string]string{}
		for name, a := range r.Agents {
			out[name] = a.State
			if a.Detail != "" {
				out[name] += ": " + a.Detail
			}
		}
		return out
	}
	expect := func(agent, want string) {
		t.Helper()
		if got := state()[agent]; !strings.HasPrefix(got, want) {
			t.Fatalf("%s: got %q, want %q", agent, got, want)
		}
	}

	install(false)
	install(false) // idempotent
	for _, a := range []string{"claude", "codex", "gemini", "cursor"} {
		expect(a, hookstate.Installed)
	}
	var cur struct {
		Version int                         `json:"version"`
		Hooks   map[string][]map[string]any `json:"hooks"`
	}
	b, _ := os.ReadFile(o.Cur)
	if err := json.Unmarshal(b, &cur); err != nil {
		t.Fatal(err)
	}
	if cur.Version != 1 || len(cur.Hooks["beforeShellExecution"]) != 2 || len(cur.Hooks["preToolUse"]) != 1 ||
		cur.Hooks["preToolUse"][0]["failClosed"] != true || cur.Hooks["preToolUse"][0]["timeout"] != float64(hookTimeout) {
		t.Fatalf("cursor hooks.json %s", b)
	}

	// Cursor: failClosed switched off, one event dropped
	edit(t, o.Cur, func(m map[string]any) {
		h := m["hooks"].(map[string]any)
		delete(h, "beforeReadFile")
		h["preToolUse"].([]any)[0].(map[string]any)["failClosed"] = false
	})
	expect("cursor", hookstate.Modified+": no effigentd hook for beforeReadFile; preToolUse no longer has failClosed")

	// Claude: a drop-in turns every hook off
	writeTestFile(t, filepath.Join(filepath.Dir(o.Claude), "managed-settings.d", "50-x.json"), `{"disableAllHooks":true}`)
	expect("claude", hookstate.Modified+": disableAllHooks is set in")

	// Gemini: a user's /hooks disable effigent
	writeTestFile(t, filepath.Join(home, ".gemini", "settings.json"), `{"hooksConfig":{"disabled":["effigent"]}}`)
	if g := hookstate.Check(o).Agents["gemini"]; g.State != hookstate.Installed || len(g.DisabledBy) != 1 || g.DisabledBy[0] != "dana" {
		t.Fatalf("gemini %+v", g)
	}

	// Codex: the pin is gone
	writeTestFile(t, o.Codex, strings.ReplaceAll(readTestFile(t, o.Codex), "hooks = true", "hooks = false"))
	expect("codex", hookstate.Modified+": [features] hooks = true is no longer pinned")

	// effigentd moved away: every hook points at nothing
	if err := os.Remove(self); err != nil {
		t.Fatal(err)
	}
	expect("gemini", hookstate.Modified+": it runs "+self+", which doesn't exist")

	install(true)
	for _, a := range []string{"claude", "codex", "gemini", "cursor"} {
		expect(a, hookstate.Missing)
	}
	if b := readTestFile(t, o.Cur); !strings.Contains(b, "/opt/audit.sh") || strings.Contains(b, "effigentd") {
		t.Fatalf("cursor after remove %s", b)
	}
}

func second(_ string, err error) error { return err }

func writeTestFile(t *testing.T, file, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readTestFile(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func edit(t *testing.T, file string, f func(map[string]any)) {
	t.Helper()
	m := map[string]any{}
	if err := json.Unmarshal([]byte(readTestFile(t, file)), &m); err != nil {
		t.Fatal(err)
	}
	f(m)
	b, _ := json.Marshal(m)
	writeTestFile(t, file, string(b))
}
