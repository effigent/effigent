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
	"slices"
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

	// What a command or tool call does, as an agent hook reads it (never the
	// kernel): see ActionKinds. An entry is a kind, or kind@environment to
	// match only actions on that environment's targets ("cloud_change@prod").
	ActionsDeny    []string `yaml:"actions_deny,omitempty" json:"actions_deny"`
	ActionsApprove []string `yaml:"actions_approve,omitempty" json:"actions_approve"`
	// CommandDeny refuses command lines like command_approve pauses them.
	CommandDeny []string `yaml:"command_deny,omitempty" json:"command_deny"`
	// Writes only (Write/Edit tools, redirects, cp/mv/tee/sed -i targets…):
	// path suffixes, and a trailing / for everything under a directory
	// ("/.github/workflows/"). Hooks only.
	FileWriteDeny    []string `yaml:"file_write_deny,omitempty" json:"file_write_deny"`
	FileWriteApprove []string `yaml:"file_write_approve,omitempty" json:"file_write_approve"`
	// ProtectedBranches for protected_push ("release/*"); empty means
	// main, master, trunk, prod, production, release*.
	ProtectedBranches []string `yaml:"protected_branches,omitempty" json:"protected_branches"`
	// Packages, as ecosystem:name[@version] with * wildcards ("npm:event-stream",
	// "pypi:colourama", "npm:@acme-internal/*"). PackageAllow, when set, makes
	// every other package an install names (or a manifest lists) package_unlisted.
	PackageDeny    []string `yaml:"package_deny,omitempty" json:"package_deny"`
	PackageApprove []string `yaml:"package_approve,omitempty" json:"package_approve"`
	PackageAllow   []string `yaml:"package_allow,omitempty" json:"package_allow"`
	// PackageRegistries are the registries installs may use (URL prefixes);
	// another one, a URL/git spec or an extra index is package_registry.
	PackageRegistries []string `yaml:"package_registries,omitempty" json:"package_registries"`
	// MCPAllow names the MCP servers agents may call ("github", "linear*");
	// a call to any other is mcp_unlisted.
	MCPAllow []string `yaml:"mcp_allow,omitempty" json:"mcp_allow"`
	// ModelHostsAllow are the model API hosts agents may be configured for
	// (ANTHROPIC_BASE_URL, OPENAI_BASE_URL…; the vendor default when unset);
	// another is model_endpoint.
	ModelHostsAllow []string `yaml:"model_hosts_allow,omitempty" json:"model_hosts_allow"`

	// Environments is set by effigentd from the policy's top-level
	// environments, never by policy authors.
	Environments map[string]Environment `yaml:"-" json:"-"`
}

// Environment names the targets that make an action part of an environment
// such as prod: cloud identities, database and service hosts, MCP servers.
// Patterns match exactly or with * wildcards; hosts also take IPs and CIDRs.
type Environment struct {
	AWSProfiles        []string `yaml:"aws_profiles,omitempty" json:"aws_profiles"`
	AWSAccounts        []string `yaml:"aws_accounts,omitempty" json:"aws_accounts"`
	KubeContexts       []string `yaml:"kube_contexts,omitempty" json:"kube_contexts"`
	GCloudProjects     []string `yaml:"gcloud_projects,omitempty" json:"gcloud_projects"`
	AzureSubscriptions []string `yaml:"azure_subscriptions,omitempty" json:"azure_subscriptions"` // id or name
	TerraformWorkspace []string `yaml:"terraform_workspaces,omitempty" json:"terraform_workspaces"`
	PulumiStacks       []string `yaml:"pulumi_stacks,omitempty" json:"pulumi_stacks"`
	Hosts              []string `yaml:"hosts,omitempty" json:"hosts"`
	MCPServers         []string `yaml:"mcp_servers,omitempty" json:"mcp_servers"`
	// MatchUnknown: a cloud or database action whose target can't be worked
	// out (no profile, context or host) counts as this environment.
	MatchUnknown bool `yaml:"match_unknown,omitempty" json:"match_unknown"`
}

// ActionKinds are the actions an agent hook recognises in commands and tool
// calls, for actions_deny / actions_approve.
var ActionKinds = map[string]string{
	"protected_push":     "git push to a protected branch (or a merge of a pull request with gh)",
	"force_push":         "git push --force / --force-with-lease / +refspec / --mirror",
	"branch_delete":      "deleting a branch, locally or on the remote",
	"history_rewrite":    "git reset --hard, clean -f, filter-branch / filter-repo",
	"hook_bypass":        "git --no-verify, HUSKY=0",
	"destructive_sql":    "DROP, TRUNCATE, ALTER … DROP, DELETE/UPDATE without WHERE, database resets",
	"sql_write":          "any statement or migration that changes a database (includes destructive_sql)",
	"cloud_change":       "a cloud or cluster command that changes something (includes cloud_destroy)",
	"cloud_destroy":      "terminating, deleting or destroying cloud or cluster resources",
	"access":             "any command or tool call that reaches a cloud, cluster, database or named host (use with @env)",
	"package_install":    "installing a package by name (npm, pip, uv, poetry, cargo, go, gem, brew, npx…)",
	"package_unlisted":   "a package outside package_allow",
	"package_registry":   "an install from a registry outside package_registries (or a URL / git spec / extra index)",
	"package_scripts":    "an npm/pnpm/yarn/bun install that runs install scripts (no --ignore-scripts)",
	"package_malicious":  "a package listed as malicious in OSV (OpenSSF malicious packages); looked up online",
	"package_vulnerable": "a pinned package version with a known vulnerability in OSV; looked up online",
	"guardrail_edit":     "writing CI config, CODEOWNERS, git hooks, agent settings, shell startup files, cron, launchd, systemd",
	"credential_read":    "reading credential files or caches, or printing tokens or the environment",
	"remote_script":      "running a downloaded script (curl … | sh)",
	"fs_destroy":         "recursive deletes outside build output and temp directories",
	"mcp_unlisted":       "calling an MCP server outside mcp_allow",
	"model_endpoint":     "an agent configured for a model API host outside model_hosts_allow",
	"model_api_key":      "an agent running with a personal model API key in its environment",
	"mcp_changed":        "an MCP server whose definition (command, args, URL, env/header names) doesn't match its mcp_pins entry",
	"exfil_sequence":     "a network call to a host new to the session after a credential read in the session (last 50 calls / 30 min)",
	"untrusted_then_risky": "a risky action (fs_destroy, destructive_sql, cloud_destroy, force_push, guardrail_edit, remote_script, " +
		"credential_read) after outside content entered the session (WebFetch, WebSearch, unlisted MCP, curl/wget; last 50 calls / 30 min)",
}

// implied lets a broader kind match its narrower ones (sql_write covers
// destructive_sql) and access cover every action on a target.
var implied = map[string][]string{
	"sql_write":    {"destructive_sql"},
	"cloud_change": {"cloud_destroy"},
	"access":       {"cloud_change", "cloud_destroy", "sql_write", "destructive_sql"},
}

// KindCovers reports whether a policy kind covers an action's kind.
func KindCovers(policyKind, actionKind string) bool {
	return policyKind == actionKind || slices.Contains(implied[policyKind], actionKind)
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
	return len(r.ExecApprove)+len(r.FileApprove)+len(r.DomainApprove)+len(r.NetApprove)+len(r.CommandApprove)+len(r.ToolApprove)+
		len(r.ActionsApprove)+len(r.FileWriteApprove)+len(r.PackageApprove) > 0
}

// Kernel is the rule as the kernel enforces it: the kernel can't pause and
// ask, so approval lists it can see become denies.
//
// Directory entries (a trailing /) are left out: the kernel matches a path
// suffix, and only hooks match everything under a directory.
func (r Rule) Kernel() Rule {
	k := r
	k.FileAlert = filePaths(r.FileAlert)
	if !r.NeedsApproval() {
		k.FileDeny = filePaths(r.FileDeny)
		return k
	}
	k.ExecDeny = append(append([]string(nil), r.ExecDeny...), r.ExecApprove...)
	k.FileDeny = filePaths(append(append([]string(nil), r.FileDeny...), r.FileApprove...))
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

// filePaths drops directory entries (a trailing /); nil stays nil.
func filePaths(list []string) []string {
	if !slices.ContainsFunc(list, IsDirEntry) {
		return list
	}
	out := []string{}
	for _, p := range list {
		if !IsDirEntry(p) {
			out = append(out, p)
		}
	}
	return out
}

// IsDirEntry reports whether a file list entry names a directory tree.
func IsDirEntry(p string) bool { return strings.HasSuffix(p, "/") || strings.HasSuffix(p, `\`) }

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
	// Environments for kind@environment entries (actions_deny / actions_approve).
	Environments map[string]Environment `yaml:"environments,omitempty"`
	// Redact adds masks to the built-in secret redaction, applied on the
	// machine before any event leaves it.
	Redact Redaction `yaml:"redact,omitempty"`
}

// Redaction is the workspace's own masks: patterns (RE2) for internal ids,
// hostnames, customer data, and the optional PII set (emails, phone, card
// and IBAN numbers) for workplaces that must not collect them.
type Redaction struct {
	PII      bool         `yaml:"pii,omitempty" json:"pii"`
	Patterns []RedactRule `yaml:"patterns,omitempty" json:"patterns"`
}

type RedactRule struct {
	Name    string `yaml:"name" json:"name"`
	Pattern string `yaml:"pattern" json:"pattern"`
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
	if len(p.Redact.Patterns) > 50 {
		return fmt.Errorf("redact.patterns: at most 50")
	}
	for _, r := range p.Redact.Patterns {
		if !redactNameRE.MatchString(r.Name) {
			return fmt.Errorf("redact pattern name %q: 2-32 of a-z, 0-9, _ and -", r.Name)
		}
		re, err := regexp.Compile(r.Pattern)
		if err != nil || len(r.Pattern) > 300 {
			return fmt.Errorf("redact pattern %s: not a valid RE2 expression of at most 300 characters", r.Name)
		}
		if re.MatchString("") {
			return fmt.Errorf("redact pattern %s matches empty text", r.Name)
		}
	}
	for name, e := range p.Environments {
		if !nameRE.MatchString(name) {
			return fmt.Errorf("environment name %q: use lowercase letters, digits and '-'", name)
		}
		for _, h := range e.Hosts {
			if strings.Contains(h, "/") {
				if _, err := ParseCIDR(h); err != nil {
					return fmt.Errorf("environments.%s.hosts: %w", name, err)
				}
			}
		}
	}
	for _, name := range append([]string{""}, agentNames(p.Agents)...) {
		r := p.RuleFor(name)
		for _, list := range [][]string{r.ActionsDeny, r.ActionsApprove} {
			for _, a := range list {
				kind, env, _ := strings.Cut(a, "@")
				if _, ok := ActionKinds[kind]; !ok {
					return fmt.Errorf("actions entry %q: unknown kind %q (one of: %s)", a, kind, strings.Join(kindNames(), ", "))
				}
				if kind == "access" && env == "" {
					return fmt.Errorf("actions entry %q: access matches every cloud, database and named host; name an environment, e.g. access@prod", a)
				}
				if _, ok := p.Environments[env]; env != "" && !ok {
					return fmt.Errorf("actions entry %q: no environment %q under environments", a, env)
				}
			}
		}
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

var redactNameRE = regexp.MustCompile(`^[a-z0-9_-]{2,32}$`)

func agentNames(as []Agent) []string {
	out := make([]string, len(as))
	for i, a := range as {
		out[i] = a.Name
	}
	return out
}

func kindNames() []string {
	out := make([]string, 0, len(ActionKinds))
	for k := range ActionKinds {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
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
	for _, list := range [][]string{r.CommandApprove, r.CommandDeny, r.ToolApprove, r.ToolDeny, r.MCPAllow} {
		for _, pat := range list {
			if strings.Trim(pat, " *") == "" {
				return fmt.Errorf("command / tool / mcp entry %q would match everything; name a command, tool or server", pat)
			}
		}
	}
	for _, list := range [][]string{r.PackageDeny, r.PackageApprove, r.PackageAllow} {
		for _, pat := range list {
			if eco, name, ok := strings.Cut(pat, ":"); !ok || !Ecosystems[eco] || strings.Trim(name, " *") == "" {
				return fmt.Errorf("package entry %q: use ecosystem:name, e.g. npm:left-pad or pypi:requests (ecosystems: npm, pypi, cargo, go, gem, brew)", pat)
			}
		}
	}
	for _, u := range r.PackageRegistries {
		if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			return fmt.Errorf("package_registries entry %q: use the registry URL, e.g. https://npm.acme.internal/", u)
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

// Ecosystems are the package ecosystems package lists name.
var Ecosystems = map[string]bool{"npm": true, "pypi": true, "cargo": true, "go": true, "gem": true, "brew": true}

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
		if a.ActionsDeny != nil {
			r.ActionsDeny = a.ActionsDeny
		}
		if a.ActionsApprove != nil {
			r.ActionsApprove = a.ActionsApprove
		}
		if a.CommandDeny != nil {
			r.CommandDeny = a.CommandDeny
		}
		if a.FileWriteDeny != nil {
			r.FileWriteDeny = a.FileWriteDeny
		}
		if a.FileWriteApprove != nil {
			r.FileWriteApprove = a.FileWriteApprove
		}
		if a.ProtectedBranches != nil {
			r.ProtectedBranches = a.ProtectedBranches
		}
		if a.PackageDeny != nil {
			r.PackageDeny = a.PackageDeny
		}
		if a.PackageApprove != nil {
			r.PackageApprove = a.PackageApprove
		}
		if a.PackageAllow != nil {
			r.PackageAllow = a.PackageAllow
		}
		if a.PackageRegistries != nil {
			r.PackageRegistries = a.PackageRegistries
		}
		if a.MCPAllow != nil {
			r.MCPAllow = a.MCPAllow
		}
		if a.ModelHostsAllow != nil {
			r.ModelHostsAllow = a.ModelHostsAllow
		}
		if a.Network != nil {
			r.Network = a.Network
		}
	}
	r.Environments = p.Environments
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
