package hooks

import (
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

// models.require_gateway: an agent whose model traffic doesn't go through
// effigentd's gateway is model_endpoint, denied unless actions_approve asks.
func TestRequireGateway(t *testing.T) {
	rule := policy.Rule{Mode: policy.Denylist, RequireGateway: true, GatewayAddr: "127.0.0.1:7779"}
	call := func(agent string, env map[string]string, via bool) ClaudeInput {
		return ClaudeInput{ToolName: "Bash", Cwd: t.TempDir(), Agent: agent, Env: env, ViaGateway: via,
			ToolInput: map[string]any{"command": "ls"}}
	}
	gw := map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:7779/anthropic/claude-code"}
	for _, c := range []struct {
		name  string
		agent string
		env   map[string]string
		via   bool
		deny  bool
	}{
		{"pointed at the gateway", "claude-code", gw, false, false},
		{"localhost works too", "claude-code", map[string]string{"ANTHROPIC_BASE_URL": "http://localhost:7779/anthropic/claude-code"}, false, false},
		{"seen by the gateway", "claude-code", nil, true, false},
		{"vendor default", "claude-code", map[string]string{}, false, true},
		{"no environment reported", "claude-code", nil, false, true},
		{"another local proxy", "claude-code", map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:8080/anthropic/claude-code"}, false, true},
		{"gateway port, wrong provider", "claude-code", map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:7779/openai/x"}, false, true},
		{"Bedrock bypasses the base URL", "claude-code", map[string]string{"ANTHROPIC_BASE_URL": gw["ANTHROPIC_BASE_URL"], "CLAUDE_CODE_USE_BEDROCK": "1"}, false, true},
		{"codex via its env", "codex", map[string]string{"OPENAI_BASE_URL": "http://127.0.0.1:7779/openai/codex/v1"}, false, false},
		{"codex seen", "codex", map[string]string{}, true, false},
		{"codex direct", "codex", map[string]string{}, false, true},
		{"cursor can't use the gateway: not judged", "cursor-agent", map[string]string{}, false, false},
	} {
		d := EvaluateClaude(rule, call(c.agent, c.env, c.via))
		if d.Deny != c.deny {
			t.Errorf("%s: deny=%v (%s)", c.name, d.Deny, d.Reason)
		}
		if c.deny && (d.Rule != "actions_deny" || !strings.Contains(d.Reason, "not through the Effigent model gateway")) {
			t.Errorf("%s: %+v", c.name, d)
		}
	}
	// approval instead of a deny
	r := rule
	r.ActionsApprove = []string{"model_endpoint"}
	if d := EvaluateClaude(r, call("claude-code", map[string]string{}, false)); d.Deny || !d.Approve {
		t.Errorf("approve: %+v", d)
	}
	// the gateway off on this machine: nothing can satisfy the rule
	r = rule
	r.GatewayAddr = ""
	if d := EvaluateClaude(r, call("claude-code", gw, false)); !d.Deny {
		t.Errorf("gateway off: %+v", d)
	}
	// monitor mode reports it
	r = rule
	r.Mode = policy.Monitor
	if d := EvaluateClaude(r, call("claude-code", map[string]string{}, false)); d.Deny || d.Report != "would_block" {
		t.Errorf("monitor: %+v", d)
	}
}
