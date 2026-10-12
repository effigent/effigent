// Package policy holds effigentd's own policy format: how to recognise
// agents and MCP servers, and what each agent may exec / open. The Linux
// enforcer compiles a Rule into a pid-scoped Tetragon TracingPolicy.
package policy

import (
	_ "embed"
	"fmt"
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
	Defaults       Rule    `yaml:"defaults"`
	Agents         []Agent `yaml:"agents"`
	MCPServers     []MCP   `yaml:"mcp_servers"`
	TrackOrphanMCP bool    `yaml:"track_orphan_mcp"` // treat an MCP server with no known agent above it as its own agent
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
	for _, list := range [][]string{r.ExecDeny, r.ExecAllow} {
		for _, b := range list {
			if !strings.HasPrefix(b, "/") {
				return fmt.Errorf("exec path %q must be absolute (the kernel matches resolved paths)", b)
			}
		}
	}
	return nil
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
			if strings.Contains(args, s) {
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
