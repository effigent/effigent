package hooks

import (
	"bytes"
	"encoding/json"
	"path"
	"regexp"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

// Codex CLI (PreToolUse, 0.124+), Gemini CLI (BeforeTool, 0.27+) and Cursor
// (beforeShellExecution, beforeMCPExecution, beforeReadFile, preToolUse) hooks.
// Their tool calls are translated into Claude Code's canonical tool names and
// inputs (Bash {command}, Read/Write/Edit {file_path}, WebFetch {url},
// mcp__<server>__<tool>), so one policy — deny and approval lists alike —
// and one evaluator cover every agent.

// Call is one agent tool call: as the agent sent it, and as canonical inputs
// (one per file of a multi-file edit, per URL of a fetch).
type Call struct {
	Orig  ClaudeInput
	Canon []ClaudeInput
	// Skip: another hook event of the same agent checks this call (Cursor's
	// preToolUse for a shell command, a file read or an MCP tool); answer
	// allow and record nothing, so it isn't decided and counted twice.
	Skip bool
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
	var acts []event.Action
	var seen Seen
	dup := map[string]bool{}
	for _, in := range c.Canon {
		d := eval(rule, in)
		for _, a := range d.Actions {
			if k := a.Kind + "\x00" + a.Target + "\x00" + a.In; !dup[k] {
				dup[k] = true
				acts = append(acts, a)
			}
		}
		seen = seen.merge(d.Seen)
		if rank(d) > rank(best) {
			best = d
		}
	}
	best.Actions = acts
	best.Seen = seen
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

// ---- Cursor (IDE and CLI): enterprise hooks.json ----

// cursorInput is the part of Cursor's hook payloads effigentd uses. One
// command answers several events; hook_event_name tells them apart.
type cursorInput struct {
	Event          string   `json:"hook_event_name"`
	ConversationID string   `json:"conversation_id"`
	WorkspaceRoots []string `json:"workspace_roots"`
	Cwd            string   `json:"cwd"`
	Command        string   `json:"command"` // beforeShellExecution; beforeMCPExecution: a stdio server's launch command
	ToolName       string   `json:"tool_name"`
	ToolUseID      string   `json:"tool_use_id"` // preToolUse, postToolUse
	// an object for preToolUse, a JSON string for beforeMCPExecution
	ToolInput   json.RawMessage `json:"tool_input"`
	MCPServer   string          `json:"mcp_server_name"`
	FilePath    string          `json:"file_path"`
	Attachments []struct {
		Type     string `json:"type"`
		FilePath string `json:"file_path"`
	} `json:"attachments"`
}

// cursorBOM: Cursor on Windows starts the payload with a UTF-8 BOM.
func cursorBOM(raw []byte) []byte { return bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) }

// ParseCursor reads one of the Cursor hook events install-hooks registers
// and maps it onto Claude Code's tools:
//   - beforeShellExecution {command, cwd} → Bash
//   - beforeMCPExecution {tool_name, tool_input (JSON string), mcp_server_name} → mcp__<server>__<tool>
//   - beforeReadFile {file_path, attachments} → Read (the file and each attached file)
//   - preToolUse {tool_name, tool_input}: Write/Delete → Write, Grep, List → LS,
//     WebFetch/Fetch → WebFetch, WebSearch, others by name; Shell, Read and
//     MCP:<tool> are skipped (the events above check them, with more detail).
func ParseCursor(raw []byte) (Call, error) {
	var in cursorInput
	if err := json.Unmarshal(cursorBOM(raw), &in); err != nil {
		return Call{}, err
	}
	input := map[string]any{}
	if len(in.ToolInput) > 0 {
		var s string
		if json.Unmarshal(in.ToolInput, &s) == nil {
			_ = json.Unmarshal([]byte(s), &input) // beforeMCPExecution sends the arguments as a string
		} else {
			_ = json.Unmarshal(in.ToolInput, &input)
		}
		if input == nil {
			input = map[string]any{}
		}
	}
	cwd := in.Cwd
	if cwd == "" {
		cwd = str(input, "cwd")
	}
	if cwd == "" && len(in.WorkspaceRoots) > 0 {
		cwd = in.WorkspaceRoots[0]
	}
	orig := ClaudeInput{SessionID: in.ConversationID, Cwd: cwd, ToolName: in.ToolName, ToolInput: input, ToolUseID: in.ToolUseID}
	c := Call{Orig: orig}
	one := func(tool string, input map[string]any) {
		c.Canon = append(c.Canon, ClaudeInput{SessionID: in.ConversationID, Cwd: cwd, ToolName: tool, ToolInput: input})
	}
	switch in.Event {
	case "beforeShellExecution":
		c.Orig.ToolName, c.Orig.ToolInput = "Shell", map[string]any{"command": in.Command}
		one("Bash", map[string]any{"command": in.Command})
	case "beforeMCPExecution":
		server := in.MCPServer
		if server == "" {
			server = "unknown" // a tool_deny of mcp__unknown__* catches servers Cursor didn't name
		}
		c.Orig.ToolName = "MCP:" + in.ToolName
		one("mcp__"+server+"__"+in.ToolName, input)
	case "beforeReadFile", "beforeTabFileRead":
		c.Orig.ToolName, c.Orig.ToolInput = "Read", map[string]any{"file_path": in.FilePath}
		if in.FilePath != "" {
			one("Read", map[string]any{"file_path": in.FilePath})
		}
		for _, a := range in.Attachments {
			if a.FilePath != "" && a.FilePath != in.FilePath {
				one("Read", map[string]any{"file_path": a.FilePath})
			}
		}
	case "preToolUse":
		file := str(input, "file_path")
		if file == "" {
			file = str(input, "path")
		}
		switch {
		case in.ToolName == "Shell" || in.ToolName == "Read" || strings.HasPrefix(in.ToolName, "MCP:"):
			c.Skip = true
		case in.ToolName == "Write" || in.ToolName == "Delete":
			one("Write", map[string]any{"file_path": file})
		case in.ToolName == "Grep":
			one("Grep", map[string]any{"pattern": str(input, "pattern"), "path": file})
		case in.ToolName == "List":
			one("LS", map[string]any{"path": file})
		case in.ToolName == "WebFetch" || in.ToolName == "Fetch":
			one("WebFetch", map[string]any{"url": str(input, "url")})
		case in.ToolName == "WebSearch":
			one("WebSearch", map[string]any{"query": str(input, "query")})
		default:
			one(in.ToolName, input)
		}
	default:
		if c.Orig.ToolName == "" {
			c.Orig.ToolName = in.Event
		}
		one(c.Orig.ToolName, input)
	}
	if len(c.Canon) == 0 && !c.Skip {
		one(c.Orig.ToolName, c.Orig.ToolInput)
	}
	return c, nil
}

// CursorSlim drops what effigentd never reads from a Cursor payload before
// it is forwarded to the daemon: the file's contents (beforeReadFile), the
// text to write (preToolUse Write) and edit bodies. A large file would
// otherwise not fit the hook's request.
func CursorSlim(raw []byte) []byte {
	var m map[string]json.RawMessage
	if json.Unmarshal(cursorBOM(raw), &m) != nil {
		return raw
	}
	delete(m, "content")
	delete(m, "edits")
	var ti map[string]json.RawMessage
	if json.Unmarshal(m["tool_input"], &ti) == nil && ti != nil {
		delete(ti, "content")
		m["tool_input"], _ = json.Marshal(ti)
	}
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

// CursorOutput renders a Decision for Cursor's permission hooks. Cursor
// needs a permission in every answer (a response without one blocks), so a
// call effigentd doesn't object to gets "allow"; hooks from other sources
// and Cursor's own settings still apply (a deny or ask from any of them wins).
func CursorOutput(d Decision) []byte {
	if !d.Deny {
		return []byte(`{"permission":"allow"}`)
	}
	b, _ := json.Marshal(map[string]any{"permission": "deny", "user_message": d.Reason, "agent_message": d.Reason})
	return b
}

// CursorFailClosed is what `effigentd hook cursor` prints when it can't get a decision.
func CursorFailClosed(why string) []byte {
	return CursorOutput(Decision{Deny: true,
		Reason: "Blocked by Effigent: " + why + ". Ask your IT team, or check: effigentd status"})
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
