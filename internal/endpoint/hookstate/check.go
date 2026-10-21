package hookstate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// Hook states.
const (
	Installed  = "installed"  // effigentd's hook is there, set up as install-hooks writes it
	Missing    = "missing"    // no effigentd hook in the file (or no file)
	Modified   = "modified"   // the hook is there but changed or switched off
	Unreadable = "unreadable" // the file exists but couldn't be read
)

// Agent is one agent's hook state.
type Agent struct {
	Present    bool     `json:"present"` // the agent's program was found on this machine
	State      string   `json:"state"`
	File       string   `json:"file"`
	Detail     string   `json:"detail,omitempty"`
	DisabledBy []string `json:"disabled_by,omitempty"` // users who turned the hook off in their own settings (Gemini CLI)
	// Outcomes: the post-tool hooks that record how calls end are all there.
	// Optional: their absence doesn't change State.
	Outcomes bool `json:"outcomes,omitempty"`
	// Gateway is whether the agent is pointed at effigentd's model gateway
	// (agents it can carry only).
	Gateway *Gateway `json:"gateway,omitempty"`
}

// Report is what effigentd sends the control plane, keyed by the agent names
// of `effigentd hook <agent>`.
type Report struct {
	Sensor string           `json:"sensor"` // tetragon | hooks
	Agents map[string]Agent `json:"agents"`
}

// Options says where to look. Default fills it for this machine.
type Options struct {
	Sensor                     string
	Claude, Codex, Gemini, Cur string   // the machine-wide files
	Homes                      []string // users' home directories (Gemini's per-user settings, agent installs)
	PathDirs                   []string // directories searched for agent programs
	Apps                       []string // Cursor app bundles / executables
	// The model gateway: its address (effigentd -gateway; "" when off) and
	// the Codex file install-gateway writes.
	GatewayAddr, CodexManaged string
}

// Default is this machine: the files install-hooks writes, every user's home
// (macOS /Users/*, Linux /home/* and /root, Windows C:\Users\*) and the usual
// install locations.
func Default(sensor string) Options {
	o := Options{Sensor: sensor, Claude: ClaudeFile(), Codex: CodexFile(), Gemini: GeminiFile(), Cur: CursorFile(),
		CodexManaged: CodexManagedFile()}
	switch runtime.GOOS {
	case "darwin":
		o.Homes, _ = filepath.Glob("/Users/*")
		o.Apps = []string{"/Applications/Cursor.app"}
	case "windows":
		o.Homes, _ = filepath.Glob(`C:\Users\*`)
	default:
		o.Homes, _ = filepath.Glob("/home/*")
		o.Homes = append(o.Homes, "/root")
		o.Apps = []string{"/usr/share/cursor/cursor", "/opt/Cursor/cursor", "/opt/cursor/cursor", "/usr/bin/cursor"}
	}
	o.Homes = slices.DeleteFunc(o.Homes, func(h string) bool { b := filepath.Base(h); return b == "Shared" || b == "Public" || b == "Default" })
	o.PathDirs = append(filepath.SplitList(os.Getenv("PATH")), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/snap/bin")
	for _, h := range o.Homes {
		o.PathDirs = append(o.PathDirs, filepath.Join(h, ".local", "bin"), filepath.Join(h, ".npm-global", "bin"),
			filepath.Join(h, ".claude", "local"), filepath.Join(h, ".bun", "bin"), filepath.Join(h, ".volta", "bin"),
			filepath.Join(h, "AppData", "Roaming", "npm"))
		nvm, _ := filepath.Glob(filepath.Join(h, ".nvm", "versions", "node", "*", "bin"))
		o.PathDirs = append(o.PathDirs, nvm...)
		o.Apps = append(o.Apps, filepath.Join(h, "Applications", "Cursor.app"), filepath.Join(h, "AppData", "Local", "Programs", "cursor", "Cursor.exe"),
			filepath.Join(h, ".local", "share", "cursor-agent"))
	}
	return o
}

// Check reads every agent's hook state. It only reads files.
func Check(o Options) Report {
	r := Report{Sensor: o.Sensor, Agents: map[string]Agent{
		"claude": checkClaude(o.Claude),
		"codex":  checkCodex(o.Codex),
		"gemini": checkGemini(o.Gemini, o.Homes),
		"cursor": checkCursor(o.Cur),
	}}
	for name, progs := range map[string][]string{"claude": {"claude"}, "codex": {"codex"}, "gemini": {"gemini"}, "cursor": {"cursor-agent", "cursor"}} {
		a := r.Agents[name]
		a.Present = found(o.PathDirs, progs)
		if name == "cursor" && !a.Present {
			a.Present = slices.ContainsFunc(o.Apps, exists)
		}
		r.Agents[name] = a
	}
	checkGateways(o, &r)
	return r
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func found(dirs, progs []string) bool {
	for _, d := range dirs {
		if d == "" {
			continue
		}
		for _, p := range progs {
			for _, ext := range []string{"", ".exe", ".cmd"} {
				if exists(filepath.Join(d, p+ext)) {
					return true
				}
			}
		}
	}
	return false
}

// read loads a JSON or TOML file; ok=false means the returned Agent already
// says why it can't be checked (missing / unreadable / modified).
func read(file string, isTOML bool) (map[string]any, Agent, bool) {
	a := Agent{File: file}
	b, err := os.ReadFile(file)
	switch {
	case errors.Is(err, os.ErrNotExist):
		a.State, a.Detail = Missing, "the file doesn't exist"
		return nil, a, false
	case err != nil:
		a.State, a.Detail = Unreadable, err.Error()
		return nil, a, false
	}
	m := map[string]any{}
	if isTOML {
		err = toml.Unmarshal(b, &m)
	} else if len(strings.TrimSpace(string(b))) > 0 {
		err = json.Unmarshal(b, &m)
	}
	if err != nil {
		// the agent can't use it either: our hook isn't in force
		a.State, a.Detail = Modified, "the file is not valid "+map[bool]string{true: "TOML", false: "JSON"}[isTOML]
		return nil, a, false
	}
	return m, a, true
}

// findOurs looks for effigentd's group under hooks.<event>.
func findOurs(m map[string]any, event, agent string) (group, hook map[string]any) {
	hooks, _ := m["hooks"].(map[string]any)
	for _, g := range list(hooks[event]) {
		if h, ok := ourHook(g, agent); ok {
			gm, _ := g.(map[string]any)
			return gm, h
		}
	}
	return nil, nil
}

// hasPost reports whether effigentd's hook is under every one of events.
func hasPost(m map[string]any, agent string, events []string) bool {
	for _, ev := range events {
		if _, h := findOurs(m, ev, agent); h == nil {
			return false
		}
	}
	return true
}

// binaryGone says when a hook command points at an effigentd that isn't there.
func binaryGone(cmd, agent string) string {
	if bin, ok := hookBinary(cmd, agent); ok && filepath.IsAbs(bin) && !exists(bin) {
		return "it runs " + bin + ", which doesn't exist"
	}
	return ""
}

func (a Agent) with(state string, why ...string) Agent {
	a.State = state
	if len(why) > 0 {
		a.Detail = strings.Join(why, "; ")
	}
	return a
}

// ---- Claude Code: managed-settings.json (+ managed-settings.d/*.json) ----

func checkClaude(file string) Agent {
	m, a, ok := read(file, false)
	if !ok {
		return a
	}
	a.Outcomes = hasPost(m, "claude", ClaudePostEvents)
	g, h := findOurs(m, "PreToolUse", "claude")
	if h == nil {
		return a.with(Missing, "no effigentd PreToolUse hook")
	}
	var why []string
	if g["matcher"] != ".*" && g["matcher"] != "*" && g["matcher"] != "" && g["matcher"] != nil {
		why = append(why, fmt.Sprintf("matcher is %v, not .*", g["matcher"]))
	}
	if h["onFailure"] != "block" {
		why = append(why, "onFailure is no longer block (a crash or timeout would let the call run)")
	}
	// Only managed settings can switch managed hooks off: the file itself or a drop-in.
	if m["disableAllHooks"] == true {
		why = append(why, "disableAllHooks is set")
	}
	drop, _ := filepath.Glob(filepath.Join(filepath.Dir(file), "managed-settings.d", "*.json"))
	for _, d := range drop {
		if b, err := os.ReadFile(d); err == nil {
			var dm map[string]any
			if json.Unmarshal(b, &dm) == nil && dm["disableAllHooks"] == true {
				why = append(why, "disableAllHooks is set in "+d)
			}
		}
	}
	if s := binaryGone(h["command"].(string), "claude"); s != "" {
		why = append(why, s)
	}
	if len(why) > 0 {
		return a.with(Modified, why...)
	}
	return a.with(Installed)
}

// ---- Codex: requirements.toml ----

func checkCodex(file string) Agent {
	m, a, ok := read(file, true)
	if !ok {
		return a
	}
	a.Outcomes = hasPost(m, "codex", CodexPostEvents)
	_, h := findOurs(m, "PreToolUse", "codex")
	if h == nil {
		return a.with(Missing, "no effigentd [[hooks.PreToolUse]]")
	}
	var why []string
	// without the pin a user's `[features] hooks = false` drops managed hooks
	if f, _ := m["features"].(map[string]any); f["hooks"] != true {
		why = append(why, "[features] hooks = true is no longer pinned")
	}
	if s := binaryGone(h["command"].(string), "codex"); s != "" {
		why = append(why, s)
	}
	if len(why) > 0 {
		return a.with(Modified, why...)
	}
	return a.with(Installed)
}

// ---- Gemini CLI: system settings.json, and each user's settings ----

// geminiHookName is the name install-hooks gives the hook; `/hooks disable
// effigent` adds it to hooksConfig.disabled (a list merged by union, so a
// user's entry wins over the system file).
const geminiHookName = "effigent"

func geminiDisabled(m map[string]any, cmd string) bool {
	hc, _ := m["hooksConfig"].(map[string]any)
	for _, d := range list(hc["disabled"]) {
		if s, _ := d.(string); s == geminiHookName || (cmd != "" && s == cmd) {
			return true
		}
	}
	return false
}

func checkGemini(file string, homes []string) Agent {
	m, a, ok := read(file, false)
	if !ok {
		return a
	}
	a.Outcomes = hasPost(m, "gemini", GeminiPostEvents)
	_, h := findOurs(m, "BeforeTool", "gemini")
	if h == nil {
		return a.with(Missing, "no effigentd BeforeTool hook")
	}
	cmd, _ := h["command"].(string)
	var why []string
	if h["name"] != geminiHookName {
		why = append(why, "the hook is no longer named "+geminiHookName)
	}
	// System settings are merged last: an explicit true here beats a user's false.
	if hc, _ := m["hooksConfig"].(map[string]any); hc["enabled"] != true {
		why = append(why, "hooksConfig.enabled is not true")
	}
	if geminiDisabled(m, cmd) {
		why = append(why, "hooksConfig.disabled lists it")
	}
	if s := binaryGone(cmd, "gemini"); s != "" {
		why = append(why, s)
	}
	// /hooks disable writes to the user's or the project's settings; users'
	// own files are read here (projects' .gemini/settings.json are not).
	for _, home := range homes {
		b, err := os.ReadFile(filepath.Join(home, ".gemini", "settings.json"))
		if err != nil {
			continue
		}
		var um map[string]any
		if json.Unmarshal(b, &um) == nil && geminiDisabled(um, cmd) {
			a.DisabledBy = append(a.DisabledBy, filepath.Base(home))
		}
	}
	sort.Strings(a.DisabledBy)
	if len(why) > 0 {
		return a.with(Modified, why...)
	}
	return a.with(Installed)
}

// ---- Cursor: enterprise hooks.json ----

func checkCursor(file string) Agent {
	m, a, ok := read(file, false)
	if !ok {
		return a
	}
	hooks, _ := m["hooks"].(map[string]any)
	a.Outcomes = true
	for _, ev := range CursorPostEvents {
		if !slices.ContainsFunc(list(hooks[ev]), func(e any) bool {
			em, _ := e.(map[string]any)
			c, _ := em["command"].(string)
			return IsHookCmd(c, "cursor")
		}) {
			a.Outcomes = false
		}
	}
	var have, missing, why []string
	for _, ev := range CursorEvents {
		var ours map[string]any
		for _, e := range list(hooks[ev]) {
			if em, _ := e.(map[string]any); em != nil {
				if c, _ := em["command"].(string); IsHookCmd(c, "cursor") {
					ours = em
				}
			}
		}
		if ours == nil {
			missing = append(missing, ev)
			continue
		}
		have = append(have, ev)
		if ours["failClosed"] != true {
			why = append(why, ev+" no longer has failClosed (a crash or timeout would let the call run)")
		}
		if s := binaryGone(ours["command"].(string), "cursor"); s != "" && !slices.Contains(why, s) {
			why = append(why, s)
		}
	}
	if len(have) == 0 {
		return a.with(Missing, "no effigentd hooks")
	}
	if len(missing) > 0 {
		why = append([]string{"no effigentd hook for " + strings.Join(missing, ", ")}, why...)
	}
	if len(why) > 0 {
		return a.with(Modified, why...)
	}
	return a.with(Installed)
}
