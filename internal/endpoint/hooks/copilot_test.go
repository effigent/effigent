package hooks

import (
	"encoding/json"
	"testing"
)

func TestParseCopilot(t *testing.T) {
	for _, tc := range []struct {
		raw, tool, key, val string
	}{
		{`{"sessionId":"s1","cwd":"/workspace","toolName":"bash","toolArgs":"{\"command\":\"curl https://x.example\"}"}`, "Bash", "command", "curl https://x.example"},
		{`{"sessionId":"s1","cwd":"/workspace","toolName":"view","toolArgs":"{\"path\":\"/workspace/.env\"}"}`, "Read", "file_path", "/workspace/.env"},
		{`{"sessionId":"s1","cwd":"/workspace","toolName":"create","toolArgs":{"path":"a.txt"}}`, "Write", "file_path", "a.txt"},
		{`{"sessionId":"s1","cwd":"/workspace","toolName":"edit","toolArgs":"{\"path\":\"b.go\"}"}`, "Edit", "file_path", "b.go"},
		{`{"sessionId":"s1","cwd":"/workspace","toolName":"web_fetch","toolArgs":"{\"url\":\"https://e.example\"}"}`, "WebFetch", "url", "https://e.example"},
		// PascalCase PreToolUse: Claude Code's shape and names
		{`{"session_id":"s2","cwd":"/workspace","tool_name":"Bash","tool_input":{"command":"git push"}}`, "Bash", "command", "git push"},
		{`{"session_id":"s2","cwd":"/workspace","tool_name":"mcp__github__create_issue","tool_input":{"title":"x"}}`, "mcp__github__create_issue", "title", "x"},
	} {
		c, err := ParseCopilot([]byte(tc.raw))
		if err != nil {
			t.Fatal(err)
		}
		if len(c.Canon) != 1 || c.Canon[0].ToolName != tc.tool || str(c.Canon[0].ToolInput, tc.key) != tc.val || c.Canon[0].Cwd != "/workspace" {
			t.Errorf("%s: %+v", tc.raw, c.Canon)
		}
		if c.Orig.SessionID == "" {
			t.Errorf("%s: no session", tc.raw)
		}
	}
	if _, err := ParseCopilot([]byte(`not json`)); err == nil {
		t.Error("accepted junk")
	}
}

func TestCopilotOutput(t *testing.T) {
	if s := string(CopilotOutput(Decision{})); s != "{}" {
		t.Fatal(s)
	}
	var out map[string]any
	if err := json.Unmarshal(CopilotFailClosed("no policy"), &out); err != nil {
		t.Fatal(err)
	}
	if out["permissionDecision"] != "deny" || out["permissionDecisionReason"] == "" {
		t.Fatalf("%v", out)
	}
}
