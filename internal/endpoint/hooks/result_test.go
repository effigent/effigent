package hooks

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// Payloads shaped like the agents' documented post-tool events (see result.go).
func TestParseResult(t *testing.T) {
	cases := []struct {
		name, agent, payload string
		status               string
		exit                 int // -1: none
		dur                  int64
		errText, failure     string
		summary, id          string
	}{
		{"claude ok", "claude", `{"session_id":"s1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},
			"tool_response":{"stdout":"a\nb","stderr":"","interrupted":false,"isImage":false},"tool_use_id":"toolu_1","duration_ms":42}`,
			"ok", -1, 42, "", "", "Bash: ls", "toolu_1"},
		{"claude interrupted", "claude", `{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"sleep 9"},
			"tool_response":{"stdout":"","interrupted":true}}`, "interrupted", -1, 0, "", "", "Bash: sleep 9", ""},
		{"claude failure exit", "claude", `{"session_id":"s1","hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"false"},
			"tool_use_id":"toolu_2","error":"Exit code 1\nsecret output line","is_interrupt":false,"duration_ms":7}`,
			"error", 1, 7, "", "", "Bash: false", "toolu_2"},
		{"claude failure text", "claude", `{"hook_event_name":"PostToolUseFailure","tool_name":"Read","tool_input":{"file_path":"/x"},
			"error":"File does not exist.\nmore"}`, "error", -1, 0, "File does not exist.", "", "Read: /x", ""},
		{"claude failure interrupt", "claude", `{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"make"},
			"error":"Interrupted","is_interrupt":true}`, "interrupted", -1, 0, "Interrupted", "", "Bash: make", ""},
		{"codex shell", "codex", `{"session_id":"c1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"printf x"},
			"tool_response":"post-tool-output","tool_use_id":"call_1","turn_id":"t"}`, "done", -1, 0, "", "", "Bash: printf x", "call_1"},
		{"codex apply_patch", "codex", `{"hook_event_name":"PostToolUse","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch"},
			"tool_response":"Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nA a.txt"}`, "ok", 0, 0, "", "", "Edit: a.txt", ""},
		{"codex mcp error", "codex", `{"hook_event_name":"PostToolUse","tool_name":"mcp__github__get_issue","tool_input":{"n":1},
			"tool_response":{"content":[{"type":"text","text":"not found"}],"isError":true}}`, "error", -1, 0, "", "", "mcp__github__get_issue", ""},
		{"gemini ok", "gemini", `{"session_id":"g1","hook_event_name":"AfterTool","tool_name":"read_file","tool_input":{"file_path":"/w/a"},
			"tool_response":{"llmContent":"contents","returnDisplay":""}}`, "ok", -1, 0, "", "", "Read: /w/a", ""},
		{"gemini exit", "gemini", `{"hook_event_name":"AfterTool","tool_name":"run_shell_command","tool_input":{"command":"false"},
			"tool_response":{"llmContent":"Command: false\nDirectory: (root)\nOutput: (empty)\nError: (none)\nExit Code: 1\n","returnDisplay":""}}`,
			"error", 1, 0, "", "", "Bash: false", ""},
		{"gemini error", "gemini", `{"hook_event_name":"AfterTool","tool_name":"mcp_db_query","tool_input":{"sql":"x"},"mcp_context":{"server_name":"db","tool_name":"query"},
			"tool_response":{"llmContent":"","returnDisplay":"","error":{"message":"connection refused\nstack","type":"execution_failed"}}}`,
			"error", -1, 0, "connection refused", "execution_failed", "mcp__db__query", ""},
		{"cursor shell", "cursor", `{"conversation_id":"k1","hook_event_name":"postToolUse","tool_name":"Shell","tool_input":{"command":"npm test"},
			"tool_output":"{\"exitCode\":2,\"stdout\":\"FAIL\"}","tool_use_id":"abc","cwd":"/p","duration":5432}`,
			"error", 2, 5432, "", "", "Bash: npm test", "abc"},
		{"cursor write", "cursor", `{"hook_event_name":"postToolUse","tool_name":"Write","tool_input":{"file_path":"/p/a.go","content":"package a"},
			"tool_output":"{}","duration":3}`, "ok", -1, 3, "", "", "Write: /p/a.go", ""},
		{"cursor timeout", "cursor", `{"hook_event_name":"postToolUseFailure","tool_name":"Shell","tool_input":{"command":"npm test"},"tool_use_id":"abc",
			"error_message":"Command timed out after 30s","failure_type":"timeout","duration":5000,"is_interrupt":false}`,
			"timeout", -1, 5000, "Command timed out after 30s", "timeout", "Bash: npm test", "abc"},
		{"cursor denied", "cursor", `{"hook_event_name":"postToolUseFailure","tool_name":"Read","tool_input":{"file_path":"/p/.env"},
			"error_message":"blocked","failure_type":"permission_denied"}`, "denied", -1, 0, "blocked", "permission_denied", "Read: /p/.env", ""},
	}
	for _, c := range cases {
		for _, reduced := range []bool{false, true} {
			raw := []byte(c.payload)
			if !IsResult(raw) {
				t.Fatalf("%s: not a result", c.name)
			}
			if reduced {
				var ok bool
				if raw, ok = ReduceResult(c.agent, raw); !ok {
					t.Fatalf("%s: reduce failed", c.name)
				}
				for _, bad := range []string{"secret output", "post-tool-output", "FAIL", "Wall time", "contents", "package a", "stack"} {
					if strings.Contains(string(raw), bad) {
						t.Errorf("%s: reduced payload keeps output %q: %s", c.name, bad, raw)
					}
				}
			}
			r, err := ParseResult(c.agent, raw)
			if err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			o := r.Outcome
			if o.Status != c.status || o.DurationMS != c.dur || o.Error != c.errText || o.FailureType != c.failure {
				t.Errorf("%s (reduced %v): outcome %+v", c.name, reduced, o)
			}
			if (c.exit < 0) != (o.ExitCode == nil) || (o.ExitCode != nil && *o.ExitCode != c.exit) {
				t.Errorf("%s (reduced %v): exit code %v, want %d", c.name, reduced, o.ExitCode, c.exit)
			}
			if s := r.Call.Summary(); s != c.summary || r.ToolUseID != c.id {
				t.Errorf("%s (reduced %v): summary %q id %q", c.name, reduced, s, r.ToolUseID)
			}
		}
	}
}

func TestIsResult(t *testing.T) {
	for _, p := range []string{`{"hook_event_name":"PreToolUse"}`, `{"hook_event_name":"BeforeTool"}`, `{"hook_event_name":"preToolUse"}`,
		`{"hook_event_name":"beforeShellExecution"}`, `{}`, `not json`} {
		if IsResult([]byte(p)) {
			t.Errorf("%s is not a result", p)
		}
	}
	if !IsResult([]byte("\xef\xbb\xbf" + `{"hook_event_name":"postToolUse"}`)) {
		t.Error("Cursor's BOM")
	}
}

func TestResultLimits(t *testing.T) {
	long := strings.Repeat("é", 400)
	raw, _ := json.Marshal(map[string]any{"hook_event_name": "PostToolUseFailure", "tool_name": "Bash",
		"tool_input": map[string]any{"command": "x"}, "error": long})
	r, _ := ParseResult("claude", raw)
	if len(r.Outcome.Error) > maxErrorLen+len("…") || !strings.HasSuffix(r.Outcome.Error, "…") || !json.Valid([]byte(`"`+r.Outcome.Error+`"`)) {
		t.Errorf("error not capped: %d bytes", len(r.Outcome.Error))
	}
	// a huge input keeps only what the summary reads
	big, _ := json.Marshal(map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Bash",
		"tool_input": map[string]any{"command": "echo hi", "blob": strings.Repeat("x", 300<<10)}, "tool_response": map[string]any{}})
	red, ok := ReduceResult("claude", big)
	if !ok || len(red) > 8<<10 {
		t.Fatalf("not reduced: %d", len(red))
	}
	if r, _ := ParseResult("claude", red); r.Call.Summary() != "Bash: echo hi" {
		t.Errorf("summary: %q", r.Call.Summary())
	}
	// a forged outcome is bounded
	forged := []byte(`{"hook_event_name":"PostToolUse","tool_name":"Bash","effigent_outcome":{"status":"<script>","duration_ms":-5,"duration_approx":true}}`)
	if r, _ := ParseResult("claude", forged); r.Outcome.Status != "done" || r.Outcome.DurationMS != 0 || r.Outcome.DurationApprox {
		t.Errorf("forged: %+v", r.Outcome)
	}
	if _, err := ParseResult("claude", []byte(`{"hook_event_name":"PreToolUse"}`)); err == nil {
		t.Error("a pre-tool payload is not a result")
	}
}

func TestCalls(t *testing.T) {
	c := NewCalls()
	now := time.Unix(1_700_000_000, 0)
	c.now = func() time.Time { return now }
	c.Start("a/s", "id1", "Bash: ls")
	c.Start("a/s", "", "Bash: make") // Cursor's beforeShellExecution: no id
	now = now.Add(1500 * time.Millisecond)
	if d, ok := c.Finish("a/s", "id1", "Bash: ls"); !ok || d != 1500*time.Millisecond {
		t.Errorf("by id: %v %v", d, ok)
	}
	if d, ok := c.Finish("a/s", "zzz", "Bash: make"); !ok || d != 1500*time.Millisecond {
		t.Errorf("by summary: %v %v", d, ok)
	}
	if _, ok := c.Finish("a/s", "id1", "Bash: ls"); ok {
		t.Error("finished twice")
	}
	if _, ok := c.Finish("b/s", "", "Bash: make"); ok {
		t.Error("other session")
	}
	if c.Len() != 0 {
		t.Errorf("%d held", c.Len())
	}
	c.Start("a/s", "old", "x")
	now = now.Add(callTTL + time.Second)
	if _, ok := c.Finish("a/s", "old", "x"); ok {
		t.Error("too old")
	}
	for i := range maxCalls + 5 {
		c.Start("a/s", "", string(rune(i)))
	}
	if c.Len() > maxCalls {
		t.Errorf("%d held", c.Len())
	}
}

func TestResultMessage(t *testing.T) {
	one := 1
	if m := ResultMessage(outcome("error", &one, 2345, true, "boom")); m != "error, exit 1, ~2.3s: boom" {
		t.Errorf("%q", m)
	}
	if m := ResultMessage(outcome("ok", nil, 42, false, "")); m != "ok, 42ms" {
		t.Errorf("%q", m)
	}
}

func outcome(status string, exit *int, ms int64, approx bool, err string) event.Outcome {
	return event.Outcome{Status: status, ExitCode: exit, DurationMS: ms, DurationApprox: approx, Error: err}
}
