package compile

import (
	"strings"
	"testing"
	"time"
)

func TestCompileKeepsActionsEnvironmentsRedact(t *testing.T) {
	base := `defaults:
  mode: denylist
  actions_deny: [force_push, destructive_sql@prod, mcp_changed, exfil_sequence]
  actions_approve: [untrusted_then_risky]
  file_write_deny: [/.github/workflows/]
  package_deny: ["npm:event-stream"]
agents:
  - name: claude-code
    binary_names: [claude]
    actions_approve: [cloud_change@prod]
environments:
  prod:
    kube_contexts: ["prod-*"]
    hosts: ["*.prod.internal"]
redact:
  pii: true
  patterns: [{name: customer-id, pattern: 'CUST-[0-9]{6}'}]
mcp_pins:
  github: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
`
	out, err := Compile([]byte(base), nil, Machine{EndpointID: "e1", Hostname: "h"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	y := string(out.YAML)
	for _, want := range []string{"destructive_sql@prod", "cloud_change@prod", "kube_contexts", "customer-id", "pii: true", "/.github/workflows/", "npm:event-stream",
		"mcp_changed", "exfil_sequence", "untrusted_then_risky", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"} {
		if !strings.Contains(y, want) {
			t.Errorf("compiled policy lost %q:\n%s", want, y)
		}
	}
	if r := out.Policy.RuleFor("claude-code"); len(r.ActionsApprove) != 1 || r.Environments["prod"].KubeContexts[0] != "prod-*" {
		t.Errorf("rule: %+v", r)
	}
	if r := out.Policy.RuleFor("claude-code"); len(r.MCPPins["github"]) != 1 {
		t.Errorf("mcp_pins: %+v", r.MCPPins)
	}
}
