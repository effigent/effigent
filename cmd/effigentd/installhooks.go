package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
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

// installHooksCmd implements `effigentd install-hooks`: adds effigentd's
// PreToolUse hook to Claude Code's managed settings, keeping everything else
// in the file. Re-running replaces our entry instead of adding a second one.
func installHooksCmd(args []string) {
	fs := flag.NewFlagSet("install-hooks", flag.ExitOnError)
	file := fs.String("file", managedSettingsPath(), "Claude Code managed settings file")
	exclusive := fs.Bool("exclusive", false, "also set allowManagedHooksOnly (users' own hooks stop running)")
	remove := fs.Bool("remove", false, "remove effigentd's hook instead of adding it")
	_ = fs.Parse(args)

	self, err := os.Executable()
	if err != nil {
		fatalf("%v", err)
	}
	command := fmt.Sprintf("%q hook claude", self)

	settings := map[string]any{}
	if b, err := os.ReadFile(*file); err == nil && len(b) > 0 {
		if err := json.Unmarshal(b, &settings); err != nil {
			fatalf("%s is not valid JSON (%v); fix or move it first", *file, err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		fatalf("%v", err)
	}

	hooksMap, _ := settings["hooks"].(map[string]any)
	if hooksMap == nil {
		hooksMap = map[string]any{}
	}
	var kept []any
	if groups, ok := hooksMap["PreToolUse"].([]any); ok {
		for _, g := range groups {
			if !isOurs(g) {
				kept = append(kept, g)
			}
		}
	}
	if !*remove {
		kept = append(kept, map[string]any{
			"matcher": ".*", // a regex: a bare "*" is not valid and matches nothing
			"hooks": []any{map[string]any{
				"type": "command", "command": command,
				// The daemon answers in milliseconds; this bounds a hung daemon.
				"timeout": 30,
				// A crash or timeout must not let the tool call through.
				"onFailure":     "block",
				"statusMessage": "Checking with Effigent",
			}},
		})
	}
	if len(kept) > 0 {
		hooksMap["PreToolUse"] = kept
	} else {
		delete(hooksMap, "PreToolUse")
	}
	if len(hooksMap) > 0 {
		settings["hooks"] = hooksMap
	} else {
		delete(settings, "hooks")
	}
	if *exclusive && !*remove {
		settings["allowManagedHooksOnly"] = true
	}

	if err := os.MkdirAll(filepath.Dir(*file), 0o755); err != nil {
		fatalf("%v (run as administrator / with sudo)", err)
	}
	out, _ := json.MarshalIndent(settings, "", "  ")
	tmp := *file + ".effigent-tmp"
	if err := os.WriteFile(tmp, append(out, '\n'), 0o644); err != nil {
		fatalf("%v (run as administrator / with sudo)", err)
	}
	if err := os.Rename(tmp, *file); err != nil {
		fatalf("%v", err)
	}
	if *remove {
		fmt.Printf("removed effigentd's Claude Code hook from %s\n", *file)
	} else {
		fmt.Printf("Claude Code will check every tool call with effigentd (%s)\n", *file)
	}
}

// isOurs reports whether a PreToolUse group runs `effigentd hook claude`.
func isOurs(g any) bool {
	m, _ := g.(map[string]any)
	hs, _ := m["hooks"].([]any)
	for _, h := range hs {
		hm, _ := h.(map[string]any)
		if c, _ := hm["command"].(string); c != "" && containsHookCmd(c) {
			return true
		}
	}
	return false
}

func containsHookCmd(c string) bool {
	return len(c) >= len(" hook claude") && c[len(c)-len(" hook claude"):] == " hook claude" &&
		(filepath.Base(trimQuotes(c[:len(c)-len(" hook claude")])) == "effigentd" ||
			filepath.Base(trimQuotes(c[:len(c)-len(" hook claude")])) == "effigentd.exe")
}

func trimQuotes(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}
