package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/hookstate"
	"github.com/pelletier/go-toml/v2"
)

// hookTimeout: the daemon answers in milliseconds, except while a call waits
// for an approver (up to 90s; `effigentd hook` gives up at 100s).
const hookTimeout = 120

// installHooksCmd implements `effigentd install-hooks`: adds effigentd's
// pre-tool hook to each agent's machine-wide settings, keeping everything
// else in the files. Re-running replaces our entry instead of adding another.
func installHooksCmd(args []string) {
	fs := flag.NewFlagSet("install-hooks", flag.ExitOnError)
	agents := fs.String("agents", "claude,codex,gemini,cursor", "agents to hook (comma-separated: claude, codex, gemini, cursor)")
	claudeFile := fs.String("file", hookstate.ClaudeFile(), "Claude Code managed settings file")
	codexFile := fs.String("codex-file", hookstate.CodexFile(), "Codex requirements file")
	geminiFile := fs.String("gemini-file", hookstate.GeminiFile(), "Gemini CLI system settings file")
	cursorFile := fs.String("cursor-file", hookstate.CursorFile(), "Cursor enterprise hooks.json")
	exclusive := fs.Bool("exclusive", false, "also make the agents ignore users' own hooks (Claude Code, Codex)")
	remove := fs.Bool("remove", false, "remove effigentd's hooks instead of adding them")
	_ = fs.Parse(args)

	self, err := os.Executable()
	if err != nil {
		fatalf("%v", err)
	}
	failed := false
	for _, a := range strings.Split(*agents, ",") {
		var msg string
		var err error
		switch a = strings.TrimSpace(a); a {
		case "claude":
			msg, err = installClaude(*claudeFile, hookCommand(self, a), *exclusive, *remove)
		case "codex":
			msg, err = installCodex(*codexFile, hookCommand(self, a), *exclusive, *remove)
		case "gemini":
			msg, err = installGemini(*geminiFile, hookCommand(self, a), *remove)
		case "cursor":
			msg, err = installCursor(*cursorFile, hookCommand(self, a), *remove)
		case "":
			continue
		default:
			err = fmt.Errorf("unknown agent %q (claude, codex, gemini, cursor)", a)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "effigentd: %s: %v\n", a, err)
			failed = true
			continue
		}
		fmt.Println(msg)
	}
	if failed {
		os.Exit(1)
	}
}

func hookCommand(self, agent string) string {
	if runtime.GOOS == "windows" {
		return `"` + self + `" hook ` + agent
	}
	return fmt.Sprintf("%q hook %s", self, agent)
}

// ---- Claude Code: managed-settings.json, hooks.PreToolUse ----

func installClaude(file, command string, exclusive, remove bool) (string, error) {
	settings, err := readJSON(file)
	if err != nil {
		return "", err
	}
	hooksMap, _ := settings["hooks"].(map[string]any)
	if hooksMap == nil {
		hooksMap = map[string]any{}
	}
	kept := withoutOurs(hooksMap["PreToolUse"], "claude")
	if !remove {
		kept = append(kept, map[string]any{
			"matcher": ".*", // a regex: a bare "*" is not valid and matches nothing
			"hooks": []any{map[string]any{
				"type": "command", "command": command, "timeout": hookTimeout,
				// A crash or timeout must not let the tool call through.
				"onFailure":     "block",
				"statusMessage": "Checking with Effigent",
			}},
		})
	}
	setOrDelete(hooksMap, "PreToolUse", kept)
	setOrDelete(settings, "hooks", hooksMap)
	if exclusive && !remove {
		settings["allowManagedHooksOnly"] = true
	}
	if err := writeJSON(file, settings); err != nil {
		return "", err
	}
	if remove {
		return "removed effigentd's Claude Code hook from " + file, nil
	}
	return "Claude Code will check every tool call with effigentd (" + file + ")", nil
}

// ---- Codex CLI: requirements.toml, [[hooks.PreToolUse]] ----

func installCodex(file, command string, exclusive, remove bool) (string, error) {
	req := map[string]any{}
	b, err := os.ReadFile(file)
	switch {
	case err == nil && len(b) > 0:
		if err := toml.Unmarshal(b, &req); err != nil {
			return "", fmt.Errorf("%s is not valid TOML (%v); fix or move it first", file, err)
		}
		// Rewriting drops comments: keep the admin's original once.
		if _, err := os.Stat(file + ".effigent-backup"); errors.Is(err, os.ErrNotExist) {
			_ = os.WriteFile(file+".effigent-backup", b, 0o644)
		}
	case err != nil && !errors.Is(err, os.ErrNotExist):
		return "", err
	}
	hooksMap, _ := req["hooks"].(map[string]any)
	if hooksMap == nil {
		hooksMap = map[string]any{}
	}
	kept := withoutOurs(hooksMap["PreToolUse"], "codex")
	if !remove {
		kept = append(kept, map[string]any{
			"matcher": "*",
			"hooks": []any{map[string]any{
				"type": "command", "command": command, "timeout": hookTimeout,
				"statusMessage": "Checking with Effigent",
			}},
		})
		// A user turning hooks off would drop managed hooks too: pin it.
		features, _ := req["features"].(map[string]any)
		if features == nil {
			features = map[string]any{}
		}
		features["hooks"] = true
		req["features"] = features
		if exclusive {
			req["allow_managed_hooks_only"] = true
		}
	}
	setOrDelete(hooksMap, "PreToolUse", kept)
	setOrDelete(req, "hooks", hooksMap)
	out, err := toml.Marshal(req)
	if err != nil {
		return "", err
	}
	if err := writeFile(file, out); err != nil {
		return "", err
	}
	if remove {
		return "removed effigentd's Codex hook from " + file, nil
	}
	return "Codex (0.124+) will check every tool call with effigentd (" + file + ")", nil
}

// ---- Gemini CLI: system settings.json, hooks.BeforeTool ----

func installGemini(file, command string, remove bool) (string, error) {
	settings, err := readJSON(file)
	if err != nil {
		return "", err
	}
	hooksMap, _ := settings["hooks"].(map[string]any)
	if hooksMap == nil {
		hooksMap = map[string]any{}
	}
	kept := withoutOurs(hooksMap["BeforeTool"], "gemini")
	if !remove {
		kept = append(kept, map[string]any{
			"matcher": "*",
			"hooks": []any{map[string]any{
				"name": "effigent", "type": "command", "command": command,
				"timeout":     hookTimeout * 1000, // milliseconds
				"description": "Effigent: checks each tool call against your organization's policy",
			}},
		})
		// System settings are applied last, so this keeps hooks on.
		hc, _ := settings["hooksConfig"].(map[string]any)
		if hc == nil {
			hc = map[string]any{}
		}
		hc["enabled"] = true
		settings["hooksConfig"] = hc
	}
	setOrDelete(hooksMap, "BeforeTool", kept)
	setOrDelete(settings, "hooks", hooksMap)
	if err := writeJSON(file, settings); err != nil {
		return "", err
	}
	if remove {
		return "removed effigentd's Gemini CLI hook from " + file, nil
	}
	return "Gemini CLI (0.27+) will check every tool call with effigentd (" + file + ")", nil
}

// ---- Cursor: enterprise hooks.json (IDE and CLI) ----

func installCursor(file, command string, remove bool) (string, error) {
	cfg, err := readJSON(file)
	if err != nil {
		return "", err
	}
	if _, ok := cfg["version"]; !ok {
		cfg["version"] = 1
	}
	hooksMap, _ := cfg["hooks"].(map[string]any)
	if hooksMap == nil {
		hooksMap = map[string]any{}
	}
	for _, ev := range hookstate.CursorEvents {
		var kept []any
		list, _ := hooksMap[ev].([]any)
		for _, h := range list {
			if hm, _ := h.(map[string]any); hm != nil {
				if c, _ := hm["command"].(string); hookstate.IsHookCmd(c, "cursor") {
					continue
				}
			}
			kept = append(kept, h)
		}
		if !remove {
			// failClosed: a crash, timeout or empty answer blocks the call
			// (Cursor's default is to let it run).
			kept = append(kept, map[string]any{"command": command, "timeout": hookTimeout, "failClosed": true})
		}
		setOrDelete(hooksMap, ev, kept)
	}
	setOrDelete(cfg, "hooks", hooksMap)
	if err := writeJSON(file, cfg); err != nil {
		return "", err
	}
	if remove {
		return "removed effigentd's Cursor hooks from " + file, nil
	}
	return "Cursor will check shell commands, MCP calls, file reads and other tool calls with effigentd (" + file + ")", nil
}

// ---- helpers ----

// withoutOurs returns an event's hook groups minus the ones running
// `effigentd hook <agent>`.
func withoutOurs(groups any, agent string) []any {
	var kept []any
	list, _ := groups.([]any)
	if list == nil { // go-toml decodes arrays of tables as []map[string]any
		if ms, ok := groups.([]map[string]any); ok {
			for _, m := range ms {
				list = append(list, m)
			}
		}
	}
	for _, g := range list {
		if !hookstate.IsOurs(g, agent) {
			kept = append(kept, g)
		}
	}
	return kept
}

func setOrDelete(m map[string]any, k string, v any) {
	switch x := v.(type) {
	case []any:
		if len(x) == 0 {
			delete(m, k)
			return
		}
	case map[string]any:
		if len(x) == 0 {
			delete(m, k)
			return
		}
	}
	m[k] = v
}

func readJSON(file string) (map[string]any, error) {
	settings := map[string]any{}
	b, err := os.ReadFile(file)
	if err == nil && len(b) > 0 {
		if err := json.Unmarshal(b, &settings); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON (%v); fix or move it first", file, err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return settings, nil
}

func writeJSON(file string, v any) error {
	out, _ := json.MarshalIndent(v, "", "  ")
	return writeFile(file, append(out, '\n'))
}

func writeFile(file string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return fmt.Errorf("%v (run as administrator / with sudo)", err)
	}
	tmp := file + ".effigent-tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return fmt.Errorf("%v (run as administrator / with sudo)", err)
	}
	return os.Rename(tmp, file)
}
