// Package policy holds effigentd's own policy format: how to recognise
// agents and MCP servers, and what each agent may exec / open. The Linux
// enforcer compiles a Rule into a pid-scoped Tetragon TracingPolicy.
package policy

import (
	_ "embed"
	"fmt"
	"net"
	"os"
	"path"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// CanarySuffix is a file every agent policy refuses to open, regardless of
// mode. `effigentd run` opens it until it gets EPERM: proof that the kernel
// policy for its pid is live, so it can exec the agent with no unenforced gap.
const CanarySuffix = "/.effigent-canary"

//go:embed default.yaml
var DefaultYAML []byte

type Mode string

const (
	Monitor   Mode = "monitor"   // observe; policy matches are reported as would_block
	Learn     Mode = "learn"     // monitor + record every binary the agent runs (GET /learned)
	Denylist  Mode = "denylist"  // block exec of exec_deny, files in file_deny
	Allowlist Mode = "allowlist" // block exec of anything not in exec_allow, files in file_deny
)

// Rule is the effective policy for one agent. Every field in Defaults can be
// overridden per agent; unset fields fall back to Defaults.
type Rule struct {
	Mode      Mode     `yaml:"mode,omitempty" json:"mode"`
	ExecDeny  []string `yaml:"exec_deny,omitempty" json:"exec_deny"`
	ExecAllow []string `yaml:"exec_allow,omitempty" json:"exec_allow"`
	FileAlert []string `yaml:"file_alert,omitempty" json:"file_alert"` // path suffixes
	FileDeny  []string `yaml:"file_deny,omitempty" json:"file_deny"`   // path suffixes
	Network   *bool    `yaml:"network,omitempty" json:"network"`       // report outbound TCP connects
	// NetDeny blocks connections to these IPs/CIDRs. NetAllow, when set,
	// blocks every destination outside it (loopback is always allowed).
	NetDeny  []string `yaml:"network_deny,omitempty" json:"network_deny"`
	NetAllow []string `yaml:"network_allow,omitempty" json:"network_allow"`
	// DomainDeny blocks connections to these hostnames: effigentd resolves
	// them continuously and blocks every IP they resolve to (exact names;
	// list www.example.com separately). Shared CDN addresses can over-block
	// or miss; NetAllow is the stronger control.
	DomainDeny []string `yaml:"domain_deny,omitempty" json:"domain_deny"`
	// DNSGuard is set by effigentd, never by policy authors: while
	// domain_deny is in force, agents may not reach these resolver
	// addresses on DNS ports, nor any address on port 853 (DNS over TLS).
	DNSGuard []string `yaml:"-" json:"-"`
	// RequireLauncher stops agents that were not started with `effigentd run`
	// (which guarantees enforcement from the agent's first instruction).
	RequireLauncher *bool `yaml:"require_launcher,omitempty" json:"require_launcher"`

	// ToolDeny refuses agent tools by name, exact or prefix with a trailing *
	// (e.g. "mcp__claude-in-chrome__*", "WebFetch"). Agent hooks only: the
	// kernel can't see tool calls.
	ToolDeny []string `yaml:"tool_deny,omitempty" json:"tool_deny"`

	// Approval lists: a match pauses the agent's tool call and asks an
	// approver (Slack / email / console) instead of denying outright. Only an
	// agent hook can pause (macOS, Windows); in the kernel (Linux) the
	// exec/file/domain/network lists are enforced as denies and the
	// command/tool lists can't be seen. A deny list always wins.
	ExecApprove    []string `yaml:"exec_approve,omitempty" json:"exec_approve"`       // absolute paths, matched by program name in hooks
	FileApprove    []string `yaml:"file_approve,omitempty" json:"file_approve"`       // path suffixes
	DomainApprove  []string `yaml:"domain_approve,omitempty" json:"domain_approve"`   // hostnames (and their subdomains, in hooks)
	NetApprove     []string `yaml:"network_approve,omitempty" json:"network_approve"` // IPs / CIDRs
	CommandApprove []string `yaml:"command_approve,omitempty" json:"command_approve"` // "git push*": a command line, exact or prefix with a trailing *
	ToolApprove    []string `yaml:"tool_approve,omitempty" json:"tool_approve"`       // agent tool names, e.g. "mcp__github__*", "WebFetch"
}

// Approvals tunes the approval flow for the whole machine.
type Approvals struct {
	// WaitSeconds is how long a paused tool call waits for a decision before
	// the agent is told the request is still pending (default 45, max 90). The
	// agent's own hook timeout caps it in practice (effigent hook: ~18s); an
	// approval given later is used when the agent retries the same call.
	WaitSeconds int `yaml:"wait_seconds,omitempty" json:"wait_seconds"`
	// TTLMinutes is how long a request stays open for approvers (default 60).
	TTLMinutes int `yaml:"ttl_minutes,omitempty" json:"ttl_minutes"`
}

// MaxApprovalWait caps Approvals.WaitSeconds: the agent's hook process must
// outlive the wait (see `effigentd hook`, `install-hooks`).
const MaxApprovalWait = 90

// Wait returns the effective wait.
func (a Approvals) Wait() int {
	switch {
	case a.WaitSeconds <= 0:
		return 45
	case a.WaitSeconds > MaxApprovalWait:
		return MaxApprovalWait
	}
	return a.WaitSeconds
}

// TTL returns the effective request lifetime in minutes.
func (a Approvals) TTL() int {
	if a.TTLMinutes <= 0 {
		return 60
	}
	return min(a.TTLMinutes, 7*24*60)
}

// NeedsApproval reports whether the rule has any approval list.
func (r Rule) NeedsApproval() bool {
	return len(r.ExecApprove)+len(r.FileApprove)+len(r.DomainApprove)+len(r.NetApprove)+len(r.CommandApprove)+len(r.ToolApprove) > 0
}

// Kernel is the rule as the kernel enforces it: the kernel can't pause and
// ask, so approval lists it can see become denies.
func (r Rule) Kernel() Rule {
	if !r.NeedsApproval() {
		return r
	}
	k := r
	k.ExecDeny = append(append([]string(nil), r.ExecDeny...), r.ExecApprove...)
	k.FileDeny = append(append([]string(nil), r.FileDeny...), r.FileApprove...)
	k.DomainDeny = append(append([]string(nil), r.DomainDeny...), r.DomainApprove...)
	k.NetDeny = append(append([]string(nil), r.NetDeny...), r.NetApprove...)
	if r.Mode == Allowlist && len(r.ExecApprove) > 0 {
		// in allowlist mode a program needing approval must not be allowed outright
		drop := map[string]bool{}
		for _, b := range r.ExecApprove {
			drop[b] = true
		}
		k.ExecAllow = nil
		for _, b := range r.ExecAllow {
			if !drop[b] {
				k.ExecAllow = append(k.ExecAllow, b)
			}
		}
	}
	return k
}

type Agent struct {
	Name         string   `yaml:"name"`
	BinaryNames  []string `yaml:"binary_names,omitempty"`  // basename of the exec'd binary
	ArgsContains []string `yaml:"args_contains,omitempty"` // substring of the arguments (node/python agents)
	Rule         `yaml:",inline"`
}

type MCP struct {
	Pattern string `yaml:"pattern"` // regex on "binary args"; first capture group names the server
	Name    string `yaml:"name,omitempty"`
	re      *regexp.Regexp
}

type Policy struct {
	Defaults       Rule      `yaml:"defaults"`
	Agents         []Agent   `yaml:"agents"`
	MCPServers     []MCP     `yaml:"mcp_servers"`
	TrackOrphanMCP bool      `yaml:"track_orphan_mcp"` // treat an MCP server with no known agent above it as its own agent
	Approvals      Approvals `yaml:"approvals,omitempty"`
}

func Load(file string) (*Policy, []byte, error) {
	raw := DefaultYAML
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, nil, err
		}
		raw = b
	}
	p, err := Parse(raw)
	return p, raw, err
}

func Parse(raw []byte) (*Policy, error) {
	var p Policy
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("parse policy: %w", err)
	}
	return &p, p.validate()
}

var nameRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

func (p *Policy) validate() error {
	if p.Defaults.Mode == "" {
		p.Defaults.Mode = Monitor
	}
	p.Defaults.DomainDeny = normalizeHosts(p.Defaults.DomainDeny)
	p.Defaults.DomainApprove = normalizeHosts(p.Defaults.DomainApprove)
	for i := range p.Agents {
		p.Agents[i].DomainDeny = normalizeHosts(p.Agents[i].DomainDeny)
		p.Agents[i].DomainApprove = normalizeHosts(p.Agents[i].DomainApprove)
	}
	if p.Approvals.WaitSeconds < 0 || p.Approvals.WaitSeconds > MaxApprovalWait {
		return fmt.Errorf("approvals.wait_seconds must be between 0 and %d", MaxApprovalWait)
	}
	if p.Approvals.TTLMinutes < 0 || p.Approvals.TTLMinutes > 7*24*60 {
		return fmt.Errorf("approvals.ttl_minutes must be between 0 and %d (a week)", 7*24*60)
	}
	seen := map[string]bool{}
	for _, a := range p.Agents {
		if !nameRE.MatchString(a.Name) {
			return fmt.Errorf("agent name %q: use lowercase letters, digits and '-'", a.Name)
		}
		if seen[a.Name] {
			return fmt.Errorf("agent %q defined twice", a.Name)
		}
		seen[a.Name] = true
		if len(a.BinaryNames) == 0 && len(a.ArgsContains) == 0 {
			return fmt.Errorf("agent %q: needs binary_names or args_contains", a.Name)
		}
		if err := p.RuleFor(a.Name).check(); err != nil {
			return fmt.Errorf("agent %q: %w", a.Name, err)
		}
	}
	if err := p.RuleFor("").check(); err != nil {
		return fmt.Errorf("defaults: %w", err)
	}
	for i := range p.MCPServers {
		re, err := regexp.Compile(p.MCPServers[i].Pattern)
		if err != nil {
			return fmt.Errorf("mcp_servers[%d]: %w", i, err)
		}
		p.MCPServers[i].re = re
	}
	return nil
}

func (r Rule) check() error {
	switch r.Mode {
	case Monitor, Learn, Denylist:
	case Allowlist:
		if len(r.ExecAllow) == 0 {
			return fmt.Errorf("allowlist mode with an empty exec_allow would block every exec")
		}
	default:
		return fmt.Errorf("unknown mode %q", r.Mode)
	}
	for _, h := range r.DomainDeny {
		if err := checkHost(h); err != nil {
			return err
		}
	}
	for _, h := range r.DomainApprove {
		if err := checkHost(h); err != nil {
			return fmt.Errorf("%s", strings.ReplaceAll(err.Error(), "domain_deny", "domain_approve"))
		}
	}
	for _, list := range [][]string{r.CommandApprove, r.ToolApprove, r.ToolDeny} {
		for _, pat := range list {
			if strings.TrimSpace(pat) == "" || pat == "*" {
				return fmt.Errorf("command_approve / tool_approve / tool_deny entry %q would match everything; name a command or tool", pat)
			}
		}
	}
	for _, list := range [][]string{r.NetDeny, r.NetAllow, r.NetApprove} {
		for _, c := range list {
			if _, err := ParseCIDR(c); err != nil {
				return err
			}
		}
	}
	for _, list := range [][]string{r.ExecDeny, r.ExecAllow, r.ExecApprove} {
		for _, b := range list {
			if !strings.HasPrefix(b, "/") {
				return fmt.Errorf("exec path %q must be absolute (the kernel matches resolved paths)", b)
			}
		}
	}
	return nil
}

var hostRE = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func normalizeHosts(in []string) []string {
	if in == nil {
		return nil
	}
	out := make([]string, len(in))
	for i, h := range in {
		out[i] = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
	}
	return out
}

func checkHost(h string) error {
	switch {
	case net.ParseIP(h) != nil || strings.Contains(h, "/") && net.ParseIP(strings.SplitN(h, "/", 2)[0]) != nil:
		return fmt.Errorf("domain_deny %q is an address; put IPs and CIDRs in network_deny", h)
	case strings.HasPrefix(h, "*."):
		return fmt.Errorf("domain_deny %q: subdomains can't be discovered through DNS; list each hostname (e.g. www.%s)", h, h[2:])
	case strings.Contains(h, "://") || strings.ContainsAny(h, "/:"):
		return fmt.Errorf("domain_deny %q: use a bare hostname like example.com (no scheme, port or path)", h)
	case !strings.Contains(h, "."):
		return fmt.Errorf("domain_deny %q: single-label names are not supported; use the full name (e.g. wiki.corp.example)", h)
	case len(h) > 253 || !hostRE.MatchString(h):
		return fmt.Errorf("domain_deny %q: not a valid hostname (e.g. pastebin.com)", h)
	}
	return nil
}

// Domains returns every hostname any rule denies in the kernel (domain_deny
// and domain_approve).
func (p *Policy) Domains() []string {
	seen := map[string]bool{}
	var out []string
	add := func(r Rule) {
		for _, h := range r.Kernel().DomainDeny {
			if !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	add(p.Defaults)
	for _, a := range p.Agents {
		add(p.RuleFor(a.Name))
	}
	return out
}

// Launcher reports whether the rule requires agents to start via `effigentd run`.
func (r Rule) Launcher() bool { return r.RequireLauncher != nil && *r.RequireLauncher }

// ParseCIDR accepts "1.2.3.4", "10.0.0.0/8" or IPv6 forms and returns the
// canonical CIDR the kernel matcher expects.
func ParseCIDR(s string) (string, error) {
	if ip := net.ParseIP(s); ip != nil {
		if ip.To4() != nil {
			return ip.String() + "/32", nil
		}
		return ip.String() + "/128", nil
	}
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		return "", fmt.Errorf("network address %q: use an IP or CIDR like 10.0.0.0/8", s)
	}
	return n.String(), nil
}

// RuleFor merges an agent's overrides onto Defaults. "" returns Defaults.
func (p *Policy) RuleFor(agent string) Rule {
	r := p.Defaults
	for _, a := range p.Agents {
		if a.Name != agent {
			continue
		}
		if a.Mode != "" {
			r.Mode = a.Mode
		}
		if a.ExecDeny != nil {
			r.ExecDeny = a.ExecDeny
		}
		if a.ExecAllow != nil {
			r.ExecAllow = a.ExecAllow
		}
		if a.FileAlert != nil {
			r.FileAlert = a.FileAlert
		}
		if a.FileDeny != nil {
			r.FileDeny = a.FileDeny
		}
		if a.NetDeny != nil {
			r.NetDeny = a.NetDeny
		}
		if a.NetAllow != nil {
			r.NetAllow = a.NetAllow
		}
		if a.DomainDeny != nil {
			r.DomainDeny = a.DomainDeny
		}
		if a.RequireLauncher != nil {
			r.RequireLauncher = a.RequireLauncher
		}
		if a.ExecApprove != nil {
			r.ExecApprove = a.ExecApprove
		}
		if a.FileApprove != nil {
			r.FileApprove = a.FileApprove
		}
		if a.DomainApprove != nil {
			r.DomainApprove = a.DomainApprove
		}
		if a.NetApprove != nil {
			r.NetApprove = a.NetApprove
		}
		if a.CommandApprove != nil {
			r.CommandApprove = a.CommandApprove
		}
		if a.ToolApprove != nil {
			r.ToolApprove = a.ToolApprove
		}
		if a.ToolDeny != nil {
			r.ToolDeny = a.ToolDeny
		}
		if a.Network != nil {
			r.Network = a.Network
		}
	}
	return r
}

// MatchAgent returns the name of the agent rule matching an exec, or "".
func (p *Policy) MatchAgent(binary, args string) string {
	base := path.Base(binary)
	for _, a := range p.Agents {
		for _, n := range a.BinaryNames {
			if base == n {
				return a.Name
			}
		}
		for _, s := range a.ArgsContains {
			// The binary path counts too: native installs live under the
			// package dir (…/@anthropic-ai/claude-code/bin/claude.exe).
			if strings.Contains(args, s) || strings.Contains(binary, s) {
				return a.Name
			}
		}
	}
	return ""
}

// MatchMCP returns a label like "github" if the exec looks like an MCP server.
func (p *Policy) MatchMCP(binary, args string) string {
	s := binary + " " + args
	for _, m := range p.MCPServers {
		sub := m.re.FindStringSubmatch(s)
		if sub == nil {
			continue
		}
		if m.Name != "" {
			return m.Name
		}
		if len(sub) > 1 && sub[1] != "" {
			return strings.ToLower(sub[1])
		}
		return "unknown"
	}
	return ""
}
