// Package engine attributes sensor events to AI agents, keeps one enforcement
// policy per running agent, and turns everything into event.Events for sinks.
package engine

import (
	"context"
	"fmt"
	"net"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/domains"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/ident"
	"github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/endpoint/redact"
)

// Enforcer loads per-agent kernel policies. Nil on platforms that can only
// observe (macOS); verdicts are then computed in userspace as would_block.
type Enforcer interface {
	Render(name string, rootPID uint32, r policy.Rule) ([]Doc, error)
	Add(ctx context.Context, yaml []byte) error
	Delete(ctx context.Context, name string) error
	Owned(ctx context.Context) ([]string, error)
	PolicyName(agent string, pid uint32, gen uint64) string
}

// Doc is one kernel policy document; an agent may need several.
type Doc struct {
	Name string
	YAML []byte
}

type Root struct {
	Agent     string      `json:"agent"`
	PID       uint32      `json:"pid"`
	ExecID    string      `json:"exec_id,omitempty"`
	Binary    string      `json:"binary"`
	Args      string      `json:"args,omitempty"`
	Container string      `json:"container,omitempty"`
	Mode      policy.Mode `json:"mode"`
	Policies  []string    `json:"policies,omitempty"` // loaded kernel policies
	Started   time.Time   `json:"started"`
	Orphan    bool        `json:"orphan_mcp,omitempty"`
	Launched  bool        `json:"launched,omitempty"` // started through `effigentd run`
}

type Engine struct {
	mu       sync.Mutex
	pol      *policy.Policy
	polRaw   []byte
	enf      Enforcer
	emit     func(event.Event)
	logf     func(string, ...any)
	verbose  bool
	roots    map[uint32]*Root
	byPolicy map[string]*Root
	mcp      map[string]string         // exec_id -> MCP label, for processes inside agent trees
	learned  map[string]map[string]int // agent -> binary -> exec count
	recent   map[string]time.Time      // dedup of repeated kernel events
	gen      uint64
	dns      *domains.Resolver                               // domain_deny hostnames -> addresses
	procfs   string                                          // to read each agent's own resolv.conf
	empty    map[string]bool                                 // domain_deny names currently resolving to nothing (reported once)
	scan     func() ([]event.Proc, map[uint32]uint32, error) // running processes, once rescans are enabled
}

func (e *Engine) stop(pid int) error { return stopProcess(pid) }

func New(pol *policy.Policy, raw []byte, enf Enforcer, emit func(event.Event), logf func(string, ...any), verbose bool) *Engine {
	applyRedaction(pol, logf)
	return &Engine{
		pol: pol, polRaw: raw, enf: enf, emit: func(ev event.Event) { emit(scrub(ev)) }, logf: logf, verbose: verbose,
		roots: map[uint32]*Root{}, byPolicy: map[string]*Root{},
		mcp: map[string]string{}, learned: map[string]map[string]int{}, recent: map[string]time.Time{},
		empty: map[string]bool{},
	}
}

// UseResolver enables domain_deny: its hostnames are resolved by r and
// blocked by address. procfs ("" if unavailable) is used to find each
// agent's own nameservers, which the DNS bypass guard never blocks.
// Call before the policy is applied to any agent.
func (e *Engine) UseResolver(ctx context.Context, r *domains.Resolver, procfs string) {
	e.mu.Lock()
	e.dns, e.procfs = r, procfs
	pol := e.pol
	e.mu.Unlock()
	r.Set(ctx, pol.Domains())
	e.reportEmpty(pol.Domains())
}

// applyRedaction sets the policy's masks (validated by the parser already).
func applyRedaction(p *policy.Policy, logf func(string, ...any)) {
	if p == nil {
		return
	}
	rules := make([]redact.Rule, len(p.Redact.Patterns))
	for i, r := range p.Redact.Patterns {
		rules[i] = redact.Rule{Name: r.Name, Pattern: r.Pattern}
	}
	if err := redact.Configure(rules, p.Redact.PII); err != nil && logf != nil {
		logf("redaction masks not applied: %v", err)
	}
}

// scrub removes secrets from every free-text field of an event before any
// sink (stdout, log file, control plane) sees it.
func scrub(ev event.Event) event.Event {
	if ev.Process != nil {
		p := *ev.Process
		p.Args = redact.String(p.Args)
		ev.Process = &p
	}
	ev.Target = redact.String(ev.Target)
	ev.Message = redact.String(ev.Message)
	if len(ev.Actions) > 0 {
		acts := make([]event.Action, len(ev.Actions))
		for i, a := range ev.Actions {
			a.Target = redact.String(a.Target)
			acts[i] = a
		}
		ev.Actions = acts
	}
	return ev
}

// Run consumes raw sensor events until the channel closes.
func (e *Engine) Run(ctx context.Context, in <-chan event.Raw) {
	for {
		select {
		case <-ctx.Done():
			return
		case r, ok := <-in:
			if !ok {
				return
			}
			e.handle(ctx, r)
		}
	}
}

func (e *Engine) handle(ctx context.Context, r event.Raw) {
	switch r.Kind {
	case event.Exec:
		e.onExec(ctx, r)
	case event.Exit:
		e.onExit(ctx, r)
	default:
		e.onPolicyEvent(r)
	}
}

// findRoot walks the process, its parent and ancestors (nearest first) and
// returns the tracked agent they belong to.
func (e *Engine) findRoot(r event.Raw) *Root {
	e.mu.Lock()
	defer e.mu.Unlock()
	if r.Policy != "" {
		if root := e.byPolicy[r.Policy]; root != nil {
			return root
		}
	}
	for _, p := range append([]event.Proc{r.Process, r.Parent}, r.Ancestors...) {
		if root := e.roots[p.PID]; root != nil && (root.ExecID == "" || p.ExecID == "" || root.ExecID == p.ExecID) {
			return root
		}
	}
	return nil
}

// via returns the nearest MCP server above (or at) the process.
func (e *Engine) via(r event.Raw) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, p := range append([]event.Proc{r.Process, r.Parent}, r.Ancestors...) {
		if l, ok := e.mcp[p.ExecID]; ok && p.ExecID != "" {
			return "mcp:" + l
		}
	}
	return ""
}

func (e *Engine) onExec(ctx context.Context, r event.Raw) {
	e.mu.Lock()
	pol := e.pol
	e.mu.Unlock()

	if root := e.findRoot(r); root != nil {
		kind := "tool"
		if m := pol.MatchMCP(r.Process.Binary, r.Process.Args); m != "" {
			kind = "mcp"
			e.mu.Lock()
			e.mcp[r.Process.ExecID] = m
			e.mu.Unlock()
		} else if pol.MatchAgent(r.Process.Binary, r.Process.Args) != "" {
			kind = "agent" // nested agent / re-exec: stays under the outer agent's policy
		}
		if r.Process.PID == root.PID {
			// The root exec'd in place (e.g. `bash -c` exec-ing its last command):
			// same pid and kernel policy, new exec_id — follow it so its exit matches.
			e.mu.Lock()
			root.ExecID = r.Process.ExecID
			e.mu.Unlock()
		}
		e.learn(root.Agent, r.Process.Binary)
		ev := e.base(r, root, event.Exec, "info")
		ev.Kind, ev.Target = kind, r.Process.Binary
		e.emit(ev)
		return
	}

	name, orphan := launcherAgent(r.Process.Binary, r.Process.Args), false
	launched := name != ""
	if name == "" {
		name = pol.MatchAgent(r.Process.Binary, r.Process.Args)
	}
	if name == "" && pol.TrackOrphanMCP {
		if m := pol.MatchMCP(r.Process.Binary, r.Process.Args); m != "" {
			name, orphan = "mcp-"+sanitize(m), true
			e.mu.Lock()
			e.mcp[r.Process.ExecID] = m
			e.mu.Unlock()
		}
	}
	if name == "" {
		return
	}
	e.track(ctx, &Root{
		Agent: name, PID: r.Process.PID, ExecID: r.Process.ExecID, Binary: r.Process.Binary,
		Args: redact.String(r.Process.Args), Container: r.Container, Started: r.Time, Orphan: orphan, Launched: launched,
	}, r)
}

// track registers a new agent root and loads its kernel policy.
func (e *Engine) track(ctx context.Context, root *Root, r event.Raw) {
	e.mu.Lock()
	rule := e.ruleFor(root)
	root.Mode = rule.Mode
	e.roots[root.PID] = root
	e.gen++
	gen := e.gen
	e.mu.Unlock()

	ev := e.base(r, root, event.AgentStart, "info")
	ev.Kind, ev.Target = "agent", root.Binary
	if root.Orphan {
		ev.Kind, ev.Message = "mcp", "MCP server with no known agent above it"
	}
	e.emit(ev)
	e.apply(ctx, root, rule, gen)

	if rule.Launcher() && !root.Launched && !root.Orphan {
		e.stopUnlaunched(root, r)
	}
}

// stopUnlaunched enforces require_launcher: an agent started without
// `effigentd run` may already have run code before its kernel policy loaded,
// so the policy says it must not run at all. The kernel policy above still
// covers anything it managed to start in the meantime.
func (e *Engine) stopUnlaunched(root *Root, r event.Raw) {
	err := e.stop(int(root.PID))
	ev := e.base(r, root, event.Blocked, "high")
	ev.Kind, ev.Target = "agent", root.Binary
	ev.Message = "agent started without effigentd run; this organization requires: effigentd run --agent " + root.Agent + " -- <command>"
	if err != nil {
		ev.Message += " (could not stop it: " + err.Error() + ")"
	}
	e.emit(ev)
}

// ruleFor is the rule the kernel enforces for a tracked agent: approval lists
// it can see are denies there (only a hook can pause and ask).
func (e *Engine) ruleFor(root *Root) policy.Rule {
	if root.Orphan {
		return e.pol.RuleFor("").Kernel()
	}
	return e.pol.RuleFor(root.Agent).Kernel()
}

// apply loads the new policies before removing the old ones, so a reload
// never leaves the agent unenforced.
func (e *Engine) apply(ctx context.Context, root *Root, rule policy.Rule, gen uint64) {
	if e.enf == nil {
		return
	}
	rule = e.expand(root, rule)
	docs, err := e.enf.Render(e.enf.PolicyName(root.Agent, root.PID, gen), root.PID, rule)
	if err != nil {
		e.logf("render policy for %s[%d]: %v", root.Agent, root.PID, err)
		return
	}
	// Load in parallel: each policy costs a BPF program load (~400ms), and
	// until they are in, the agent's execs are only observed, not enforced.
	start := time.Now()
	errs := make([]error, len(docs))
	var wg sync.WaitGroup
	for i, d := range docs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = e.enf.Add(ctx, d.YAML)
		}()
	}
	wg.Wait()
	var loaded []string
	for i, d := range docs {
		if err := errs[i]; err != nil {
			e.logf("load policy %s: %v", d.Name, err)
			e.emit(event.Event{Time: time.Now(), Type: event.PolicyLoad, Severity: "high", Agent: root.Agent,
				AgentPID: root.PID, Rule: d.Name, Message: "failed to load kernel policy: " + err.Error()})
			continue
		}
		loaded = append(loaded, d.Name)
	}
	if len(loaded) > 0 {
		e.emit(event.Event{Time: time.Now(), Type: event.PolicyLoad, Severity: "info", Agent: root.Agent,
			AgentPID: root.PID, Mode: string(rule.Mode), Rule: strings.Join(loaded, ","),
			Message: fmt.Sprintf("%d kernel policies loaded in %dms", len(loaded), time.Since(start).Milliseconds())})
	}
	e.mu.Lock()
	old := root.Policies
	for _, n := range old {
		delete(e.byPolicy, n)
	}
	root.Policies = loaded
	for _, n := range loaded {
		e.byPolicy[n] = root
	}
	e.mu.Unlock()
	for _, n := range old {
		if err := e.enf.Delete(ctx, n); err != nil {
			e.logf("delete policy %s: %v", n, err)
		}
	}
}

func (e *Engine) onExit(ctx context.Context, r event.Raw) {
	e.mu.Lock()
	delete(e.mcp, r.Process.ExecID)
	root := e.roots[r.Process.PID]
	if root == nil || (root.ExecID != "" && r.Process.ExecID != "" && root.ExecID != r.Process.ExecID) {
		e.mu.Unlock()
		if e.verbose {
			if root := e.findRoot(r); root != nil {
				ev := e.base(r, root, event.Exit, "info")
				e.emit(ev)
			}
		}
		return
	}
	e.mu.Unlock()
	e.untrack(ctx, root, r)
}

func (e *Engine) untrack(ctx context.Context, root *Root, r event.Raw) {
	e.mu.Lock()
	delete(e.roots, root.PID)
	names := root.Policies
	for _, n := range names {
		delete(e.byPolicy, n)
	}
	e.mu.Unlock()
	for _, n := range names {
		if e.enf == nil {
			break
		}
		if err := e.enf.Delete(ctx, n); err != nil {
			e.logf("delete policy %s: %v", n, err)
		}
	}
	ev := e.base(r, root, event.AgentExit, "info")
	ev.Kind = "agent"
	e.emit(ev)
}

func (e *Engine) onPolicyEvent(r event.Raw) {
	root := e.findRoot(r)
	if root == nil || e.duplicate(r) {
		return
	}
	if strings.HasSuffix(r.Target, policy.CanarySuffix) {
		return // `effigentd run` probing that enforcement is live
	}
	sev := map[event.Type]string{event.Blocked: "high", event.WouldBlock: "medium", event.FileOpen: "medium", event.Connect: "info"}[r.Kind]
	kind := r.Kind
	if kind == event.FileOpen {
		e.mu.Lock()
		rule := e.ruleFor(root)
		e.mu.Unlock()
		if hasSuffix(r.Target, rule.FileDeny) { // deny-listed file opened in monitor/learn mode
			kind, sev = event.WouldBlock, "high"
		}
	}
	ev := e.base(r, root, kind, sev)
	ev.Target, ev.Rule = r.Target, r.Policy
	if kind == event.Blocked || kind == event.WouldBlock {
		ev.Message = e.connectNote(root, r.Target)
	}
	ev.Kind = "tool"
	if e.mcpLabel(r.Process.ExecID) != "" {
		ev.Kind = "mcp"
	}
	if r.Process.PID == root.PID {
		ev.Kind = "agent"
	}
	e.emit(ev)
}

// duplicate suppresses the repeat events the kernel can emit for one action
// (e.g. file_open fires more than once for a single open).
func (e *Engine) duplicate(r event.Raw) bool {
	key := fmt.Sprintf("%s|%d|%s|%s", r.Kind, r.Process.PID, r.Process.ExecID, r.Target)
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()
	if t, ok := e.recent[key]; ok && now.Sub(t) < 2*time.Second {
		return true
	}
	if len(e.recent) > 4096 {
		for k, t := range e.recent {
			if now.Sub(t) >= 2*time.Second {
				delete(e.recent, k)
			}
		}
	}
	e.recent[key] = now
	return false
}

func (e *Engine) mcpLabel(execID string) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.mcp[execID]
}

func (e *Engine) base(r event.Raw, root *Root, t event.Type, sev string) event.Event {
	p := r.Process
	ev := event.Event{
		Time: r.Time, Node: r.Node, Type: t, Severity: sev,
		Agent: root.Agent, AgentPID: root.PID, Mode: string(root.Mode),
		Via: e.via(r), Process: &p, Container: r.Container,
	}
	// Who runs it (attribution only): a host process's uid is a user of this
	// machine; inside a container it belongs to the container's own users.
	if r.Container == "" && p.Binary != "" {
		ev.OSUser = ident.Default.OSUser(p.UID)
		ev.GitEmail = ident.Default.GitEmail(ev.OSUser, p.CWD)
	}
	return ev
}

func (e *Engine) learn(agent, binary string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	m := e.learned[agent]
	if m == nil {
		m = map[string]int{}
		e.learned[agent] = m
	}
	m[binary]++
}

// Bootstrap tracks agents that were already running when effigentd started
// (Linux, from /proc). Their exec happened before we were listening. It is
// also how a policy change reaches running processes (see EnableRescan), so
// roots already tracked, and anything inside their trees, are left alone.
func (e *Engine) Bootstrap(ctx context.Context, procs []event.Proc, ppid map[uint32]uint32) {
	byPID := map[uint32]event.Proc{}
	for _, p := range procs {
		byPID[p.PID] = p
	}
	e.mu.Lock()
	pol := e.pol
	tracked := make(map[uint32]bool, len(e.roots))
	for pid := range e.roots {
		tracked[pid] = true
	}
	e.mu.Unlock()
	isAgent := func(p event.Proc) string { return pol.MatchAgent(p.Binary, p.Args) }
	for _, p := range procs {
		if tracked[p.PID] {
			continue
		}
		name := isAgent(p)
		if name == "" {
			continue
		}
		nested := false
		for a, n := ppid[p.PID], 0; a > 1 && n < 64; a, n = ppid[a], n+1 {
			if tracked[a] || isAgent(byPID[a]) != "" {
				nested = true
				break
			}
		}
		if nested {
			continue
		}
		e.track(ctx, &Root{Agent: name, PID: p.PID, Binary: p.Binary, Args: redact.String(p.Args), Started: time.Now()},
			event.Raw{Time: time.Now(), Process: p})
	}
}

// Reconcile makes Tetragon's effigentd policies match our roots: remove
// stale ones (e.g. left by a previous effigentd run) and re-add missing ones
// (e.g. Tetragon restarted). Called whenever the event stream (re)connects.
func (e *Engine) Reconcile(ctx context.Context) {
	if e.enf == nil {
		return
	}
	owned, err := e.enf.Owned(ctx)
	if err != nil {
		e.logf("reconcile: %v", err)
		return
	}
	have := map[string]bool{}
	for _, n := range owned {
		have[n] = true
		e.mu.Lock()
		_, ours := e.byPolicy[n]
		e.mu.Unlock()
		if !ours {
			e.logf("reconcile: removing stale policy %s", n)
			_ = e.enf.Delete(ctx, n)
		}
	}
	for _, root := range e.Agents() {
		missing := len(root.Policies) == 0
		for _, n := range root.Policies {
			missing = missing || !have[n]
		}
		if missing {
			e.reapply(ctx, root.PID)
		}
	}
}

func (e *Engine) reapply(ctx context.Context, pid uint32) {
	e.mu.Lock()
	root := e.roots[pid]
	if root == nil {
		e.mu.Unlock()
		return
	}
	rule := e.ruleFor(root)
	root.Mode = rule.Mode
	e.gen++
	gen := e.gen
	e.mu.Unlock()
	e.apply(ctx, root, rule, gen)
}

// Sweep drops roots whose process is gone but whose exit we missed.
func (e *Engine) Sweep(ctx context.Context, alive func(pid uint32) bool) {
	for _, root := range e.Agents() {
		if !alive(root.PID) {
			e.mu.Lock()
			r := e.roots[root.PID]
			e.mu.Unlock()
			if r != nil {
				e.logf("sweep: %s[%d] is gone", r.Agent, r.PID)
				e.untrack(ctx, r, event.Raw{Time: time.Now(), Process: event.Proc{PID: r.PID}})
			}
		}
	}
}

// SetPolicy validates and hot-swaps the policy, re-applying it to every live agent.
func (e *Engine) SetPolicy(ctx context.Context, raw []byte) (int, error) {
	p, err := policy.Parse(raw)
	if err != nil {
		return 0, err
	}
	e.mu.Lock()
	dns := e.dns
	e.mu.Unlock()
	if dns != nil {
		// Resolve new hostnames first, so the policies below already block them.
		dns.Set(ctx, p.Domains())
		e.reportEmpty(p.Domains())
	}
	applyRedaction(p, e.logf)
	e.mu.Lock()
	e.pol, e.polRaw = p, raw
	pids := make([]uint32, 0, len(e.roots))
	for pid := range e.roots {
		pids = append(pids, pid)
	}
	e.mu.Unlock()
	for _, pid := range pids {
		e.reapply(ctx, pid)
	}
	// A new or changed agent rule may match processes that are already
	// running (their exec is long past): look for them, as at startup.
	e.mu.Lock()
	scan := e.scan
	e.mu.Unlock()
	if scan != nil {
		if procs, ppid, err := scan(); err != nil {
			e.logf("rescan after policy change: %v", err)
		} else {
			e.Bootstrap(ctx, procs, ppid)
		}
	}
	return len(pids), nil
}

// EnableRescan makes every policy change look for running processes that
// its agent rules match (e.g. a rule just added for an agent that is already
// up). Call it after the startup Bootstrap, once enforcement is connected.
func (e *Engine) EnableRescan(scan func() ([]event.Proc, map[uint32]uint32, error)) {
	e.mu.Lock()
	e.scan = scan
	e.mu.Unlock()
}

// expand turns a rule's domain_deny into addresses the kernel can match:
// the hostnames' current IPs join NetDeny, and the DNS bypass guard is
// switched on (minus the resolvers this agent is configured to use and
// any single address network_allow lists).
func (e *Engine) expand(root *Root, rule policy.Rule) policy.Rule {
	e.mu.Lock()
	dns, procfs := e.dns, e.procfs
	e.mu.Unlock()
	if len(rule.DomainDeny) == 0 || dns == nil {
		return rule
	}
	deny := slices.Clone(rule.NetDeny)
	for _, h := range rule.DomainDeny {
		for _, ip := range dns.IPs(h) {
			if !slices.Contains(deny, ip) {
				deny = append(deny, ip)
			}
		}
	}
	rule.NetDeny = deny
	files := []string{"/etc/resolv.conf"}
	if procfs != "" {
		files = append(files, filepath.Join(procfs, strconv.Itoa(int(root.PID)), "root/etc/resolv.conf"))
	}
	exempt := domains.Nameservers(files...)
	for _, a := range rule.NetAllow { // an address the policy explicitly allows stays allowed
		if c, err := policy.ParseCIDR(a); err == nil && (strings.HasSuffix(c, "/32") || strings.HasSuffix(c, "/128")) {
			exempt = append(exempt, strings.SplitN(c, "/", 2)[0])
		}
	}
	rule.DNSGuard = domains.Guarded(exempt)
	return rule
}

// OnDomainsChanged re-applies the policy of every agent whose domain_deny
// lists a hostname whose addresses changed.
func (e *Engine) OnDomainsChanged(ctx context.Context, names []string) {
	e.logf("domain_deny: addresses changed for %s", strings.Join(names, ", "))
	e.reportEmpty(names)
	for _, root := range e.Agents() {
		e.mu.Lock()
		rule := e.ruleFor(&root)
		e.mu.Unlock()
		if slices.ContainsFunc(rule.DomainDeny, func(h string) bool { return slices.Contains(names, h) }) {
			e.reapply(ctx, root.PID)
		}
	}
}

// reportEmpty makes "listed but nothing to block" visible: a domain_deny
// hostname that resolves to no address is reported once, until it resolves.
func (e *Engine) reportEmpty(names []string) {
	e.mu.Lock()
	dns := e.dns
	e.mu.Unlock()
	if dns == nil {
		return
	}
	for _, h := range names {
		none := len(dns.IPs(h)) == 0
		e.mu.Lock()
		was := e.empty[h]
		e.empty[h] = none
		e.mu.Unlock()
		if none && !was {
			e.emit(event.Event{Time: time.Now(), Type: event.PolicyLoad, Severity: "medium", Target: h,
				Message: "domain_deny " + h + " resolves to no address; nothing is blocked for it until it does"})
		}
	}
}

// connectNote explains a blocked connect that came from domain_deny.
func (e *Engine) connectNote(root *Root, target string) string {
	host, port, err := net.SplitHostPort(strings.TrimPrefix(target, "connect "))
	if err != nil || !strings.HasPrefix(target, "connect ") {
		return ""
	}
	e.mu.Lock()
	dns := e.dns
	rule := e.ruleFor(root)
	e.mu.Unlock()
	if dns == nil || len(rule.DomainDeny) == 0 {
		return ""
	}
	if names := dns.Names(host); len(names) > 0 {
		return "domain_deny: " + strings.Join(names, ", ")
	}
	if port == "853" || slices.Contains(domains.PublicResolvers, host) && slices.Contains(domains.DNSPorts, port) {
		return "DNS bypass guard: agents may not use outside resolvers while domain_deny is in force"
	}
	return ""
}

// Approvals returns the policy's approval settings.
func (e *Engine) Approvals() policy.Approvals {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pol.Approvals
}

// RuleFor returns the effective rule for an agent under the current policy,
// approval lists included (for hooks; the kernel uses Rule.Kernel).
func (e *Engine) RuleFor(agent string) policy.Rule {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pol.RuleFor(agent)
}

// Emit sends an event through the engine's sinks (redacted like every other).
func (e *Engine) Emit(ev event.Event) { e.emit(ev) }

func (e *Engine) PolicyRaw() []byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.polRaw
}

func (e *Engine) Agents() []Root {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]Root, 0, len(e.roots))
	for _, r := range e.roots {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Started.Before(out[j].Started) })
	return out
}

// Learned returns, per agent, every binary its tree has executed — a
// ready-made exec_allow list for allowlist mode.
func (e *Engine) Learned() map[string][]string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := map[string][]string{}
	for a, m := range e.learned {
		for b := range m {
			out[a] = append(out[a], b)
		}
		sort.Strings(out[a])
	}
	return out
}

func hasSuffix(s string, suffixes []string) bool {
	for _, x := range suffixes {
		if strings.HasSuffix(s, x) {
			return true
		}
	}
	return false
}

var launcherArgs = regexp.MustCompile(`^run\s+(?:.*\s)?--agent[= ](\S+)`)

// launcherAgent recognises `effigentd run --agent NAME -- cmd...`: the
// launcher's pid becomes the agent root before the agent itself even starts.
func launcherAgent(binary, args string) string {
	if !strings.HasPrefix(path.Base(binary), "effigentd") { // effigentd, effigentd-linux, …
		return ""
	}
	if m := launcherArgs.FindStringSubmatch(args); m != nil {
		return sanitize(m[1])
	}
	return ""
}

var nonName = regexp.MustCompile(`[^a-z0-9-]+`)

func sanitize(s string) string {
	s = nonName.ReplaceAllString(strings.ToLower(path.Base(s)), "-")
	return strings.Trim(s, "-")
}
