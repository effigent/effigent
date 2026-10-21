package hooks

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// Post-tool hooks: how a tool call ended. The agents' payloads, as documented
// (checked 2026-10-21):
//   - Claude Code PostToolUse {tool_name, tool_input, tool_response, tool_use_id,
//     duration_ms?} and PostToolUseFailure {…, error, is_interrupt, duration_ms?}
//     — https://code.claude.com/docs/en/hooks. A failed Bash command's error
//     starts with "Exit code N"; a successful one has no exit code.
//   - Codex PostToolUse {tool_name, tool_input, tool_response, tool_use_id, turn_id}
//     — https://learn.chatgpt.com/docs/hooks and codex-rs/hooks/schema. It runs
//     after failed commands too; a shell command's tool_response is its output
//     only (no exit code), apply_patch's starts with "Exit code: N", an MCP
//     call's is the CallToolResult (isError).
//   - Gemini CLI AfterTool {tool_name, tool_input, tool_response {llmContent,
//     returnDisplay, error? {message, type}}, mcp_context?} — docs/hooks/reference.md.
//     No call id; a failed shell command says "Exit Code: N" in llmContent.
//   - Cursor postToolUse {tool_name, tool_input, tool_output (JSON string,
//     {"exitCode", …} for Shell), tool_use_id, duration} and postToolUseFailure
//     {…, error_message, failure_type error|timeout|permission_denied, duration,
//     is_interrupt} — https://cursor.com/docs/hooks.
//
// The tool's output never leaves the hook process: ReduceResult replaces it
// with the outcome before the payload is sent to the daemon.

var resultEvents = map[string]bool{"PostToolUse": true, "PostToolUseFailure": true, "AfterTool": true,
	"postToolUse": true, "postToolUseFailure": true}

// IsResult reports whether a hook payload is a post-tool event.
func IsResult(raw []byte) bool {
	var m struct {
		Event string `json:"hook_event_name"`
	}
	return json.Unmarshal(cursorBOM(raw), &m) == nil && resultEvents[m.Event]
}

// ResultOutput is what the hook prints for a post-tool event: nothing the
// agent acts on. Gemini CLI and Cursor expect JSON on stdout.
func ResultOutput(agent string) []byte {
	if agent == "gemini" || agent == "cursor" {
		return []byte("{}")
	}
	return nil
}

// Result is one post-tool hook call.
type Result struct {
	Call      Call // the call, read as its pre-tool hook reads it (for its summary)
	ToolUseID string
	Outcome   event.Outcome
}

// resultInput is every field the agents' post-tool payloads carry about how
// the call went.
type resultInput struct {
	Event        string          `json:"hook_event_name"`
	ToolName     string          `json:"tool_name"`
	ToolUseID    string          `json:"tool_use_id"`
	ToolResponse json.RawMessage `json:"tool_response"` // Claude Code, Codex, Gemini CLI
	ToolOutput   string          `json:"tool_output"`   // Cursor: a JSON string
	Error        json.RawMessage `json:"error"`         // Claude Code PostToolUseFailure: a string
	ErrorMessage string          `json:"error_message"` // Cursor
	FailureType  string          `json:"failure_type"`  // Cursor
	IsInterrupt  bool            `json:"is_interrupt"`
	DurationMS   *float64        `json:"duration_ms"` // Claude Code
	Duration     *float64        `json:"duration"`    // Cursor, milliseconds
	// Outcome is set by ReduceResult in the hook process, in place of the output.
	Outcome *event.Outcome `json:"effigent_outcome"`
}

var (
	claudeExitRE = regexp.MustCompile(`^Exit code (-?\d+)\s*$`)
	codexExitRE  = regexp.MustCompile(`^Exit code: (-?\d+)\s*$`)
	geminiExitRE = regexp.MustCompile(`Exit Code: (-?\d+)`)
)

// maxErrorLen caps an outcome's error line.
const maxErrorLen = 300

// outcomeOf reads the outcome from a post-tool payload.
func outcomeOf(agent string, r resultInput) event.Outcome {
	var o event.Outcome
	switch {
	case r.DurationMS != nil && *r.DurationMS > 0:
		o.DurationMS = int64(*r.DurationMS)
	case r.Duration != nil && *r.Duration > 0:
		o.DurationMS = int64(*r.Duration)
	}
	switch r.Event {
	case "PostToolUseFailure": // Claude Code
		var msg string
		_ = json.Unmarshal(r.Error, &msg)
		line := firstLine(msg)
		o.Status = "error"
		if r.IsInterrupt {
			o.Status = "interrupted"
		}
		if m := claudeExitRE.FindStringSubmatch(line); m != nil {
			o.ExitCode = atoi(m[1])
			line = ""
		}
		o.Error = line
	case "PostToolUse":
		if agent == "codex" {
			o.Status = "done"
			var s string
			var obj map[string]any
			switch {
			case json.Unmarshal(r.ToolResponse, &s) == nil:
				if m := codexExitRE.FindStringSubmatch(firstLine(s)); m != nil {
					o.ExitCode = atoi(m[1])
					o.Status = statusOf(*o.ExitCode)
				}
			case json.Unmarshal(r.ToolResponse, &obj) == nil && obj != nil:
				if e, ok := obj["isError"].(bool); ok { // an MCP CallToolResult
					o.Status = map[bool]string{true: "error", false: "ok"}[e]
				}
			}
			break
		}
		// Claude Code: PostToolUse runs only after a call that succeeded
		o.Status = "ok"
		var obj map[string]any
		if json.Unmarshal(r.ToolResponse, &obj) == nil && obj["interrupted"] == true {
			o.Status = "interrupted"
		}
	case "AfterTool": // Gemini CLI
		o.Status = "ok"
		var resp struct {
			LLMContent json.RawMessage `json:"llmContent"`
			Error      *struct {
				Message string `json:"message"`
				Type    string `json:"type"`
			} `json:"error"`
		}
		_ = json.Unmarshal(r.ToolResponse, &resp)
		if m := geminiExitRE.FindSubmatch(resp.LLMContent); m != nil {
			o.ExitCode = atoi(string(m[1]))
			o.Status = statusOf(*o.ExitCode)
		}
		if resp.Error != nil {
			o.Status, o.Error, o.FailureType = "error", firstLine(resp.Error.Message), cut(resp.Error.Type, 60)
		}
	case "postToolUse": // Cursor
		o.Status = "ok"
		var out map[string]any
		if json.Unmarshal([]byte(r.ToolOutput), &out) == nil {
			if n, ok := out["exitCode"].(float64); ok {
				o.ExitCode = atoi(strconv.Itoa(int(n)))
				o.Status = statusOf(int(n))
			}
		}
	case "postToolUseFailure": // Cursor
		o.FailureType = cut(r.FailureType, 60)
		switch {
		case r.IsInterrupt:
			o.Status = "interrupted"
		case r.FailureType == "timeout":
			o.Status = "timeout"
		case r.FailureType == "permission_denied":
			o.Status = "denied"
		default:
			o.Status = "error"
		}
		o.Error = firstLine(r.ErrorMessage)
	}
	return o
}

func statusOf(exit int) string {
	if exit == 0 {
		return "ok"
	}
	return "error"
}

func atoi(s string) *int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return &n
}

// firstLine is the first non-empty line of s, capped: an error's headline,
// never the output that follows it.
func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			if len(l) > maxErrorLen {
				l = strings.ToValidUTF8(l[:maxErrorLen], "") + "…"
			}
			return l
		}
	}
	return ""
}

// cleanOutcome bounds an outcome the hook process sent.
func cleanOutcome(o event.Outcome) event.Outcome {
	switch o.Status {
	case "ok", "error", "interrupted", "timeout", "denied", "done":
	default:
		o.Status = "done"
	}
	o.Error, o.FailureType = firstLine(o.Error), cut(o.FailureType, 60)
	o.DurationMS = max(o.DurationMS, 0)
	o.DurationApprox = false
	return o
}

// bulkyInput are tool input fields nothing reads after the call (file
// contents, edit bodies); they are dropped before the result is sent.
var bulkyInput = []string{"content", "contents", "new_string", "old_string", "edits", "new_source", "file_text"}

// outputFields are where the agents put the tool's output or error text.
var outputFields = []string{"tool_response", "tool_output", "error", "error_message", "result_json", "output",
	"stdout", "stderr", "content", "edits"}

// ReduceResult runs in the hook process: it computes the outcome and returns
// the payload without the tool's output, ready for the daemon. ok=false when
// the payload can't be read.
func ReduceResult(agent string, raw []byte) ([]byte, bool) {
	raw = cursorBOM(raw)
	var m map[string]json.RawMessage
	var r resultInput
	if json.Unmarshal(raw, &m) != nil || json.Unmarshal(raw, &r) != nil {
		return nil, false
	}
	o := outcomeOf(agent, r)
	for _, k := range outputFields {
		delete(m, k)
	}
	var ti map[string]json.RawMessage
	if json.Unmarshal(m["tool_input"], &ti) == nil && ti != nil {
		for _, k := range bulkyInput {
			delete(ti, k)
		}
		m["tool_input"], _ = json.Marshal(ti)
	}
	if len(m["tool_input"]) > 256<<10 {
		// keep what the summary reads, capped
		var in map[string]any
		_ = json.Unmarshal(m["tool_input"], &in)
		small := map[string]any{}
		for _, k := range []string{"command", "file_path", "notebook_path", "url", "pattern", "query", "path"} {
			if s, ok := in[k].(string); ok {
				small[k] = cut(s, 4096)
			}
		}
		m["tool_input"], _ = json.Marshal(small)
	}
	m["effigent_outcome"], _ = json.Marshal(o)
	out, err := json.Marshal(m)
	return out, err == nil
}

// ParseResult reads a post-tool payload (as ReduceResult left it, or as the
// agent sent it) for agent (claude, codex, gemini, cursor).
func ParseResult(agent string, raw []byte) (Result, error) {
	raw = cursorBOM(raw)
	var r resultInput
	if err := json.Unmarshal(raw, &r); err != nil {
		return Result{}, err
	}
	if !resultEvents[r.Event] {
		return Result{}, fmt.Errorf("not a post-tool hook event: %q", r.Event)
	}
	res := Result{ToolUseID: cut(r.ToolUseID, 200)}
	if r.Outcome != nil {
		res.Outcome = cleanOutcome(*r.Outcome)
	} else {
		res.Outcome = cleanOutcome(outcomeOf(agent, r))
	}
	var err error
	switch agent {
	case "codex":
		res.Call, err = ParseCodex(raw)
	case "gemini":
		res.Call, err = ParseGemini(raw)
	case "cursor":
		res.Call, err = cursorResultCall(raw)
	default:
		var in ClaudeInput
		err = json.Unmarshal(raw, &in)
		res.Call = FromClaude(in)
	}
	return res, err
}

// cursorResultCall reads a Cursor post-tool payload as its preToolUse would
// be, including the tools preToolUse leaves to the dedicated events (Shell →
// Bash, Read; MCP:<tool> keeps its name: the server isn't in the payload).
func cursorResultCall(raw []byte) (Call, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return Call{}, err
	}
	m["hook_event_name"] = json.RawMessage(`"preToolUse"`)
	b, _ := json.Marshal(m)
	c, err := ParseCursor(b)
	if err != nil || !c.Skip {
		return c, err
	}
	c.Skip = false
	in := c.Orig
	switch {
	case in.ToolName == "Shell":
		in.ToolName, in.ToolInput = "Bash", map[string]any{"command": str(in.ToolInput, "command")}
	case in.ToolName == "Read":
		f := str(in.ToolInput, "file_path")
		if f == "" {
			f = str(in.ToolInput, "path")
		}
		in.ToolName, in.ToolInput = "Read", map[string]any{"file_path": f}
	}
	c.Canon = []ClaudeInput{in}
	return c, nil
}

// ResultMessage is a tool_result event's one-line text: "error, exit 1, 2.3s: …".
func ResultMessage(o event.Outcome) string {
	parts := []string{o.Status}
	if o.ExitCode != nil {
		parts = append(parts, fmt.Sprintf("exit %d", *o.ExitCode))
	}
	if o.DurationMS > 0 {
		d := (time.Duration(o.DurationMS) * time.Millisecond).Round(time.Millisecond)
		if d >= time.Second {
			d = d.Round(100 * time.Millisecond)
		}
		s := d.String()
		if o.DurationApprox {
			s = "~" + s
		}
		parts = append(parts, s)
	}
	msg := strings.Join(parts, ", ")
	if o.Error != "" {
		msg += ": " + o.Error
	}
	return msg
}

// Calls remembers when each tool call's pre-tool hook ran, per session, to
// time the calls whose agent sends no duration. A call is found by its tool
// use id, else by its summary (Cursor checks shell and MCP calls in events
// without an id; Gemini CLI has none).
type Calls struct {
	mu  sync.Mutex
	m   map[string]time.Time
	now func() time.Time
}

const (
	maxCalls = 20000
	callTTL  = time.Hour
)

func NewCalls() *Calls { return &Calls{m: map[string]time.Time{}, now: time.Now} }

func callKeys(session, id, summary string) (string, string) {
	var byID string
	if id != "" {
		byID = session + "\x00id\x00" + id
	}
	return byID, session + "\x00s\x00" + summary
}

// Start records a call's pre-tool hook.
func (c *Calls) Start(session, toolUseID, summary string) {
	if session == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if len(c.m) >= maxCalls {
		for k, t := range c.m {
			if now.Sub(t) > callTTL {
				delete(c.m, k)
			}
		}
		if len(c.m) >= maxCalls {
			clear(c.m)
		}
	}
	byID, bySum := callKeys(session, toolUseID, summary)
	if byID != "" {
		c.m[byID] = now
	}
	c.m[bySum] = now
}

// Finish returns how long ago the call started, and forgets it.
func (c *Calls) Finish(session, toolUseID, summary string) (time.Duration, bool) {
	if session == "" {
		return 0, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	byID, bySum := callKeys(session, toolUseID, summary)
	t, ok := c.m[byID]
	if !ok || byID == "" {
		t, ok = c.m[bySum]
	}
	delete(c.m, byID)
	delete(c.m, bySum)
	if !ok || c.now().Sub(t) > callTTL {
		return 0, false
	}
	return c.now().Sub(t), true
}

// Len is the number of calls held (tests).
func (c *Calls) Len() int { c.mu.Lock(); defer c.mu.Unlock(); return len(c.m) }
