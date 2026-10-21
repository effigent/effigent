// Package hookstate knows where effigentd's agent hooks live (the
// machine-wide config files `effigentd install-hooks` writes) and reports,
// per agent, whether the hook is still there as installed, so the control
// plane can alert when one goes missing or is turned off.
package hookstate

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ClaudeFile is where Claude Code reads machine-wide settings that users
// can't override (IT/MDM-managed).
func ClaudeFile() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/ClaudeCode/managed-settings.json"
	case "windows":
		return `C:\Program Files\ClaudeCode\managed-settings.json`
	default:
		return "/etc/claude-code/managed-settings.json"
	}
}

// CodexFile is Codex CLI's admin-managed requirements file (0.124+): hooks
// there are trusted, can't be disabled by the user, and a managed hook that
// fails to load stops Codex from starting.
func CodexFile() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(ProgramData(), "OpenAI", "Codex", "requirements.toml")
	}
	return "/etc/codex/requirements.toml"
}

// CodexManagedFile is Codex's machine-wide managed defaults
// (managed_config.toml): applied over the user's config.toml and --config
// flags every time Codex starts. install-gateway sets openai_base_url there.
// On Windows Codex reads it from the user's ~/.codex, so there is no
// machine-wide file ("").
func CodexManagedFile() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	return "/etc/codex/managed_config.toml"
}

// GeminiFile is Gemini CLI's system settings file, applied after user and
// workspace settings.
func GeminiFile() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/GeminiCli/settings.json"
	case "windows":
		return filepath.Join(ProgramData(), "gemini-cli", "settings.json")
	default:
		return "/etc/gemini-cli/settings.json"
	}
}

// CursorFile is Cursor's enterprise hooks.json (IDE and CLI): its hooks run
// next to the team's, the project's and the user's, and a deny from any of
// them wins.
func CursorFile() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/Cursor/hooks.json"
	case "windows":
		return filepath.Join(ProgramData(), "Cursor", "hooks.json")
	default:
		return "/etc/cursor/hooks.json"
	}
}

func ProgramData() string {
	if pd := os.Getenv("ProgramData"); pd != "" {
		return pd
	}
	return `C:\ProgramData`
}

// CursorEvents are the Cursor hook events effigentd answers. preToolUse
// covers the tools the others don't (Write, Delete, Grep, WebFetch, …);
// calls a dedicated event also sees (Shell, Read, MCP) are left to it.
var CursorEvents = []string{"beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "preToolUse"}

// Post-tool events effigentd registers to record how each call ended
// (outcomes). They are optional: a missing one never makes the policy hook
// "modified" (Agent.Outcomes says whether they are all there).
var (
	ClaudePostEvents = []string{"PostToolUse", "PostToolUseFailure"}
	CodexPostEvents  = []string{"PostToolUse"}
	GeminiPostEvents = []string{"AfterTool"}
	CursorPostEvents = []string{"postToolUse", "postToolUseFailure"}
)

// GeminiResultHookName is the name of the Gemini CLI AfterTool hook.
const GeminiResultHookName = "effigent-outcomes"

// IsHookCmd reports whether a hook command runs `effigentd hook <agent>`.
func IsHookCmd(c, agent string) bool {
	_, ok := hookBinary(c, agent)
	return ok
}

// hookBinary is the effigentd path in a `"<path>" hook <agent>` command.
func hookBinary(c, agent string) (string, bool) {
	bin, ok := strings.CutSuffix(c, " hook "+agent)
	if !ok {
		return "", false
	}
	bin = trimQuotes(bin)
	base := filepath.Base(strings.ReplaceAll(bin, `\`, "/"))
	return bin, base == "effigentd" || base == "effigentd.exe"
}

func trimQuotes(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}

// IsOurs reports whether a hook group ({matcher, hooks: [{command}]}, the
// Claude Code / Codex / Gemini CLI shape) runs `effigentd hook <agent>`.
func IsOurs(g any, agent string) bool {
	_, ok := ourHook(g, agent)
	return ok
}

// ourHook returns effigentd's hook in a group.
func ourHook(g any, agent string) (map[string]any, bool) {
	m, _ := g.(map[string]any)
	for _, h := range list(m["hooks"]) {
		hm, _ := h.(map[string]any)
		if c, _ := hm["command"].(string); c != "" && IsHookCmd(c, agent) {
			return hm, true
		}
	}
	return nil, false
}

// list takes []any or go-toml's []map[string]any (arrays of tables).
func list(v any) []any {
	switch x := v.(type) {
	case []any:
		return x
	case []map[string]any:
		out := make([]any, 0, len(x))
		for _, m := range x {
			out = append(out, m)
		}
		return out
	}
	return nil
}
