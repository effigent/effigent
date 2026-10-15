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

	"github.com/pelletier/go-toml/v2"
)

// managedSettingsPath is where Claude Code reads machine-wide settings that
// users can't override (IT/MDM-managed).
func managedSettingsPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/ClaudeCode/managed-settings.json"
	case "windows":
		return `C:\Program Files\ClaudeCode\managed-settings.json`
	default:
		return "/etc/claude-code/managed-settings.json"
	}
}

// codexRequirementsPath is Codex CLI's admin-managed requirements file
// (0.124+): hooks there are trusted, can't be disabled by the user, and a
// managed hook that fails to load stops Codex from starting.
func codexRequirementsPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(programData(), "OpenAI", "Codex", "requirements.toml")
	}
	return "/etc/codex/requirements.toml"
}

// geminiSystemSettingsPath is Gemini CLI's system settings file, applied
// after user and workspace settings.
func geminiSystemSettingsPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/GeminiCli/settings.json"
	case "windows":
		return filepath.Join(programData(), "gemini-cli", "settings.json")
	default:
		return "/etc/gemini-cli/settings.json"
	}
}

func programData() string {
	if pd := os.Getenv("ProgramData"); pd != "" {
		return pd
	}
	return `C:\ProgramData`
}

// hookTimeout: the daemon answers in milliseconds, except while a call waits
// for an approver (up to 90s; `effigentd hook` gives up at 100s).
const hookTimeout = 120

// installHooksCmd implements `effigentd install-hooks`: adds effigentd's
// pre-tool hook to each agent's machine-wide settings, keeping everything
// else in the files. Re-running replaces our entry instead of adding another.
func installHooksCmd(args []string) {
	fs := flag.NewFlagSet("install-hooks", flag.ExitOnError)
	agents := fs.String("agents", "claude,codex,gemini", "agents to hook (comma-separated: claude, codex, gemini)")
	claudeFile := fs.String("file", managedSettingsPath(), "Claude Code managed settings file")
	codexFile := fs.String("codex-file", codexRequirementsPath(), "Codex requirements file")
	geminiFile := fs.String("gemini-file", geminiSystemSettingsPath(), "Gemini CLI system settings file")
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
		case "":
			continue
		default:
			err = fmt.Errorf("unknown agent %q (claude, codex, gemini)", a)
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
		if !isOurs(g, agent) {
			kept = append(kept, g)
		}
	}
	return kept
}

// isOurs reports whether a hook group runs `effigentd hook <agent>`.
func isOurs(g any, agent string) bool {
	m, _ := g.(map[string]any)
	var hs []any
	switch v := m["hooks"].(type) {
	case []any:
		hs = v
	case []map[string]any:
		for _, h := range v {
			hs = append(hs, h)
		}
	}
	for _, h := range hs {
		hm, _ := h.(map[string]any)
		if c, _ := hm["command"].(string); c != "" && isHookCmd(c, agent) {
			return true
		}
	}
	return false
}

func isHookCmd(c, agent string) bool {
	bin, ok := strings.CutSuffix(c, " hook "+agent)
	if !ok {
		return false
	}
	base := filepath.Base(strings.ReplaceAll(trimQuotes(bin), `\`, "/"))
	return base == "effigentd" || base == "effigentd.exe"
}

func trimQuotes(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
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
