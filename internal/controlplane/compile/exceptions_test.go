package compile

import (
	"slices"
	"strings"
	"testing"
	"time"
)

const exBase = `
defaults:
  mode: denylist
  exec_deny: [/usr/bin/curl, /bin/curl, /usr/bin/nc]
  domain_deny: [pastebin.com, transfer.sh]
  network_deny: [203.0.113.7]
  command_approve: ["git push*", "terraform apply*"]
agents:
  - name: claude-code
    binary_names: [claude]
  - name: codex
    binary_names: [codex]
  - name: gemini-cli
    binary_names: [gemini]
    exec_deny: [/usr/bin/curl, /usr/bin/wget]
`

func TestExceptions(t *testing.T) {
	soon := now.Add(time.Hour)
	past := now.Add(-time.Minute)
	exs := []Exception{
		{ID: "x-curl", Endpoints: []string{"web-laptop"}, List: "exec_deny", Value: "curl"},                                            // by hostname, every agent, by name
		{ID: "x-paste", Owners: []string{"OMER@acme.io"}, Agents: []string{"claude-code"}, List: "domain_deny", Value: "pastebin.com"}, // one agent
		{ID: "x-ip", Teams: []string{"web"}, List: "network_deny", Value: "203.0.113.7/32"},                                            // canonical CIDR
		{ID: "x-push", Endpoints: []string{"ep-web"}, List: "command_approve", Value: "git push*", ExpiresAt: &soon},
		{ID: "x-old", Endpoints: []string{"ep-web"}, List: "command_approve", Value: "terraform apply*", ExpiresAt: &past}, // expired
	}
	out, err := CompileWith([]byte(exBase), nil, exs, web, now)
	if err != nil {
		t.Fatal(err)
	}
	cc := out.Policy.RuleFor("claude-code")
	if slices.ContainsFunc(cc.ExecDeny, func(s string) bool { return strings.HasSuffix(s, "/curl") }) || !slices.Contains(cc.ExecDeny, "/usr/bin/nc") {
		t.Fatalf("claude-code exec_deny %v", cc.ExecDeny)
	}
	if slices.Contains(cc.DomainDeny, "pastebin.com") || !slices.Contains(cc.DomainDeny, "transfer.sh") {
		t.Fatalf("claude-code domain_deny %v", cc.DomainDeny)
	}
	if !slices.Contains(out.Policy.RuleFor("codex").DomainDeny, "pastebin.com") {
		t.Fatal("agent-specific exception leaked to codex")
	}
	if len(cc.NetDeny) != 0 {
		t.Fatalf("network_deny %v", cc.NetDeny)
	}
	if slices.Contains(cc.CommandApprove, "git push*") || !slices.Contains(cc.CommandApprove, "terraform apply*") {
		t.Fatalf("command_approve %v (expired exception must not apply)", cc.CommandApprove)
	}
	if len(out.Exceptions) != 4 {
		t.Fatalf("applied %d exceptions", len(out.Exceptions))
	}
	// gemini-cli's own exec_deny loses curl too, and keeps wget
	if g := out.Policy.RuleFor("gemini-cli"); !slices.Equal(g.ExecDeny, []string{"/usr/bin/wget"}) {
		t.Fatalf("gemini exec_deny %v", g.ExecDeny)
	}

	// another machine keeps every company-wide entry
	other, err := CompileWith([]byte(exBase), nil, exs, payments, now)
	if err != nil {
		t.Fatal(err)
	}
	if r := other.Policy.RuleFor("claude-code"); !slices.Contains(r.ExecDeny, "/usr/bin/curl") || !slices.Contains(r.DomainDeny, "pastebin.com") || len(other.Exceptions) != 0 {
		t.Fatalf("payments got web's exceptions: %+v", r)
	}
	// ...and an hour later the timed one is gone (compiled at a later publish)
	later, _ := CompileWith([]byte(exBase), nil, exs, web, now.Add(2*time.Hour))
	if !slices.Contains(later.Policy.RuleFor("claude-code").CommandApprove, "git push*") {
		t.Fatal("expired exception still applied")
	}
}

func TestExceptionAllowAndRefusals(t *testing.T) {
	const allow = `
defaults:
  mode: allowlist
  exec_allow: [/usr/bin/git, /bin/ls]
agents:
  - name: claude-code
    binary_names: [claude]
`
	out, err := CompileWith([]byte(allow), nil, []Exception{{ID: "a", Endpoints: []string{"ep-web"}, Agents: []string{"claude-code"}, List: "exec_allow", Value: "/usr/bin/curl"}}, web, now)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(out.Policy.RuleFor("claude-code").ExecAllow, "/usr/bin/curl") || slices.Contains(out.Policy.RuleFor("").ExecAllow, "/usr/bin/curl") {
		t.Fatalf("exec_allow add: %v / defaults %v", out.Policy.RuleFor("claude-code").ExecAllow, out.Policy.RuleFor("").ExecAllow)
	}

	// emptying one agent's list can't be expressed: refused, not silently dropped
	only := strings.Replace(exBase, "[/usr/bin/curl, /usr/bin/wget]", "[/usr/bin/curl]", 1)
	for _, agents := range [][]string{{"gemini-cli"}, nil} {
		_, err = CompileWith([]byte(only), nil, []Exception{{ID: "g", Endpoints: []string{"ep-web"}, Agents: agents, List: "exec_deny", Value: "curl"}}, web, now)
		if err == nil || !strings.Contains(err.Error(), "empty") {
			t.Fatalf("agents %v: want a refusal, got %v", agents, err)
		}
	}
	// an agent-specific exception that empties an inherited list is refused too
	_, err = CompileWith([]byte(exBase), nil, []Exception{{ID: "n", Endpoints: []string{"ep-web"}, Agents: []string{"codex"}, List: "network_deny", Value: "203.0.113.7"}}, web, now)
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("inherited: want a refusal, got %v", err)
	}

	for _, x := range []Exception{
		{List: "exec_deny", Value: "curl"},                            // nobody
		{Endpoints: []string{"a"}, List: "mode", Value: "monitor"},    // unknown list
		{Endpoints: []string{"a"}, List: "exec_allow", Value: "curl"}, // needs a path
		{Endpoints: []string{"a"}, List: "domain_deny", Value: "  "},  // no value
	} {
		if x.Validate() == nil {
			t.Fatalf("accepted %+v", x)
		}
	}
}
