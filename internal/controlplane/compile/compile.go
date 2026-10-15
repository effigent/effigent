// Package compile turns central policies (internal/shared/policy: rules scoped
// to users, teams and agent types, with allow / deny / require_approval) into
// the endpoint policy one machine enforces (internal/endpoint/policy: per-agent
// modes, exec paths, file suffixes, IP/CIDR lists).
//
// The kernel can only block three things: exec of an exact resolved path, open
// of a path suffix, and connect to an IP/CIDR. Whatever else a rule says
// (arguments, tool names, MCP tools, hostnames, ports, OS users) is reported as
// a Finding, never dropped silently. require_approval compiles to the
// *_approve lists: an agent hook (macOS, Windows) pauses the call and asks an
// approver; the kernel (Linux) enforces them as denies.
//
// Precedence is not re-implemented here: every kernel entry is decided by the
// shared evaluator (policy.Evaluate) on a synthesized action, so what the
// console simulates and what the kernel blocks agree.
//
// Compile is a pure function of its inputs: lists and findings are sorted,
// and the clock is passed in (the policy version's publish time).
package compile

import (
	"bytes"
	"fmt"
	"net"
	"path"
	"slices"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	ep "github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/shared/action"
	"github.com/effigent/effigent/internal/shared/policy"
)

// ExecDirs is where a bare program name ("curl") is looked for. The kernel
// matches exact resolved paths, so "curl" becomes one exec_deny entry per dir.
var ExecDirs = []string{"/bin", "/sbin", "/usr/bin", "/usr/local/bin", "/usr/sbin"}

// Machine is the identity the control plane knows for one endpoint.
type Machine struct {
	EndpointID string   `json:"endpoint_id"`
	Hostname   string   `json:"hostname"`
	Owner      string   `json:"owner"` // console user id or email, matched against who.users
	Teams      []string `json:"teams"`
}

// Enforcement says how a clause the kernel can't block is handled instead.
type Enforcement string

const (
	// HooksOnly: the agent hook / approval flow sees it (tool names,
	// arguments, MCP calls, hostnames); the kernel does not.
	HooksOnly Enforcement = "hooks_only"
	// ObserveOnly: compiled into the kernel policy, but the agent runs in
	// monitor/learn mode, so matches are reported as would_block.
	ObserveOnly Enforcement = "observe_only"
	// NotEnforced: not compiled anywhere (disabled, expired, unknown agent).
	NotEnforced Enforcement = "not_enforced"
)

// Finding is one clause the kernel policy does not carry as written.
type Finding struct {
	PolicyID    string      `json:"policy_id,omitempty"`
	RuleID      string      `json:"rule_id,omitempty"`
	Field       string      `json:"field"`           // e.g. "what.commands", "default", "mode"
	Value       string      `json:"value,omitempty"` // the offending pattern, when there is one
	Agent       string      `json:"agent,omitempty"` // endpoint agent name, for per-agent findings
	Enforcement Enforcement `json:"enforcement"`
	Reason      string      `json:"reason"`
}

// Kernel is what the compiler added for one agent on top of the base policy.
type Kernel struct {
	Mode       ep.Mode  `json:"mode"`
	ExecDeny   []string `json:"exec_deny,omitempty"`
	FileDeny   []string `json:"file_deny,omitempty"`
	NetDeny    []string `json:"network_deny,omitempty"`
	ExecRemove []string `json:"exec_allow_removed,omitempty"` // allowlist mode: denied programs taken out of exec_allow
	// require_approval: a hook (macOS, Windows) pauses and asks; the kernel denies.
	ExecApprove []string `json:"exec_approve,omitempty"`
	FileApprove []string `json:"file_approve,omitempty"`
	NetApprove  []string `json:"network_approve,omitempty"`
}

type Output struct {
	Policy   *ep.Policy        `json:"-"`
	YAML     []byte            `json:"-"`
	Added    map[string]Kernel `json:"added"` // by agent name; "" is defaults
	Findings []Finding         `json:"findings"`
}

// DefaultsAgent is the key for the `defaults` rule (unknown agents, orphan MCP
// servers) in Output.Added; DefaultsLabel names it in a Finding (agent names
// can't contain parentheses).
const (
	DefaultsAgent = ""
	DefaultsLabel = "(defaults)"
)

// Compile produces the endpoint policy for one machine: the base endpoint
// policy (agent detection, MCP patterns, modes, alerts) with every kernel-
// enforceable rule that applies to this machine merged in. A base deny is a
// floor: a central allow can't lift it (reported).
func Compile(base []byte, policies []policy.Policy, m Machine, now time.Time) (*Output, error) {
	bp, err := ep.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("base policy: %w", err)
	}
	policies = sorted(policies)
	static := Static(bp, policies, now)
	var perAgent []Finding
	rules := classify(policies, now)

	out := &Output{Added: map[string]Kernel{}}
	agents := []string{DefaultsAgent}
	for _, a := range bp.Agents {
		agents = append(agents, a.Name)
	}
	merged := map[string]ep.Rule{}
	for _, name := range agents {
		sub := policy.Subject{AgentType: name, UserID: m.Owner, UserEmail: m.Owner, Teams: m.Teams,
			EndpointID: m.EndpointID, Hostname: m.Hostname}
		r, k, fs, err := compileAgent(bp.RuleFor(name), policies, rules, sub, now)
		if err != nil {
			label := name
			if label == "" {
				label = "defaults"
			}
			return nil, fmt.Errorf("%s: %w", label, err)
		}
		for i := range fs {
			fs[i].Agent = name
			if name == DefaultsAgent {
				fs[i].Agent = DefaultsLabel
			}
		}
		perAgent = append(perAgent, fs...)
		merged[name] = r
		if len(k.ExecDeny)+len(k.FileDeny)+len(k.NetDeny)+len(k.ExecRemove)+len(k.ExecApprove)+len(k.FileApprove)+len(k.NetApprove) > 0 {
			out.Added[name] = k
		}
	}

	// Defaults carry the defaults' result; an agent only overrides what differs.
	res := *bp
	res.Defaults = merged[DefaultsAgent]
	res.Agents = slices.Clone(bp.Agents)
	for i := range res.Agents {
		a := &res.Agents[i]
		a.Rule = overrides(res.Defaults, merged[a.Name])
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	fmt.Fprintf(&buf, "# Compiled by the effigent control plane for %s. Edit the central policy, not this file.\n", machineLabel(m))
	if err := enc.Encode(&res); err != nil {
		return nil, err
	}
	// The endpoint parses with the same function; never ship what it would refuse.
	parsed, err := ep.Parse(buf.Bytes())
	if err != nil {
		return nil, fmt.Errorf("compiled policy does not parse: %w", err)
	}
	for _, name := range agents {
		if !sameRule(parsed.RuleFor(name), merged[name]) {
			// e.g. an agent that opts out of a defaults list with `[]`,
			// which YAML omitempty can't carry.
			return nil, fmt.Errorf("agent %q: compiled policy does not round-trip; give it explicit lists in the base policy", name)
		}
	}
	out.Policy, out.YAML, out.Findings = parsed, buf.Bytes(), sortFindings(machineWide(static, perAgent, len(agents)))
	return out, nil
}

// machineWide collapses per-agent findings that every agent (and defaults)
// has into one finding without an agent.
func machineWide(static, perAgent []Finding, agents int) []Finding {
	count := map[Finding]int{}
	for _, f := range perAgent {
		f.Agent = ""
		count[f]++
	}
	out := static
	for _, f := range perAgent {
		g := f
		g.Agent = ""
		if count[g] == agents {
			f = g
		}
		out = append(out, f)
	}
	return out // sortFindings dedupes
}

func machineLabel(m Machine) string {
	s := m.Hostname
	if s == "" {
		s = m.EndpointID
	}
	if m.Owner != "" {
		s += " (owner " + m.Owner + ")"
	}
	return s
}

// ---- classification (machine-independent) ----

type dim int

const (
	dimNone dim = iota
	dimExec
	dimFile
	dimNet
)

// krule is a rule the kernel can enforce, reduced to its kernel atoms.
type krule struct {
	p     *policy.Policy
	r     *policy.Rule
	dim   dim
	atoms []string // absolute exec paths, path suffixes, or canonical CIDRs
}

func live(r *policy.Rule, now time.Time) bool {
	return !r.Disabled && (r.ValidUntil == nil || now.Before(*r.ValidUntil))
}

// classify returns the deny / require_approval rules whose whole target maps
// onto one kernel dimension. Static reports why the others don't.
func classify(policies []policy.Policy, now time.Time) []krule {
	var out []krule
	for i := range policies {
		p := &policies[i]
		if !p.Enabled {
			continue
		}
		for j := range p.Rules {
			r := &p.Rules[j]
			if !live(r, now) || r.Decision == policy.Allow {
				continue
			}
			if k, ok := kernelRule(p, r); ok {
				out = append(out, k)
			}
		}
	}
	return out
}

func kernelRule(p *policy.Policy, r *policy.Rule) (krule, bool) {
	for _, f := range problems(r) {
		if f.wholeRule {
			return krule{}, false
		}
	}
	k := krule{p: p, r: r, dim: dimOf(r.What)}
	// Entries in one list are alternatives: compile the ones the kernel can
	// match, the others are reported entry by entry.
	switch k.dim {
	case dimExec:
		for _, b := range r.What.Binaries {
			k.atoms = append(k.atoms, execPaths(b)...)
		}
	case dimFile:
		for _, g := range r.What.Paths {
			if s, ok := suffixOf(g); ok {
				k.atoms = append(k.atoms, s)
			}
		}
	case dimNet:
		for _, h := range r.What.Hosts {
			if c, err := ep.ParseCIDR(h); err == nil {
				k.atoms = append(k.atoms, c)
			}
		}
	}
	return k, len(k.atoms) > 0
}

func dimOf(t policy.Target) dim {
	n, d := 0, dimNone
	if len(t.Binaries) > 0 {
		n, d = n+1, dimExec
	}
	if len(t.Paths) > 0 {
		n, d = n+1, dimFile
	}
	if len(t.Hosts) > 0 {
		n, d = n+1, dimNet
	}
	if n != 1 {
		return dimNone
	}
	return d
}

// problem is a Finding plus whether it keeps the whole rule out of the kernel
// (a condition ANDed with the rule) or only one list entry.
type problem struct {
	Finding
	wholeRule bool
}

// problems lists why a rule, or some of its entries, can't be expressed in
// the kernel. Empty means all of it can.
func problems(r *policy.Rule) []problem {
	t := r.What
	var fs []problem
	whole := true
	add := func(field, value string, e Enforcement, reason string) {
		fs = append(fs, problem{Finding{RuleID: r.ID, Field: field, Value: value, Enforcement: e, Reason: reason}, whole})
	}
	each := func(field string, vals []string, reason string) {
		for _, v := range vals {
			add(field, v, HooksOnly, reason)
		}
	}
	each("who.os_users", r.Who.OSUsers, "the control plane doesn't know which OS user runs an agent, so the rule can't be scoped per machine")
	each("what.tools", t.Tools, "agent tool names are only visible to the agent hook, not the kernel")
	each("what.commands", t.Commands, "the kernel blocks a program by path, not by its arguments")
	each("what.mcp_servers", t.MCPServers, "MCP servers are only visible to the agent hook")
	each("what.mcp_tools", t.MCPTools, "MCP tool calls are only visible to the agent hook")
	for _, p := range t.Ports {
		add("what.ports", fmt.Sprint(p), HooksOnly, "the kernel matches destination addresses, not ports")
	}
	whole = false
	for _, b := range t.Binaries {
		if execPaths(b) == nil {
			add("what.binaries", b, HooksOnly, "the kernel matches exact program paths; use an absolute path or a bare program name, not a pattern")
		}
	}
	for _, g := range t.Paths {
		if _, ok := suffixOf(g); !ok {
			add("what.paths", g, HooksOnly, "the kernel matches a path suffix; use an absolute path or **/<name> without other wildcards")
		}
	}
	for _, h := range t.Hosts {
		if _, err := ep.ParseCIDR(h); err != nil {
			add("what.hosts", h, HooksOnly, "the kernel blocks IPs and CIDRs, not hostnames")
		}
	}
	whole = true
	d := dimOf(t)
	n := 0
	for _, l := range [][]string{t.Binaries, t.Paths, t.Hosts} {
		if len(l) > 0 {
			n++
		}
	}
	switch {
	case n > 1:
		add("what", "", HooksOnly, "the rule combines programs, paths and hosts; the kernel can enforce only one of them per rule")
	case n == 0 && !slices.ContainsFunc(fs, func(p problem) bool { return p.wholeRule }):
		add("what", "", HooksOnly, "the rule names no program, path or IP/CIDR the kernel could block")
	}
	misfit := false
	for _, c := range t.Classes {
		if !classFits(d, c) {
			add("what.classes", string(c), HooksOnly, "this class doesn't match what the rule names, so a kernel rule would never fire")
			misfit = true
			break
		}
	}
	if d == dimFile && !misfit && len(t.Classes) > 0 && !(slices.Contains(t.Classes, action.FileRead) && slices.Contains(t.Classes, action.FileWrite)) {
		add("what.classes", "", HooksOnly, "the kernel blocks file opens without telling reads from writes; a rule for only one of them can't be enforced there")
	}
	return fs
}

func classFits(d dim, c action.Class) bool {
	switch d {
	case dimExec:
		return c == action.Exec
	case dimFile:
		return c == action.FileRead || c == action.FileWrite
	case dimNet:
		return c == action.Network
	}
	return true // reported as "names nothing" already
}

// execPaths expands a binaries entry to the exact paths the kernel matches:
// an absolute path as is, a bare name in every ExecDirs dir. Patterns: nil.
func execPaths(b string) []string {
	if strings.ContainsAny(b, "*?[") || b == "" {
		return nil
	}
	if strings.HasPrefix(b, "/") {
		return []string{path.Clean(b)}
	}
	if strings.Contains(b, "/") {
		return nil
	}
	out := make([]string, 0, len(ExecDirs))
	for _, d := range ExecDirs {
		out = append(out, d+"/"+b)
	}
	return out
}

// suffixOf maps a path glob to the suffix the kernel matches (Postfix):
// "**/.env" -> "/.env", "/etc/shadow" -> "/etc/shadow".
func suffixOf(g string) (string, bool) {
	s, ok := strings.CutPrefix(g, "**")
	if !ok && !strings.HasPrefix(g, "/") {
		return "", false
	}
	if !strings.HasPrefix(s, "/") || len(s) < 2 || strings.ContainsAny(s, "*?[") || strings.HasSuffix(s, "/") {
		return "", false
	}
	return path.Clean(s), true
}

// Static reports what doesn't depend on the machine: clauses the kernel can't
// enforce, disabled or expired rules, policy defaults, unknown agent types.
func Static(base *ep.Policy, policies []policy.Policy, now time.Time) []Finding {
	known := map[string]bool{}
	for _, a := range base.Agents {
		known[a.Name] = true
	}
	var fs []Finding
	for _, p := range sorted(policies) {
		at := func(f Finding) Finding { f.PolicyID = p.ID; return f }
		if !p.Enabled {
			fs = append(fs, at(Finding{Field: "enabled", Enforcement: NotEnforced, Reason: "policy is disabled"}))
			continue
		}
		if p.Default == policy.Deny || p.Default == policy.RequireApproval {
			fs = append(fs, at(Finding{Field: "default", Value: string(p.Default), Enforcement: HooksOnly,
				Reason: "the kernel enforces explicit rules only; a default " + string(p.Default) + " for everything else is applied by the agent hook"}))
		}
		fs = append(fs, unknownAgents(p.Scope, known, "scope.agent_types", Finding{PolicyID: p.ID})...)
		for _, r := range p.Rules {
			if r.Disabled {
				continue
			}
			if r.ValidUntil != nil && !now.Before(*r.ValidUntil) {
				fs = append(fs, at(Finding{RuleID: r.ID, Field: "valid_until", Value: r.ValidUntil.UTC().Format(time.RFC3339),
					Enforcement: NotEnforced, Reason: "expired before this version was published; republish to re-evaluate"}))
				continue
			}
			fs = append(fs, unknownAgents(r.Who, known, "who.agent_types", Finding{PolicyID: p.ID, RuleID: r.ID})...)
			if r.Decision == policy.Allow {
				continue // an allow only matters as an exception; see compileAgent
			}
			for _, f := range problems(&r) {
				fs = append(fs, at(f.Finding))
			}
		}
	}
	return fs
}

func unknownAgents(s policy.Selector, known map[string]bool, field string, f Finding) []Finding {
	var fs []Finding
	for _, a := range s.AgentTypes {
		if !known[strings.ToLower(a)] {
			f.Field, f.Value, f.Enforcement = field, a, NotEnforced
			f.Reason = "no agent with this name in the endpoint policy's agents list, so effigentd can't recognise it"
			fs = append(fs, f)
		}
	}
	return fs
}

// ---- per agent ----

// probe is the synthesized action the shared evaluator decides for an atom.
func probe(d dim, atom string) []action.Action {
	switch d {
	case dimExec:
		return []action.Action{{Class: action.Exec, Binary: atom}}
	case dimFile:
		return []action.Action{{Class: action.FileRead, Paths: []string{atom}}, {Class: action.FileWrite, Paths: []string{atom}}}
	case dimNet:
		ip, _, _ := net.ParseCIDR(atom)
		return []action.Action{{Class: action.Network, Host: ip.String()}}
	}
	return nil
}

func compileAgent(base ep.Rule, policies []policy.Policy, rules []krule, sub policy.Subject, now time.Time) (ep.Rule, Kernel, []Finding, error) {
	var fs []Finding
	deny := map[dim]map[string]bool{dimExec: {}, dimFile: {}, dimNet: {}}
	// approve: atoms whose strict winners are all require_approval. They go to
	// the *_approve lists: a hook pauses and asks, the kernel denies.
	approve := map[dim]map[string]bool{dimExec: {}, dimFile: {}, dimNet: {}}
	for _, k := range rules {
		if !k.p.Scope.Matches(sub) || !k.r.Who.Matches(sub) {
			continue
		}
		for _, atom := range k.atoms {
			if deny[k.dim][atom] {
				continue
			}
			// The evaluator decides with every policy in play, so a
			// higher-precedence allow (e.g. /usr/bin/* for this team) wins.
			var winners []policy.Result
			for _, a := range probe(k.dim, atom) {
				winners = append(winners, policy.Evaluate(policies, sub, a, now))
			}
			strict, lenient, hard := 0, 0, 0
			for _, w := range winners {
				if w.RuleID != "" && w.Decision != policy.Allow {
					strict++
					if w.Decision == policy.Deny {
						hard++
					}
				} else {
					lenient++
				}
			}
			if strict == 0 {
				continue
			}
			if hard == 0 {
				approve[k.dim][atom] = true
				continue
			}
			deny[k.dim][atom] = true
			delete(approve[k.dim], atom)
			if lenient > 0 {
				fs = append(fs, Finding{PolicyID: k.p.ID, RuleID: k.r.ID, Field: "what.paths", Value: atom, Enforcement: HooksOnly,
					Reason: "denied for one of read/write and allowed for the other; the kernel blocks every open, the hook applies the distinction"})
			}
		}
	}

	// Allow rules the kernel can't carve out of a deny (narrower than a
	// program/path/CIDR), and allows that try to lift a base-policy deny.
	fs = append(fs, exceptions(policies, sub, deny, now)...)
	fs = append(fs, floor(base, policies, sub, now)...)

	r := base
	k := Kernel{Mode: base.Mode}
	execDeny := keys(deny[dimExec])
	switch base.Mode {
	case ep.Allowlist:
		// Allowlist mode ignores exec_deny: take denied programs out of exec_allow.
		var keep []string
		for _, b := range base.ExecAllow {
			if deny[dimExec][b] {
				k.ExecRemove = append(k.ExecRemove, b)
			} else {
				keep = append(keep, b)
			}
		}
		if len(keep) == 0 && len(base.ExecAllow) > 0 {
			return r, k, nil, fmt.Errorf("central deny rules remove every program from exec_allow; the agent could run nothing")
		}
		r.ExecAllow = keep
	default:
		r.ExecDeny, k.ExecDeny = union(base.ExecDeny, execDeny)
	}
	r.FileDeny, k.FileDeny = union(base.FileDeny, keys(deny[dimFile]))
	r.NetDeny, k.NetDeny = union(base.NetDeny, keys(deny[dimNet]))
	r.ExecApprove, k.ExecApprove = union(base.ExecApprove, keys(approve[dimExec]))
	r.FileApprove, k.FileApprove = union(base.FileApprove, keys(approve[dimFile]))
	r.NetApprove, k.NetApprove = union(base.NetApprove, keys(approve[dimNet]))
	if (base.Mode == ep.Monitor || base.Mode == ep.Learn) && len(k.ExecDeny)+len(k.FileDeny)+len(k.NetDeny) > 0 {
		fs = append(fs, Finding{Field: "mode", Value: string(base.Mode), Enforcement: ObserveOnly,
			Reason: "the endpoint policy runs this agent in " + string(base.Mode) + " mode, so compiled denies are reported as would_block, not blocked"})
	}
	return r, k, fs, nil
}

// exceptions reports allow rules that apply to sub but that the kernel can't
// carve out of a deny: the allow carries conditions the kernel can't see
// (arguments, tools, MCP, ports, OS user) or names a narrower CIDR. The kernel
// blocks the whole program / path / CIDR; only the hook / approval flow can
// let the narrower case through.
func exceptions(policies []policy.Policy, sub policy.Subject, deny map[dim]map[string]bool, now time.Time) []Finding {
	var fs []Finding
	for _, p := range policies {
		if !p.Enabled || !p.Scope.Matches(sub) {
			continue
		}
		for _, r := range p.Rules {
			who := r.Who
			who.OSUsers = nil // an allow for some OS user on this machine still loses to the kernel
			if r.Decision != policy.Allow || !live(&r, now) || !who.Matches(sub) {
				continue
			}
			t := r.What
			if len(t.Binaries)+len(t.Paths)+len(t.Hosts) == 0 {
				continue
			}
			var blocked []string
			report := func(atom string) {
				if !slices.Contains(blocked, atom) {
					blocked = append(blocked, atom)
				}
			}
			extra := len(r.Who.OSUsers)+len(t.Tools)+len(t.Commands)+len(t.MCPServers)+len(t.MCPTools)+len(t.Ports) > 0
			kernelOnly := policy.Target{Classes: t.Classes, Binaries: t.Binaries, Paths: t.Paths, Hosts: t.Hosts}
			for _, d := range []dim{dimExec, dimFile, dimNet} {
				for _, atom := range keys(deny[d]) {
					for _, a := range probe(d, atom) {
						if extra && kernelOnly.Matches(a) {
							report(atom)
							break
						}
					}
				}
			}
			// A narrower CIDR inside a denied one, where this allow wins.
			for _, h := range t.Hosts {
				c, err := ep.ParseCIDR(h)
				if err != nil {
					continue
				}
				ip := probe(dimNet, c)[0]
				for _, atom := range keys(deny[dimNet]) {
					_, n, _ := net.ParseCIDR(atom)
					if atom == c || !n.Contains(net.ParseIP(ip.Host)) {
						continue
					}
					if w := policy.Evaluate(policies, sub, ip, now); w.PolicyID == p.ID && w.RuleID == r.ID && !extra {
						report(atom)
					}
				}
			}
			if len(blocked) > 0 {
				slices.Sort(blocked)
				v := strings.Join(blocked, ", ")
				fs = append(fs, Finding{PolicyID: p.ID, RuleID: r.ID, Field: "decision", Value: v, Enforcement: HooksOnly,
					Reason: "this allow is narrower than what the kernel can express, so the kernel still blocks " + v + "; the exception needs the hook / approval flow"})
			}
		}
	}
	return fs
}

// floor reports central allows that would lift a deny in the base endpoint
// policy. The base is the floor; it stays denied.
func floor(base ep.Rule, policies []policy.Policy, sub policy.Subject, now time.Time) []Finding {
	var fs []Finding
	check := func(d dim, list []string) {
		for _, atom := range list {
			if d == dimNet {
				c, err := ep.ParseCIDR(atom)
				if err != nil {
					continue
				}
				atom = c
			}
			for _, a := range probe(d, atom) {
				if w := policy.Evaluate(policies, sub, a, now); w.RuleID != "" && w.Decision == policy.Allow {
					fs = append(fs, Finding{PolicyID: w.PolicyID, RuleID: w.RuleID, Field: "decision", Value: atom, Enforcement: NotEnforced,
						Reason: "the base endpoint policy denies " + atom + "; a central allow can't lift it (edit the base policy)"})
					break
				}
			}
		}
	}
	if base.Mode != ep.Allowlist {
		check(dimExec, base.ExecDeny)
	}
	check(dimFile, base.FileDeny)
	check(dimNet, base.NetDeny)
	return fs
}

// ---- helpers ----

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// union appends to base (order kept) what it doesn't already have, and
// returns the new entries too.
func union(base, add []string) (all, added []string) {
	all = slices.Clone(base)
	for _, a := range add {
		if !slices.Contains(all, a) {
			all = append(all, a)
			added = append(added, a)
		}
	}
	return all, added
}

// overrides keeps only the fields of r that differ from defaults, so the
// compiled YAML stays readable and RuleFor(agent) still returns r.
func overrides(def, r ep.Rule) ep.Rule {
	var o ep.Rule
	if r.Mode != def.Mode {
		o.Mode = r.Mode
	}
	list := func(d, v []string) []string {
		if slices.Equal(d, v) {
			return nil
		}
		if v == nil {
			return []string{}
		}
		return v
	}
	o.ExecDeny = list(def.ExecDeny, r.ExecDeny)
	o.ExecAllow = list(def.ExecAllow, r.ExecAllow)
	o.FileAlert = list(def.FileAlert, r.FileAlert)
	o.FileDeny = list(def.FileDeny, r.FileDeny)
	o.NetDeny = list(def.NetDeny, r.NetDeny)
	o.NetAllow = list(def.NetAllow, r.NetAllow)
	o.DomainDeny = list(def.DomainDeny, r.DomainDeny)
	o.ExecApprove = list(def.ExecApprove, r.ExecApprove)
	o.FileApprove = list(def.FileApprove, r.FileApprove)
	o.DomainApprove = list(def.DomainApprove, r.DomainApprove)
	o.NetApprove = list(def.NetApprove, r.NetApprove)
	o.CommandApprove = list(def.CommandApprove, r.CommandApprove)
	o.ToolApprove = list(def.ToolApprove, r.ToolApprove)
	if !eqBool(def.Network, r.Network) {
		o.Network = r.Network
	}
	if !eqBool(def.RequireLauncher, r.RequireLauncher) {
		o.RequireLauncher = r.RequireLauncher
	}
	return o
}

func sameRule(a, b ep.Rule) bool {
	l := func(x, y []string) bool { return slices.Equal(x, y) || (len(x) == 0 && len(y) == 0) }
	return a.Mode == b.Mode && l(a.ExecDeny, b.ExecDeny) && l(a.ExecAllow, b.ExecAllow) && l(a.FileAlert, b.FileAlert) &&
		l(a.FileDeny, b.FileDeny) && l(a.NetDeny, b.NetDeny) && l(a.NetAllow, b.NetAllow) && l(a.DomainDeny, b.DomainDeny) &&
		eqBool(a.Network, b.Network) && eqBool(a.RequireLauncher, b.RequireLauncher) &&
		l(a.ExecApprove, b.ExecApprove) && l(a.FileApprove, b.FileApprove) && l(a.DomainApprove, b.DomainApprove) &&
		l(a.NetApprove, b.NetApprove) && l(a.CommandApprove, b.CommandApprove) && l(a.ToolApprove, b.ToolApprove)
}

func eqBool(a, b *bool) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

func sorted(ps []policy.Policy) []policy.Policy {
	ps = slices.Clone(ps)
	slices.SortStableFunc(ps, func(a, b policy.Policy) int { return strings.Compare(a.ID, b.ID) })
	for i := range ps {
		ps[i].Rules = slices.Clone(ps[i].Rules)
		slices.SortStableFunc(ps[i].Rules, func(a, b policy.Rule) int { return strings.Compare(a.ID, b.ID) })
	}
	return ps
}

func sortFindings(fs []Finding) []Finding {
	slices.SortFunc(fs, func(a, b Finding) int {
		for _, c := range [][2]string{{a.PolicyID, b.PolicyID}, {a.RuleID, b.RuleID}, {a.Agent, b.Agent},
			{a.Field, b.Field}, {a.Value, b.Value}, {string(a.Enforcement), string(b.Enforcement)}, {a.Reason, b.Reason}} {
			if n := strings.Compare(c[0], c[1]); n != 0 {
				return n
			}
		}
		return 0
	})
	return slices.Compact(fs)
}
