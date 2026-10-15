package hooks

import (
	"encoding/json"
	"path"
	"regexp"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

// Codex CLI (PreToolUse, 0.124+) and Gemini CLI (BeforeTool, 0.27+) hooks.
// Their tool calls are translated into Claude Code's canonical tool names and
// inputs (Bash {command}, Read/Write/Edit {file_path}, WebFetch {url},
// mcp__<server>__<tool>), so one policy — deny and approval lists alike —
// and one evaluator cover every agent.

// Call is one agent tool call: as the agent sent it, and as canonical inputs
// (one per file of a multi-file edit, per URL of a fetch).
type Call struct {
	Orig  ClaudeInput
	Canon []ClaudeInput
}

// FromClaude wraps a Claude Code call (already canonical).
func FromClaude(in ClaudeInput) Call { return Call{Orig: in, Canon: []ClaudeInput{in}} }

// ParseCodex reads Codex's PreToolUse payload. It has Claude Code's shape;
// shell commands arrive as "Bash", file edits as "apply_patch" with the patch
// in tool_input.command, MCP tools as mcp__<server>__<tool>.
func ParseCodex(raw []byte) (Call, error) {
	var in ClaudeInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return Call{}, err
	}
	c := Call{Orig: in}
	switch in.ToolName {
	case "apply_patch":
		patch := str(in.ToolInput, "command")
		if patch == "" {
			patch = str(in.ToolInput, "patch")
		}
		files := patchFiles(patch)
		for _, f := range files {
			c.Canon = append(c.Canon, ClaudeInput{SessionID: in.SessionID, Cwd: in.Cwd, ToolName: "Edit",
				ToolInput: map[string]any{"file_path": f}})
		}
		if len(files) == 0 {
			c.Canon = []ClaudeInput{{SessionID: in.SessionID, Cwd: in.Cwd, ToolName: "Edit", ToolInput: map[string]any{}}}
		}
	default:
		c.Canon = []ClaudeInput{in}
	}
	return c, nil
}

// patchFiles lists the files an apply_patch body adds, updates, moves or deletes.
func patchFiles(patch string) []string {
	var out []string
	for _, line := range strings.Split(patch, "\n") {
		line = strings.TrimRight(line, "\r")
		for _, p := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "} {
			if f, ok := strings.CutPrefix(line, p); ok && strings.TrimSpace(f) != "" {
				out = append(out, strings.TrimSpace(f))
			}
		}
	}
	return out
}

// GeminiInput is the part of Gemini CLI's BeforeTool payload effigentd uses.
type GeminiInput struct {
	SessionID  string         `json:"session_id"`
	Cwd        string         `json:"cwd"`
	ToolName   string         `json:"tool_name"`
	ToolInput  map[string]any `json:"tool_input"`
	MCPContext *struct {
		ServerName string `json:"server_name"`
		ToolName   string `json:"tool_name"`
	} `json:"mcp_context"`
}

var urlRE = regexp.MustCompile(`https?://[^\s"'<>)\]]+`)

// ParseGemini reads Gemini CLI's BeforeTool payload and maps its tools
// (run_shell_command, read_file, write_file, replace, web_fetch, mcp_<server>_<tool>, …).
func ParseGemini(raw []byte) (Call, error) {
	var g GeminiInput
	if err := json.Unmarshal(raw, &g); err != nil {
		return Call{}, err
	}
	if g.ToolInput == nil {
		g.ToolInput = map[string]any{}
	}
	orig := ClaudeInput{SessionID: g.SessionID, Cwd: g.Cwd, ToolName: g.ToolName, ToolInput: g.ToolInput}
	c := Call{Orig: orig}
	one := func(tool string, input map[string]any) {
		c.Canon = append(c.Canon, ClaudeInput{SessionID: g.SessionID, Cwd: g.Cwd, ToolName: tool, ToolInput: input})
	}
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := str(g.ToolInput, k); v != "" {
				return v
			}
		}
		return ""
	}
	switch g.ToolName {
	case "run_shell_command":
		if d := first("dir_path", "directory"); d != "" {
			if !strings.HasPrefix(d, "/") && !isDrive(d) {
				d = path.Join(g.Cwd, d)
			}
			c.Canon = []ClaudeInput{{SessionID: g.SessionID, Cwd: d, ToolName: "Bash", ToolInput: map[string]any{"command": first("command")}}}
		} else {
			one("Bash", map[string]any{"command": first("command")})
		}
	case "read_file":
		one("Read", map[string]any{"file_path": first("file_path", "absolute_path", "path")})
	case "read_many_files":
		var paths []string
		for _, k := range []string{"paths", "include"} {
			if l, ok := g.ToolInput[k].([]any); ok {
				for _, v := range l {
					if s, ok := v.(string); ok && s != "" {
						paths = append(paths, s)
					}
				}
			}
		}
		for _, p := range paths {
			one("Read", map[string]any{"file_path": p})
		}
	case "write_file":
		one("Write", map[string]any{"file_path": first("file_path", "absolute_path", "path")})
	case "replace":
		one("Edit", map[string]any{"file_path": first("file_path", "absolute_path", "path")})
	case "list_directory":
		one("LS", map[string]any{"path": first("dir_path", "path", "directory")})
	case "glob":
		one("Glob", map[string]any{"pattern": first("pattern"), "path": first("dir_path", "path")})
	case "grep_search", "search_file_content":
		one("Grep", map[string]any{"pattern": first("pattern"), "path": first("dir_path", "path")})
	case "web_fetch":
		urls := urlRE.FindAllString(first("prompt", "url"), 20)
		for _, u := range urls {
			one("WebFetch", map[string]any{"url": strings.TrimRight(u, ".,;:!?")})
		}
	case "google_web_search":
		one("WebSearch", map[string]any{"query": first("query")})
	default:
		if g.MCPContext != nil && g.MCPContext.ServerName != "" {
			// one naming for MCP tools across agents: mcp__<server>__<tool>
			one("mcp__"+g.MCPContext.ServerName+"__"+g.MCPContext.ToolName, g.ToolInput)
		} else {
			one(g.ToolName, g.ToolInput)
		}
	}
	if len(c.Canon) == 0 {
		one(g.ToolName, g.ToolInput)
	}
	return c, nil
}

// EvaluateCall decides a call that may span several canonical inputs: the
// most severe decision wins (deny, then approval, then a report).
func EvaluateCall(eval ClaudeEvaluator, rule policy.Rule, c Call) Decision {
	var best Decision
	rank := func(d Decision) int {
		switch {
		case d.Deny:
			return 4
		case d.Approve:
			return 3
		case d.Report == "would_block":
			return 2
		case d.Report != "":
			return 1
		}
		return 0
	}
	for _, in := range c.Canon {
		if d := eval(rule, in); rank(d) > rank(best) {
			best = d
		}
	}
	return best
}

// Summary describes a call for events and approvers.
func (c Call) Summary() string {
	if len(c.Canon) == 0 {
		return Summary(c.Orig)
	}
	// "Edit: a.go, b.go" for a multi-file patch
	s := Summary(c.Canon[0])
	for _, in := range c.Canon[1:] {
		_, target, _ := strings.Cut(Summary(in), ": ")
		s += ", " + target
	}
	return s
}

// GeminiOutput renders a Decision for Gemini CLI's BeforeTool hook. Nothing
// to say is "{}" (stdout must be JSON; plain text would show as a message).
func GeminiOutput(d Decision) []byte {
	if !d.Deny {
		return []byte("{}")
	}
	b, _ := json.Marshal(map[string]any{"decision": "deny", "reason": d.Reason})
	return b
}

// GeminiFailClosed is what `effigentd hook gemini` prints when it can't get a decision.
func GeminiFailClosed(why string) []byte {
	return GeminiOutput(Decision{Deny: true,
		Reason: "Blocked by Effigent: " + why + ". Ask your IT team, or check: effigentd status"})
}
