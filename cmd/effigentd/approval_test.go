package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/hooks"
	"github.com/effigent/effigent/internal/endpoint/redact"
	"github.com/effigent/effigent/internal/shared/action"
)

// What an approval request sends: the working directory under the
// workspace's masks, secrets out of the summary and reason, and a fingerprint
// of the real (unmasked) call, so approving the masked request still binds
// to exactly that call.
func TestApprovalRequestIsMasked(t *testing.T) {
	if err := redact.Configure([]redact.Rule{{Name: "customer", Pattern: `(?i)acme-?corp`}}, true); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = redact.Configure(nil, false) })
	cwd := "/home/dana/clients/acme-corp/billing"
	cmd := "psql postgres://app:s3cretpw@db.acmecorp.internal/app -c 'DROP TABLE invoices'"
	p := pausedCall{agent: "grok-bot", session: "s1", tool: "Bash", cwd: cwd, summary: cmd,
		action: action.Action{Tool: "Bash", Cwd: cwd, Class: action.Exec, Command: cmd}}
	d := hooks.Decision{Approve: true, Rule: "actions_approve", Reason: "destructive SQL on db.acmecorp.internal needs approval"}
	req := approvalRequest("org:t", "ep_1", "dana", p, d, 60, 18*time.Second)
	b, _ := json.Marshal(req)
	out := string(b)
	for _, leak := range []string{"acme-corp", "acmecorp", "s3cretpw"} {
		if strings.Contains(out, leak) {
			t.Errorf("%q leaves the machine: %s", leak, out)
		}
	}
	if req.Cwd != "/home/dana/clients/[REDACTED:customer]/billing" {
		t.Errorf("cwd = %q", req.Cwd)
	}
	want := action.Fingerprint(action.Context{OrgID: "org:t", EndpointID: "ep_1", SessionID: "s1", AgentType: "grok-bot", OSUser: "dana"}, p.action)
	if req.Fingerprint != want || req.WaitSeconds != 18 || req.TTLMinutes != 60 || req.OSUser != "dana" {
		t.Errorf("request = %+v", req)
	}
}
