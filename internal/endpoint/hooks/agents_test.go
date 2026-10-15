package hooks

import (
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

func TestCodexAndGemini(t *testing.T) {
	homeDir = func() string { return "/Users/dev" }
	foldCase = true
	codex := func(tool, input string) Call {
		c, err := ParseCodex([]byte(`{"session_id":"s","turn_id":"t","transcript_path":null,"cwd":"/work","hook_event_name":"PreToolUse",
			"model":"gpt-5","permission_mode":"default","tool_name":"` + tool + `","tool_use_id":"u","tool_input":` + input + `}`))
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	gemini := func(tool, input, mcp string) Call {
		if mcp == "" {
			mcp = "null"
		}
		c, err := ParseGemini([]byte(`{"session_id":"s","transcript_path":"/tmp/x","cwd":"/work","hook_event_name":"BeforeTool",
			"timestamp":"2026-10-15T10:00:00Z","tool_name":"` + tool + `","tool_input":` + input + `,"mcp_context":` + mcp + `}`))
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	patch := `{"command":"*** Begin Patch\n*** Update File: src/app.go\n@@\n-a\n+b\n*** Add File: .env\n+X=1\n*** End Patch\n"}`
	cases := []struct {
		name string
		c    Call
		want string
		rule string
	}{
		{"codex shell ok", codex("Bash", `{"command":"go test ./..."}`), "", ""},
		{"codex shell denied", codex("Bash", `{"command":"curl https://x.io"}`), "deny", "exec_deny"},
		{"codex shell approval", codex("Bash", `{"command":"git push origin main"}`), "approval", "command_approve"},
		{"codex patch touches .env", codex("apply_patch", patch), "deny", "file_deny"},
		{"codex patch ok", codex("apply_patch", `{"command":"*** Begin Patch\n*** Update File: src/app.go\n*** End Patch"}`), "", ""},
		{"codex mcp approval", codex("mcp__github__create_issue", `{"title":"x"}`), "approval", "tool_approve"},

		{"gemini shell ok", gemini("run_shell_command", `{"command":"ls -la"}`, ""), "", ""},
		{"gemini shell denied", gemini("run_shell_command", `{"command":"nc 10.0.0.1 80"}`, ""), "deny", "exec_deny"},
		{"gemini shell approval", gemini("run_shell_command", `{"command":"git push --tags","dir_path":"repo"}`, ""), "approval", "command_approve"},
		{"gemini read denied", gemini("read_file", `{"file_path":"/Users/dev/.ssh/id_rsa"}`, ""), "deny", "file_deny"},
		{"gemini read relative", gemini("read_file", `{"absolute_path":".env"}`, ""), "deny", "file_deny"},
		{"gemini write approval", gemini("write_file", `{"file_path":"/Users/dev/.kube/config","content":"x"}`, ""), "approval", "file_approve"},
		{"gemini replace ok", gemini("replace", `{"file_path":"/work/a.go","old_string":"a","new_string":"b"}`, ""), "", ""},
		{"gemini many files", gemini("read_many_files", `{"include":["src/**","/w/.env"]}`, ""), "deny", "file_deny"},
		{"gemini fetch denied", gemini("web_fetch", `{"prompt":"summarize https://ok.io/a and https://pastebin.com/raw/x."}`, ""), "deny", "domain_deny"},
		{"gemini fetch approval", gemini("web_fetch", `{"prompt":"get https://api.stripe.com/v1/x"}`, ""), "approval", "domain_approve"},
		{"gemini search approval", gemini("google_web_search", `{"query":"x"}`, ""), "approval", "tool_approve"},
		{"gemini mcp approval", gemini("mcp_github_create_issue", `{"title":"x"}`, `{"server_name":"github","tool_name":"create_issue"}`), "approval", "tool_approve"},
		{"gemini other mcp", gemini("mcp_linear_create_issue", `{}`, `{"server_name":"linear","tool_name":"create_issue"}`), "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := EvaluateCall(EvaluateClaude, testRule(policy.Denylist), c.c)
			got := d.Report
			if d.Deny {
				got = "deny"
			}
			if got != c.want || d.Rule != c.rule {
				t.Fatalf("got %q rule %q (%s), want %q rule %q; canon %+v", got, d.Rule, d.Reason, c.want, c.rule, c.c.Canon)
			}
		})
	}

	if s := codex("apply_patch", patch).Summary(); s != "Edit: src/app.go, .env" {
		t.Fatalf("patch summary %q", s)
	}
	if out := string(GeminiOutput(Decision{Deny: true, Reason: "no"})); out != `{"decision":"deny","reason":"no"}` {
		t.Fatalf("gemini deny %s", out)
	}
	if out := string(GeminiOutput(Decision{Approve: true})); out != "{}" {
		t.Fatalf("gemini non-deny %s", out)
	}
	if !strings.Contains(string(GeminiFailClosed("down")), `"decision":"deny"`) {
		t.Fatal("gemini fail closed")
	}
}
