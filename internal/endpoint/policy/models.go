package policy

import (
	"fmt"
	"slices"
	"strings"
)

// Models is what effigentd's local model gateway enforces (CLAUDE.md 2j):
// agents are pointed at it through their base URL (`effigentd
// install-gateway`), and it checks each request's model before forwarding it
// to the provider. Entries are model ids with * wildcards, matched ignoring
// case ("claude-sonnet-4-5*", "gpt-5*"). A deny wins; with allow set, any
// other model is refused. In monitor/learn mode a refused request is
// reported as would_block and forwarded.
type Models struct {
	ModelRule `yaml:",inline"`
	// RequireGateway makes an agent whose base URL is not effigentd's gateway
	// a model_endpoint action (agent hooks): denied, unless actions_approve
	// lists model_endpoint.
	RequireGateway bool `yaml:"require_gateway,omitempty" json:"require_gateway"`
	// Agents override allow / deny / max_tokens per agent (policy agent names).
	Agents map[string]ModelRule `yaml:"agents,omitempty" json:"agents"`
}

// ModelRule is one agent's model policy.
type ModelRule struct {
	Allow []string `yaml:"allow,omitempty" json:"allow"`
	Deny  []string `yaml:"deny,omitempty" json:"deny"`
	// MaxTokens caps the output tokens a request may ask for (0: no cap). A
	// request asking for more is lowered to the cap (Anthropic's thinking
	// budget too, below it), so the agent keeps working with shorter
	// answers; one that names no limit (Codex's Responses calls) is let
	// through and the provider's own limit applies.
	MaxTokens int `yaml:"max_tokens,omitempty" json:"max_tokens"`
}

// For merges an agent's overrides onto the defaults (a list it sets
// replaces the default one).
func (m Models) For(agent string) ModelRule {
	r := m.ModelRule
	if a, ok := m.Agents[agent]; ok {
		if a.Allow != nil {
			r.Allow = a.Allow
		}
		if a.Deny != nil {
			r.Deny = a.Deny
		}
		if a.MaxTokens != 0 {
			r.MaxTokens = a.MaxTokens
		}
	}
	return r
}

// Allows reports whether a model may be used; why says which entry refused it.
func (r ModelRule) Allows(model string) (ok bool, why string) {
	for _, p := range r.Deny {
		if ModelMatch(p, model) {
			return false, "models.deny " + p
		}
	}
	if len(r.Allow) == 0 {
		return true, ""
	}
	for _, p := range r.Allow {
		if ModelMatch(p, model) {
			return true, ""
		}
	}
	return false, "not in models.allow (" + strings.Join(r.Allow, ", ") + ")"
}

// Empty reports whether the rule restricts nothing.
func (r ModelRule) Empty() bool { return len(r.Allow)+len(r.Deny) == 0 && r.MaxTokens == 0 }

// ModelMatch matches a model id against a pattern where * is any run of
// characters, ignoring case.
func ModelMatch(p, s string) bool {
	p, s = strings.ToLower(strings.TrimSpace(p)), strings.ToLower(s)
	parts := strings.Split(p, "*")
	if len(parts) == 1 {
		return p == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	for _, part := range parts[1 : len(parts)-1] {
		i := strings.Index(s, part)
		if i < 0 {
			return false
		}
		s = s[i+len(part):]
	}
	return strings.HasSuffix(s, parts[len(parts)-1])
}

func (m Models) check() error {
	rules := map[string]ModelRule{"": m.ModelRule}
	for name, r := range m.Agents {
		if !nameRE.MatchString(name) {
			return fmt.Errorf("models.agents %q: use the policy's agent names (lowercase letters, digits and '-')", name)
		}
		rules[name] = r
	}
	for name, r := range rules {
		for _, p := range append(slices.Clone(r.Allow), r.Deny...) {
			if strings.Trim(p, " *") == "" {
				return fmt.Errorf("models entry %q would match every model; name one, e.g. claude-sonnet-4-5*", p)
			}
		}
		if r.MaxTokens < 0 {
			where := "models.max_tokens"
			if name != "" {
				where = "models.agents." + name + ".max_tokens"
			}
			return fmt.Errorf("%s must not be negative", where)
		}
	}
	return nil
}

// GatewayDeny is actions_deny as require_gateway makes it: model_endpoint
// is denied unless actions_approve asks for approval instead.
func (r Rule) GatewayDeny() []string {
	if !r.RequireGateway || listsKind(r.ActionsDeny, "model_endpoint") || listsKind(r.ActionsApprove, "model_endpoint") {
		return r.ActionsDeny
	}
	return append(slices.Clone(r.ActionsDeny), "model_endpoint")
}

func listsKind(list []string, kind string) bool {
	return slices.ContainsFunc(list, func(e string) bool { k, _, _ := strings.Cut(e, "@"); return k == kind })
}
