package compile

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"slices"
	"strings"
	"testing"
	"time"

	ep "github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/shared/action"
	"github.com/effigent/effigent/internal/shared/policy"
)

var now = time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)

const base = `
defaults:
  mode: denylist
  exec_deny: [/usr/bin/nc]
  file_alert: [/.env]
agents:
  - name: claude-code
    binary_names: [claude]
  - name: codex
    binary_names: [codex]
`

var (
	payments = Machine{EndpointID: "ep-pay", Hostname: "pay-laptop", Owner: "dana@acme.io", Teams: []string{"payments"}}
	web      = Machine{EndpointID: "ep-web", Hostname: "web-laptop", Owner: "omer@acme.io", Teams: []string{"web"}}
)

func blockCurlForPayments() []policy.Policy {
	return []policy.Policy{{
		ID: "pay", Name: "Payments", Enabled: true, Priority: 10, Default: policy.Allow,
		Rules: []policy.Rule{{ID: "no-curl", Priority: 1, Decision: policy.Deny,
			Who:  policy.Selector{Teams: []string{"payments"}},
			What: policy.Target{Binaries: []string{"curl"}}}},
	}}
}

func compile(t *testing.T, b string, ps []policy.Policy, m Machine) *Output {
	t.Helper()
	out, err := Compile([]byte(b), ps, m, now)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPaymentsCurlBlockedOnlyOnPaymentsMachine(t *testing.T) {
	ps := blockCurlForPayments()

	pay := compile(t, base, ps, payments)
	for _, agent := range []string{"", "claude-code", "codex"} {
		r := pay.Policy.RuleFor(agent)
		if r.Mode != ep.Denylist || !slices.Contains(r.ExecDeny, "/usr/bin/curl") || !slices.Contains(r.ExecDeny, "/bin/curl") {
			t.Fatalf("payments machine, agent %q: curl not blocked: %+v", agent, r)
		}
		if !slices.Contains(r.ExecDeny, "/usr/bin/nc") {
			t.Fatalf("payments machine, agent %q: base deny lost: %v", agent, r.ExecDeny)
		}
	}
	if got := pay.Added[DefaultsAgent].ExecDeny; !slices.Equal(got, []string{"/bin/curl", "/sbin/curl", "/usr/bin/curl", "/usr/local/bin/curl", "/usr/sbin/curl"}) {
		t.Fatalf("added: %v", got)
	}

	other := compile(t, base, ps, web)
	for _, agent := range []string{"", "claude-code", "codex"} {
		if r := other.Policy.RuleFor(agent); slices.ContainsFunc(r.ExecDeny, func(s string) bool { return strings.HasSuffix(s, "/curl") }) {
			t.Fatalf("web machine, agent %q: curl blocked: %v", agent, r.ExecDeny)
		}
	}
	if len(other.Added) != 0 {
		t.Fatalf("web machine got additions: %+v", other.Added)
	}
}

func TestOwnerMatchesUsersByEmail(t *testing.T) {
	ps := blockCurlForPayments()
	ps[0].Rules[0].Who = policy.Selector{Users: []string{"DANA@acme.io"}}
	if r := compile(t, base, ps, payments).Policy.RuleFor("codex"); !slices.Contains(r.ExecDeny, "/usr/bin/curl") {
		t.Fatal("user selector did not match the machine owner")
	}
}

func TestAgentTypeScopesToOneAgent(t *testing.T) {
	ps := blockCurlForPayments()
	ps[0].Rules[0].Who.AgentTypes = []string{"codex"}
	p := compile(t, base, ps, payments).Policy
	if !slices.Contains(p.RuleFor("codex").ExecDeny, "/usr/bin/curl") {
		t.Fatal("codex should be blocked")
	}
	for _, a := range []string{"", "claude-code"} {
		if slices.Contains(p.RuleFor(a).ExecDeny, "/usr/bin/curl") {
			t.Fatalf("%q should not be blocked", a)
		}
	}
}

func TestRequireApprovalBecomesKernelDeny(t *testing.T) {
	ps := []policy.Policy{{ID: "p", Name: "P", Enabled: true, Default: policy.Allow, Rules: []policy.Rule{
		{ID: "ssh", Decision: policy.RequireApproval, Approval: &policy.Approval{Teams: []string{"sec"}},
			What: policy.Target{Paths: []string{"**/.ssh/id_ed25519"}}},
		{ID: "exfil", Decision: policy.RequireApproval, Approval: &policy.Approval{Teams: []string{"sec"}},
			What: policy.Target{Hosts: []string{"203.0.113.7", "10.0.0.0/8"}}},
	}}}
	r := compile(t, base, ps, web).Policy.RuleFor("claude-code")
	if !slices.Contains(r.FileDeny, "/.ssh/id_ed25519") {
		t.Fatalf("file_deny: %v", r.FileDeny)
	}
	if !slices.Equal(r.NetDeny, []string{"10.0.0.0/8", "203.0.113.7/32"}) {
		t.Fatalf("network_deny: %v", r.NetDeny)
	}
}

func TestUnsupportedClausesAreReportedWithReasons(t *testing.T) {
	ps := []policy.Policy{{ID: "p", Name: "P", Enabled: true, Default: policy.Allow, Rules: []policy.Rule{
		{ID: "a-args", Decision: policy.Deny, What: policy.Target{Binaries: []string{"git"}, Commands: []string{"git push --force*"}}},
		{ID: "b-host", Decision: policy.Deny, What: policy.Target{Hosts: []string{"pastebin.com"}}},
		{ID: "c-mcp", Decision: policy.Deny, What: policy.Target{MCPServers: []string{"github"}, MCPTools: []string{"delete_repo"}}},
		{ID: "d-ok", Decision: policy.Deny, What: policy.Target{Binaries: []string{"/usr/bin/scp"}}},
	}}}
	out := compile(t, base, ps, web)

	type key struct{ rule, field, value string }
	got := map[key]Finding{}
	for _, f := range out.Findings {
		if f.Reason == "" || f.Enforcement == "" {
			t.Fatalf("finding without reason/enforcement: %+v", f)
		}
		got[key{f.RuleID, f.Field, f.Value}] = f
	}
	for _, want := range []key{
		{"a-args", "what.commands", "git push --force*"},
		{"b-host", "what.hosts", "pastebin.com"},
		{"c-mcp", "what.mcp_servers", "github"},
		{"c-mcp", "what.mcp_tools", "delete_repo"},
	} {
		if f, ok := got[want]; !ok || f.Enforcement != HooksOnly {
			t.Fatalf("missing hooks_only finding %+v in %+v", want, out.Findings)
		}
	}
	for k := range got {
		if k.rule == "d-ok" {
			t.Fatalf("enforceable rule reported: %+v", k)
		}
	}
	r := out.Policy.RuleFor("codex")
	if slices.Contains(r.ExecDeny, "/usr/bin/git") {
		t.Fatal("an argument-level deny must not block the whole program")
	}
	if !slices.Contains(r.ExecDeny, "/usr/bin/scp") {
		t.Fatal("enforceable rule missing")
	}
}

func TestPatternsAndDefaultsAreReported(t *testing.T) {
	ps := []policy.Policy{{ID: "p", Name: "P", Enabled: true, Default: policy.Deny, Rules: []policy.Rule{
		{ID: "glob", Decision: policy.Deny, What: policy.Target{Paths: []string{"/home/*/secrets/*.pem"}}},
		{ID: "prefix", Decision: policy.Deny, What: policy.Target{Binaries: []string{"/opt/tools/*"}}},
		{ID: "write-only", Decision: policy.Deny, What: policy.Target{Classes: []action.Class{action.FileWrite}, Paths: []string{"**/.bashrc"}}},
		{ID: "mixed", Decision: policy.Deny, What: policy.Target{Binaries: []string{"ssh"}, Hosts: []string{"10.1.2.3"}}},
		{ID: "unknown-agent", Decision: policy.Deny, Who: policy.Selector{AgentTypes: []string{"devin"}}, What: policy.Target{Binaries: []string{"curl"}}},
	}}}
	out := compile(t, base, ps, web)
	fields := map[string]string{}
	for _, f := range out.Findings {
		fields[f.RuleID+"/"+f.Field] = string(f.Enforcement)
	}
	for k, want := range map[string]string{
		"glob/what.paths":               "hooks_only",
		"prefix/what.binaries":          "hooks_only",
		"write-only/what.classes":       "hooks_only",
		"mixed/what":                    "hooks_only",
		"unknown-agent/who.agent_types": "not_enforced",
		"/default":                      "hooks_only",
	} {
		if fields[k] != want {
			t.Fatalf("%s: got %q want %q (all: %v)", k, fields[k], want, fields)
		}
	}
	r := out.Policy.RuleFor("claude-code")
	if slices.Contains(r.FileDeny, "/.bashrc") || slices.Contains(r.ExecDeny, "/usr/bin/ssh") {
		t.Fatalf("partially-expressible rule leaked into the kernel: %+v", r)
	}
}

func TestHigherPrecedenceAllowWins(t *testing.T) {
	ps := blockCurlForPayments()
	ps = append(ps, policy.Policy{ID: "exc", Name: "Exception", Enabled: true, Priority: 1, Default: policy.Allow,
		Rules: []policy.Rule{{ID: "curl-ok", Decision: policy.Allow, Who: policy.Selector{Users: []string{"dana@acme.io"}},
			What: policy.Target{Binaries: []string{"/usr/bin/curl"}}}}})
	r := compile(t, base, ps, payments).Policy.RuleFor("codex")
	if slices.Contains(r.ExecDeny, "/usr/bin/curl") {
		t.Fatal("allow with higher precedence should win for /usr/bin/curl")
	}
	if !slices.Contains(r.ExecDeny, "/bin/curl") {
		t.Fatal("the deny still applies to the other paths")
	}
}

func TestNarrowAllowIsReportedNotHonoured(t *testing.T) {
	ps := blockCurlForPayments()
	ps[0].Rules = append(ps[0].Rules, policy.Rule{ID: "curl-internal", Priority: 0, Decision: policy.Allow,
		What: policy.Target{Binaries: []string{"curl"}, Commands: []string{"curl https://internal.acme.io/*"}}})
	out := compile(t, base, ps, payments)
	if !slices.Contains(out.Policy.RuleFor("codex").ExecDeny, "/usr/bin/curl") {
		t.Fatal("the kernel can't see arguments, so curl stays blocked")
	}
	if !slices.ContainsFunc(out.Findings, func(f Finding) bool {
		return f.RuleID == "curl-internal" && f.Field == "decision" && strings.Contains(f.Value, "/usr/bin/curl") && f.Agent == ""
	}) || len(out.Findings) != 1 {
		t.Fatalf("narrow allow not reported: %+v", out.Findings)
	}
}

func TestBaseDenyIsAFloor(t *testing.T) {
	ps := []policy.Policy{{ID: "p", Name: "P", Enabled: true, Default: policy.Allow, Rules: []policy.Rule{
		{ID: "nc-ok", Decision: policy.Allow, What: policy.Target{Binaries: []string{"/usr/bin/nc"}}}}}}
	out := compile(t, base, ps, web)
	if !slices.Contains(out.Policy.RuleFor("codex").ExecDeny, "/usr/bin/nc") {
		t.Fatal("base deny lifted")
	}
	if !slices.ContainsFunc(out.Findings, func(f Finding) bool { return f.RuleID == "nc-ok" && f.Enforcement == NotEnforced }) {
		t.Fatalf("floor not reported: %+v", out.Findings)
	}
}

func TestMonitorModeIsObserveOnly(t *testing.T) {
	b := strings.Replace(base, "mode: denylist", "mode: monitor", 1)
	out := compile(t, b, blockCurlForPayments(), payments)
	if out.Policy.RuleFor("codex").Mode != ep.Monitor {
		t.Fatal("compiler must not change the base mode")
	}
	if !slices.ContainsFunc(out.Findings, func(f Finding) bool { return f.Field == "mode" && f.Enforcement == ObserveOnly && f.Agent == "" }) {
		t.Fatalf("machine-wide observe_only not reported: %+v", out.Findings)
	}

	// Scoped to one agent: the finding names that agent only.
	ps := blockCurlForPayments()
	ps[0].Rules[0].Who.AgentTypes = []string{"codex"}
	out = compile(t, b, ps, payments)
	if len(out.Findings) != 1 || out.Findings[0].Agent != "codex" || out.Findings[0].Enforcement != ObserveOnly {
		t.Fatalf("want one observe_only finding for codex: %+v", out.Findings)
	}
}

func TestListEntriesCompileIndependently(t *testing.T) {
	ps := []policy.Policy{{ID: "p", Name: "P", Enabled: true, Default: policy.Allow, Rules: []policy.Rule{
		{ID: "net", Decision: policy.Deny, What: policy.Target{Hosts: []string{"pastebin.com", "10.0.0.0/8"}}},
		{ID: "bin", Decision: policy.Deny, What: policy.Target{Binaries: []string{"/opt/*", "wget"}}},
		{ID: "net-ok", Priority: -1, Decision: policy.Allow, What: policy.Target{Hosts: []string{"10.1.0.0/16"}}},
	}}}
	out := compile(t, base, ps, web)
	r := out.Policy.RuleFor("codex")
	if !slices.Contains(r.NetDeny, "10.0.0.0/8") || !slices.Contains(r.ExecDeny, "/usr/bin/wget") {
		t.Fatalf("valid entries dropped because a sibling entry isn't kernel-expressible: %+v", r)
	}
	want := map[string]bool{"net/what.hosts": false, "bin/what.binaries": false, "net-ok/decision": false}
	for _, f := range out.Findings {
		k := f.RuleID + "/" + f.Field
		if _, ok := want[k]; ok {
			want[k] = true
		}
	}
	for k, seen := range want {
		if !seen {
			t.Fatalf("missing %s in %+v", k, out.Findings)
		}
	}
}

func TestAllowlistModeRemovesDeniedPrograms(t *testing.T) {
	b := base + `  - name: aider
    binary_names: [aider]
    mode: allowlist
    exec_allow: [/usr/bin/git, /usr/bin/curl]
`
	out := compile(t, b, blockCurlForPayments(), payments)
	if got := out.Policy.RuleFor("aider").ExecAllow; !slices.Equal(got, []string{"/usr/bin/git"}) {
		t.Fatalf("exec_allow: %v", got)
	}
	ps := blockCurlForPayments()
	ps[0].Rules[0].What.Binaries = []string{"curl", "git"}
	if _, err := Compile([]byte(b), ps, payments, now); err == nil {
		t.Fatal("emptying an allowlist must fail the publish")
	}
}

func TestExpiredAndDisabled(t *testing.T) {
	past := now.Add(-time.Hour)
	ps := blockCurlForPayments()
	ps[0].Rules[0].ValidUntil = &past
	ps = append(ps, policy.Policy{ID: "off", Name: "Off", Rules: []policy.Rule{{ID: "x", Decision: policy.Deny, What: policy.Target{Binaries: []string{"wget"}}}}})
	out := compile(t, base, ps, payments)
	if slices.Contains(out.Policy.RuleFor("codex").ExecDeny, "/usr/bin/curl") || slices.Contains(out.Policy.RuleFor("codex").ExecDeny, "/usr/bin/wget") {
		t.Fatal("expired / disabled rules compiled")
	}
	n := 0
	for _, f := range out.Findings {
		if f.Enforcement == NotEnforced {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("want expired + disabled findings: %+v", out.Findings)
	}
}

func TestDeterministic(t *testing.T) {
	ps := []policy.Policy{
		blockCurlForPayments()[0],
		{ID: "b", Name: "B", Enabled: true, Default: policy.RequireApproval, Rules: []policy.Rule{
			{ID: "r1", Decision: policy.Deny, What: policy.Target{Hosts: []string{"10.0.0.0/8", "198.51.100.1", "evil.example"}}},
			{ID: "r2", Decision: policy.RequireApproval, Approval: &policy.Approval{Teams: []string{"sec"}}, What: policy.Target{Paths: []string{"**/.aws/credentials", "/etc/shadow"}}},
			{ID: "r3", Decision: policy.Deny, What: policy.Target{Binaries: []string{"wget", "nc", "/usr/bin/socat"}, Commands: []string{"x"}}},
			{ID: "r4", Decision: policy.Deny, What: policy.Target{Binaries: []string{"scp", "rsync"}}},
		}},
	}
	first := compile(t, base, ps, payments)
	firstJSON, _ := json.Marshal(first)
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 20; i++ {
		shuffled := slices.Clone(ps)
		rng.Shuffle(len(shuffled), func(a, b int) { shuffled[a], shuffled[b] = shuffled[b], shuffled[a] })
		for j := range shuffled {
			rs := slices.Clone(shuffled[j].Rules)
			rng.Shuffle(len(rs), func(a, b int) { rs[a], rs[b] = rs[b], rs[a] })
			shuffled[j].Rules = rs
		}
		out := compile(t, base, shuffled, payments)
		js, _ := json.Marshal(out)
		if !bytes.Equal(out.YAML, first.YAML) || !bytes.Equal(js, firstJSON) {
			t.Fatalf("run %d differs:\n%s\n---\n%s", i, out.YAML, first.YAML)
		}
	}
}

func TestDefaultBaseCompiles(t *testing.T) {
	out, err := Compile(ep.DefaultYAML, blockCurlForPayments(), payments, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ep.Parse(out.YAML); err != nil {
		t.Fatal(err)
	}
	if len(out.Policy.MCPServers) == 0 || !out.Policy.TrackOrphanMCP {
		t.Fatal("base detection settings lost")
	}
}
