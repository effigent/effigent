package hooks

import (
	"encoding/json"
	"strings"
)

// GitHub Copilot's hooks (.github/hooks/*.json; the cloud agent loads them
// from the repository's default branch). Two spellings of the same event:
//
//   - "preToolUse" sends {sessionId, timestamp, cwd, toolName, toolArgs},
//     toolArgs being the arguments as a JSON string, with Copilot's own tool
//     names (bash, view, edit, create, glob, grep, web_fetch, powershell…).
//   - "PreToolUse" sends Claude Code's shape {session_id, cwd, tool_name,
//     tool_input} with Claude Code's tool names.
//
// Either way the answer is {"permissionDecision": "deny",
// "permissionDecisionReason": …}. Copilot documents the tool names but not
// their argument fields: the ones read below (command, path, file_path, url,
// pattern) are the likely spellings and are not verified against a live
// agent (docs/cloud-agents.md).

type copilotInput struct {
	SessionID  string          `json:"sessionId"`
	SessionID2 string          `json:"session_id"`
	Cwd        string          `json:"cwd"`
	ToolName   string          `json:"toolName"`
	ToolName2  string          `json:"tool_name"`
	ToolArgs   json.RawMessage `json:"toolArgs"`
	ToolInput  json.RawMessage `json:"tool_input"`
}

// ParseCopilot reads either payload and maps Copilot's tools to the
// canonical ones (bash/powershell → Bash, view → Read, create → Write,
// edit → Edit, web_fetch → WebFetch, glob → Glob, grep → Grep).
func ParseCopilot(raw []byte) (Call, error) {
	var in copilotInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return Call{}, err
	}
	session, tool := first2(in.SessionID, in.SessionID2), first2(in.ToolName, in.ToolName2)
	args := in.ToolArgs
	if len(args) == 0 {
		args = in.ToolInput
	}
	input := map[string]any{}
	if len(args) > 0 {
		var s string
		if json.Unmarshal(args, &s) == nil {
			_ = json.Unmarshal([]byte(s), &input) // preToolUse: the arguments as a string
		} else {
			_ = json.Unmarshal(args, &input)
		}
		if input == nil {
			input = map[string]any{}
		}
	}
	orig := ClaudeInput{SessionID: session, Cwd: in.Cwd, ToolName: tool, ToolInput: input}
	c := Call{Orig: orig}
	one := func(tool string, input map[string]any) {
		c.Canon = append(c.Canon, ClaudeInput{SessionID: session, Cwd: in.Cwd, ToolName: tool, ToolInput: input})
	}
	pick := func(keys ...string) string {
		for _, k := range keys {
			if v := str(input, k); v != "" {
				return v
			}
		}
		return ""
	}
	switch strings.ToLower(tool) {
	case "bash", "powershell", "shell":
		one("Bash", map[string]any{"command": pick("command", "cmd", "script")})
	case "view", "read":
		one("Read", map[string]any{"file_path": pick("file_path", "path", "filePath")})
	case "create", "write":
		one("Write", map[string]any{"file_path": pick("file_path", "path", "filePath")})
	case "edit", "str_replace", "multiedit":
		one("Edit", map[string]any{"file_path": pick("file_path", "path", "filePath")})
	case "web_fetch", "webfetch", "fetch":
		one("WebFetch", map[string]any{"url": pick("url")})
	case "glob":
		one("Glob", map[string]any{"pattern": pick("pattern"), "path": pick("path")})
	case "grep":
		one("Grep", map[string]any{"pattern": pick("pattern"), "path": pick("path")})
	default:
		one(tool, input) // Claude Code names (PreToolUse), MCP tools, task, ask_user…
	}
	return c, nil
}

func first2(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// CopilotOutput renders a Decision for Copilot's preToolUse hook. Allowing
// says nothing ("{}"). The deny also carries Claude Code's hookSpecificOutput
// form, which the PascalCase PreToolUse event reads.
func CopilotOutput(d Decision) []byte {
	if !d.Deny {
		return []byte("{}")
	}
	b, _ := json.Marshal(map[string]any{
		"permissionDecision": "deny", "permissionDecisionReason": d.Reason,
		"hookSpecificOutput": map[string]any{"hookEventName": "PreToolUse", "permissionDecision": "deny",
			"permissionDecisionReason": d.Reason},
	})
	return b
}

// CopilotFailClosed is what `effigentd hook copilot` prints when it can't
// get a decision.
func CopilotFailClosed(why string) []byte {
	return CopilotOutput(Decision{Deny: true, Reason: "Blocked by Effigent: " + why + ". Ask your IT team."})
}
