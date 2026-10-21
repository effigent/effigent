package hookstate

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCheck(t *testing.T) {
	dir := t.TempDir()
	put := func(rel, s string) string {
		p := filepath.Join(dir, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	bin := filepath.Join(dir, "bin")
	put("bin/codex", "")
	put("apps/Cursor.app/Contents/Info.plist", "")
	o := Options{
		Sensor:   "hooks",
		Claude:   put("claude.json", `{"hooks": {"PreToolUse": [{"matcher": ".*", "hooks": [{"command": "\"/x/effigentd\" hook claude"}]}]}}`),
		Codex:    filepath.Join(dir, "nope.toml"),
		Gemini:   put("gemini.json", `{"hooks": {`),
		Cur:      put("cursor.json", `{"version": 1, "hooks": {"beforeShellExecution": [{"command": "/opt/other.sh"}]}}`),
		PathDirs: []string{"", bin},
		Apps:     []string{filepath.Join(dir, "apps", "Cursor.app")},
	}
	r := Check(o)
	want := map[string]Agent{
		"claude": {State: Modified, Detail: "onFailure is no longer block (a crash or timeout would let the call run); it runs /x/effigentd, which doesn't exist"},
		"codex":  {State: Missing, Present: true, Detail: "the file doesn't exist"},
		"gemini": {State: Modified, Detail: "the file is not valid JSON"},
		"cursor": {State: Missing, Present: true, Detail: "no effigentd hooks"},
	}
	for name, w := range want {
		g := r.Agents[name]
		if g.State != w.State || g.Present != w.Present || g.Detail != w.Detail {
			t.Errorf("%s: got %+v, want %+v", name, g, w)
		}
	}
	if r.Sensor != "hooks" || r.Agents["claude"].File != o.Claude {
		t.Fatalf("report %+v", r)
	}

	if runtime.GOOS != "windows" && os.Getuid() != 0 {
		if err := os.Chmod(o.Claude, 0); err != nil {
			t.Fatal(err)
		}
		if a := checkClaude(o.Claude); a.State != Unreadable {
			t.Fatalf("unreadable %+v", a)
		}
	}
	// an empty file is a file without our hook
	if a := checkCursor(put("empty.json", "")); a.State != Missing {
		t.Fatalf("empty %+v", a)
	}
}

func TestHookCmd(t *testing.T) {
	for c, want := range map[string]bool{
		`"/usr/local/bin/effigentd" hook claude`:                true,
		`"C:\Program Files\Effigent\effigentd.exe" hook claude`: true,
		`/usr/local/bin/effigentd hook claude`:                  true,
		`/usr/local/bin/effigentd hook codex`:                   false,
		`/usr/local/bin/notus hook claude`:                      false,
	} {
		if IsHookCmd(c, "claude") != want {
			t.Errorf("%s: want %v", c, want)
		}
	}
}
