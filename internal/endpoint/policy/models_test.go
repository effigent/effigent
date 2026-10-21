package policy

import (
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const modelsYAML = `defaults:
  mode: denylist
agents:
  - name: claude-code
    binary_names: [claude]
  - name: codex
    binary_names: [codex]
models:
  allow: ["claude-*-4-5*", "claude-haiku-*", "gpt-5*"]
  deny: ["*opus*"]
  max_tokens: 64000
  require_gateway: true
  agents:
    codex:
      allow: ["gpt-5-codex*"]
      max_tokens: 32000
`

func TestModelsSection(t *testing.T) {
	p, err := Parse([]byte(modelsYAML))
	if err != nil {
		t.Fatal(err)
	}
	cc, cx := p.RuleFor("claude-code"), p.RuleFor("codex")
	if !cc.RequireGateway || !cx.RequireGateway {
		t.Fatal("require_gateway not carried to the agents' rules")
	}
	for _, c := range []struct {
		r     Rule
		model string
		ok    bool
	}{
		{cc, "claude-sonnet-4-5-20250929", true},
		{cc, "CLAUDE-HAIKU-4-5", true},
		{cc, "claude-opus-4-5-20251101", false}, // deny wins over allow
		{cc, "claude-3-7-sonnet-latest", false}, // not in allow
		{cc, "gpt-5", true},
		{cx, "gpt-5-codex", true},
		{cx, "gpt-5", false}, // codex's own allow replaces the default one
		{cx, "o3-opus", false},
	} {
		if ok, why := c.r.Models.Allows(c.model); ok != c.ok {
			t.Errorf("%s: allowed=%v (%s), want %v", c.model, ok, why, c.ok)
		}
	}
	if cc.Models.MaxTokens != 64000 || cx.Models.MaxTokens != 32000 {
		t.Errorf("max_tokens = %d / %d", cc.Models.MaxTokens, cx.Models.MaxTokens)
	}
	if !slices.Equal(cx.Models.Deny, []string{"*opus*"}) {
		t.Errorf("codex keeps the default deny, got %v", cx.Models.Deny)
	}
	// the section survives a marshal / parse round trip (the control plane
	// compiles the base policy into YAML again)
	out, err := yaml.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	again, err := Parse(out)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := again.RuleFor("codex").Models; !slices.Equal(got.Allow, cx.Models.Allow) || got.MaxTokens != 32000 || !again.Models.RequireGateway {
		t.Errorf("round trip: %+v", got)
	}
}

func TestRequireGatewayDeniesModelEndpoint(t *testing.T) {
	r := Rule{RequireGateway: true, ActionsDeny: []string{"force_push"}}
	if got := r.GatewayDeny(); !slices.Equal(got, []string{"force_push", "model_endpoint"}) {
		t.Errorf("GatewayDeny = %v", got)
	}
	if len(r.ActionsDeny) != 1 {
		t.Error("GatewayDeny changed the rule's own list")
	}
	r.ActionsApprove = []string{"model_endpoint"} // approval instead of a deny
	if got := r.GatewayDeny(); !slices.Equal(got, []string{"force_push"}) {
		t.Errorf("with actions_approve: %v", got)
	}
	if got := (Rule{ActionsDeny: []string{"x"}}).GatewayDeny(); !slices.Equal(got, []string{"x"}) {
		t.Errorf("without require_gateway: %v", got)
	}
}

func TestModelsValidation(t *testing.T) {
	for _, c := range []struct{ yaml, want string }{
		{"models:\n  allow: ['*']\n", "would match every model"},
		{"models:\n  deny: [' ']\n", "would match every model"},
		{"models:\n  max_tokens: -1\n", "must not be negative"},
		{"models:\n  agents:\n    Codex: {allow: [gpt-5]}\n", "agent names"},
		{"models:\n  alow: [x]\n", "alow"},
	} {
		_, err := Parse([]byte(c.yaml))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%q: %v, want %q", c.yaml, err, c.want)
		}
	}
}

func TestModelMatch(t *testing.T) {
	for _, c := range []struct {
		p, s string
		ok   bool
	}{
		{"claude-sonnet-4-5", "claude-sonnet-4-5", true},
		{"claude-sonnet-4-5", "claude-sonnet-4-5-20250929", false},
		{"claude-sonnet-4-5*", "claude-sonnet-4-5-20250929", true},
		{"*-4-5*", "claude-haiku-4-5", true},
		{"claude-*-4*", "claude-opus-4-1", true},
		{"claude-*-4*", "claude-3-opus", false},
		{"gpt-*-mini", "gpt-5-mini", true},
		{"gpt-*-mini", "gpt-5-mini-2025", false},
		{"*opus*", "claude-opus-4", true},
	} {
		if got := ModelMatch(c.p, c.s); got != c.ok {
			t.Errorf("ModelMatch(%q, %q) = %v", c.p, c.s, got)
		}
	}
}
