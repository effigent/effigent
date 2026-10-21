package compile

import (
	"strings"
	"testing"
	"time"
)

func TestCompileKeepsActionsEnvironmentsRedact(t *testing.T) {
	base := `defaults:
  mode: denylist
  actions_deny: [force_push, destructive_sql@prod]
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
`
	out, err := Compile([]byte(base), nil, Machine{EndpointID: "e1", Hostname: "h"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	y := string(out.YAML)
	for _, want := range []string{"destructive_sql@prod", "cloud_change@prod", "kube_contexts", "customer-id", "pii: true", "/.github/workflows/", "npm:event-stream"} {
		if !strings.Contains(y, want) {
			t.Errorf("compiled policy lost %q:\n%s", want, y)
		}
	}
	if r := out.Policy.RuleFor("claude-code"); len(r.ActionsApprove) != 1 || r.Environments["prod"].KubeContexts[0] != "prod-*" {
		t.Errorf("rule: %+v", r)
	}
}
