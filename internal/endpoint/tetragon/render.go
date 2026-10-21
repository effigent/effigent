package tetragon

import (
	"fmt"
	"strconv"

	"github.com/effigent/effigent/internal/endpoint/domains"
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/policy"
	"gopkg.in/yaml.v3"
)

// PolicyPrefix marks TracingPolicies owned by effigentd; anything with this
// prefix is ours to reconcile/delete.
const PolicyPrefix = "eff-"

// PolicyName and Render as methods make *Client satisfy engine.Enforcer.
func (c *Client) PolicyName(agent string, pid uint32, gen uint64) string {
	return PolicyName(agent, pid, gen)
}
func (c *Client) Render(name string, pid uint32, r policy.Rule) ([]engine.Doc, error) {
	return Render(name, pid, r)
}

func PolicyName(agent string, pid uint32, gen uint64) string {
	return fmt.Sprintf("%s%s-%d-g%d", PolicyPrefix, agent, pid, gen)
}

type tp struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Metadata   struct {
		Name string `yaml:"name"`
	} `yaml:"metadata"`
	Spec struct {
		Kprobes  []hook `yaml:"kprobes,omitempty"`
		LSMHooks []hook `yaml:"lsmhooks,omitempty"`
	} `yaml:"spec"`
}

type hook struct {
	Call      string     `yaml:"call,omitempty"`
	Hook      string     `yaml:"hook,omitempty"`
	Syscall   *bool      `yaml:"syscall,omitempty"`
	Args      []arg      `yaml:"args"`
	Selectors []selector `yaml:"selectors"`
}

type arg struct {
	Index   int    `yaml:"index"`
	Type    string `yaml:"type"`
	Resolve string `yaml:"resolve,omitempty"`
}

type selector struct {
	MatchPIDs    []matchPID    `yaml:"matchPIDs"`
	MatchArgs    []matchArg    `yaml:"matchArgs,omitempty"`
	MatchActions []matchAction `yaml:"matchActions,omitempty"`
}

type matchPID struct {
	Operator       string   `yaml:"operator"`
	FollowForks    bool     `yaml:"followForks"`
	IsNamespacePID bool     `yaml:"isNamespacePID"`
	Values         []uint32 `yaml:"values"`
}

type matchArg struct {
	Index    int      `yaml:"index"`
	Operator string   `yaml:"operator"`
	Values   []string `yaml:"values"`
}

type matchAction struct {
	Action   string `yaml:"action"`
	ArgError *int   `yaml:"argError,omitempty"`
}

// Render compiles one agent's Rule into TracingPolicies scoped to the agent's
// root pid and every process it forks (including ones forked before the
// policy loaded). In monitor/learn modes the same selectors use Post instead
// of Override, so matches surface as would_block events.
//
// Tetragon rejects a policy that mixes hook kinds, so LSM hooks (exec + file
// control) and kprobes (network) become two policies: <name>-lsm, <name>-net.
func Render(name string, rootPID uint32, r policy.Rule) ([]engine.Doc, error) {
	var p tp

	enforce := r.Mode == policy.Denylist || r.Mode == policy.Allowlist
	pids := []matchPID{{Operator: "In", FollowForks: true, Values: []uint32{rootPID}}}
	eperm := -1
	act := func(block bool) []matchAction {
		if block && enforce {
			return []matchAction{{Action: "Override", ArgError: &eperm}}
		}
		return []matchAction{{Action: "Post"}}
	}

	// Exec control on the LSM hook that runs before a new program is loaded.
	var execArgs []matchArg
	switch {
	case r.Mode == policy.Allowlist:
		execArgs = []matchArg{{Index: 0, Operator: "NotEqual", Values: r.ExecAllow}}
	case len(r.ExecDeny) > 0:
		execArgs = []matchArg{{Index: 0, Operator: "Equal", Values: r.ExecDeny}}
	}
	if execArgs != nil {
		p.Spec.LSMHooks = append(p.Spec.LSMHooks, hook{
			Hook:      "bprm_check_security",
			Args:      []arg{{Index: 0, Type: "linux_binprm"}},
			Selectors: []selector{{MatchPIDs: pids, MatchArgs: execArgs, MatchActions: act(true)}},
		})
	}

	// File opens: first matching selector wins. The canary selector is always
	// enforced (even in monitor mode) so `effigentd run` can verify the
	// policy is live before it execs the agent. Then deny, then alert.
	fileSel := []selector{{MatchPIDs: pids,
		MatchArgs:    []matchArg{{Index: 0, Operator: "Postfix", Values: []string{policy.CanarySuffix}}},
		MatchActions: []matchAction{{Action: "Override", ArgError: &eperm}}}}
	if len(r.FileDeny) > 0 {
		fileSel = append(fileSel, selector{MatchPIDs: pids,
			MatchArgs:    []matchArg{{Index: 0, Operator: "Postfix", Values: r.FileDeny}},
			MatchActions: act(true)})
	}
	if len(r.FileAlert) > 0 {
		fileSel = append(fileSel, selector{MatchPIDs: pids,
			MatchArgs:    []matchArg{{Index: 0, Operator: "Postfix", Values: r.FileAlert}},
			MatchActions: act(false)})
	}
	{
		p.Spec.LSMHooks = append(p.Spec.LSMHooks, hook{
			Hook: "file_open", Args: []arg{{Index: 0, Type: "file"}}, Selectors: fileSel,
		})
	}

	// Outbound connections by destination IP/CIDR (domain_deny arrives here
	// already resolved into NetDeny). For a sockaddr argument Tetragon calls
	// the struct's address "SAddr" and port "SPort"; on connect that is the
	// destination. Allow mode only applies to IP families, so local unix
	// sockets keep working, and loopback is always allowed.
	var netSel []selector
	if len(r.NetDeny) > 0 {
		netSel = append(netSel, selector{MatchPIDs: pids,
			MatchArgs:    []matchArg{{Index: 1, Operator: "SAddr", Values: cidrs(r.NetDeny)}},
			MatchActions: act(true)})
	}
	if r.DNSGuard != nil {
		// domain_deny is only as good as the answers effigentd sees, so while
		// it is in force agents may not ask anyone else: no DNS over TLS
		// anywhere, and no well-known public resolver on DNS ports (plain,
		// DoH, DoT). The agent's own configured resolver is never listed.
		ip := []string{"AF_INET", "AF_INET6"}
		netSel = append(netSel, selector{MatchPIDs: pids,
			MatchArgs: []matchArg{
				{Index: 1, Operator: "Family", Values: ip},
				{Index: 1, Operator: "SPort", Values: []string{"853"}},
			},
			MatchActions: act(true)})
		if len(r.DNSGuard) > 0 {
			netSel = append(netSel, selector{MatchPIDs: pids,
				MatchArgs: []matchArg{
					{Index: 1, Operator: "SAddr", Values: cidrs(r.DNSGuard)},
					{Index: 1, Operator: "SPort", Values: domains.DNSPorts},
				},
				MatchActions: act(true)})
		}
	}
	if len(r.NetAllow) > 0 {
		allowed := append(cidrs(r.NetAllow), "127.0.0.0/8", "::1/128")
		netSel = append(netSel, selector{MatchPIDs: pids,
			MatchArgs: []matchArg{
				{Index: 1, Operator: "Family", Values: []string{"AF_INET", "AF_INET6"}},
				{Index: 1, Operator: "NotSAddr", Values: allowed},
			},
			MatchActions: act(true)})
	}
	if netSel != nil {
		p.Spec.LSMHooks = append(p.Spec.LSMHooks, hook{
			Hook: "socket_connect", Args: []arg{{Index: 1, Type: "sockaddr"}}, Selectors: netSel,
		})
	}

	// Self-protection (FR Q20): stop this agent tree from signalling
	// effigentd / Tetragon or writing their binaries, state and hook config.
	// Always Override — a monitor-mode agent (or one in a break-glass window)
	// must not be able to turn enforcement off. Scoped to the agent's pids, so
	// a non-agent root shell is unaffected (the documented limit). These go in
	// their own -guard doc, not -lsm: a single LSM TracingPolicy already
	// carrying exec + file_open will not also enforce the guard hooks.
	guardHooks := selfProtectHooks(pids, eperm, r.SelfProtect)
	killHooks := selfProtectKill(pids, eperm, r.SelfProtect)

	if r.Network == nil || *r.Network {
		no := false
		p.Spec.Kprobes = append(p.Spec.Kprobes, hook{
			Call: "tcp_connect", Syscall: &no,
			Args:      []arg{{Index: 0, Type: "sock"}},
			Selectors: []selector{{MatchPIDs: pids}},
		})
	}

	var docs []engine.Doc
	for _, part := range []struct {
		suffix  string
		lsm, kp []hook
	}{{"-lsm", p.Spec.LSMHooks, nil}, {"-net", nil, p.Spec.Kprobes},
		{"-guard", guardHooks, nil}, {"-guardk", killHooks, nil}} {
		if len(part.lsm) == 0 && len(part.kp) == 0 {
			continue
		}
		var one tp
		one.APIVersion, one.Kind = "cilium.io/v1alpha1", "TracingPolicy"
		one.Metadata.Name = name + part.suffix
		one.Spec.LSMHooks, one.Spec.Kprobes = part.lsm, part.kp
		y, err := yaml.Marshal(one)
		if err != nil {
			return nil, err
		}
		docs = append(docs, engine.Doc{Name: one.Metadata.Name, YAML: y})
	}
	return docs, nil // empty: nothing to load; exec/exit events still flow
}

// selfProtectHooks renders the self-protection (FR Q20) guard for one agent
// tree. Every hook is Override (EPERM) regardless of policy mode — a monitor
// agent, or one inside a break-glass window, must not be able to disable
// effigentd. Scoped to the agent's pids, so a non-agent root shell is
// unaffected (the documented limit). Returns nil when there is nothing to
// guard, so no -guard doc is loaded.
//
// These render into their own TracingPolicy (<name>-guard), not the -lsm doc:
// a single LSM TracingPolicy that already carries the exec + file_open hooks
// will not also enforce the guard hooks (verified on 6.11 — merged, the guard
// silently stops blocking), so the guard must be its own policy.
func selfProtectHooks(pids []matchPID, eperm int, sp *policy.SelfProtect) []hook {
	if sp == nil || len(sp.Paths) == 0 {
		return nil
	}
	guard := []matchAction{{Action: "Override", ArgError: &eperm}}
	var hooks []hook
	// Writes (MAY_WRITE = 2): overwrite, append, create under a dir. Not
	// file_open — effigentd's own hook/gate exec effigentd from inside the
	// agent tree and would be blocked from reading its binary.
	hooks = append(hooks, hook{
		Hook: "file_permission",
		Args: []arg{{Index: 0, Type: "file"}, {Index: 1, Type: "int"}},
		Selectors: []selector{{MatchPIDs: pids, MatchActions: guard,
			MatchArgs: []matchArg{
				{Index: 0, Operator: "Prefix", Values: sp.Paths},
				{Index: 1, Operator: "Mask", Values: []string{"2"}},
			}}},
	})
	// Truncate: inode_setattr(ATTR_SIZE), not file_truncate. `> file` (O_TRUNC
	// on open) empties the inode through do_truncate -> security_inode_setattr
	// *before* the write permission check, so file_permission alone lets the
	// content be destroyed even as the write is denied (verified on 6.11:
	// exit=EPERM yet size=0 on a writable fs). inode_setattr catches that path
	// and also covers ftruncate()/truncate(), and as a bonus blocks chmod/chown/
	// utimes on the protected paths. It is also the more portable hook:
	// file_truncate only exists since kernel 6.2, while inode_setattr is
	// long-standing. The dentry moved to arg index 1 when the mnt_userns/idmap
	// arg was added to security_inode_setattr in 5.12, so -guard assumes a
	// kernel >= 5.12 (as do the index-1 inode_unlink/inode_rename args below).
	hooks = append(hooks, hook{
		Hook: "inode_setattr", Args: []arg{{Index: 1, Type: "dentry"}},
		Selectors: []selector{{MatchPIDs: pids,
			MatchArgs: []matchArg{{Index: 1, Operator: "Prefix", Values: sp.Paths}}, MatchActions: guard}},
	})
	// Delete.
	hooks = append(hooks, hook{
		Hook: "inode_unlink", Args: []arg{{Index: 1, Type: "dentry"}},
		Selectors: []selector{{MatchPIDs: pids,
			MatchArgs: []matchArg{{Index: 1, Operator: "Prefix", Values: sp.Paths}}, MatchActions: guard}},
	})
	// Rename: block both renaming a protected path away (old dentry, index 1)
	// and renaming something over it (new dentry, index 3).
	hooks = append(hooks, hook{
		Hook: "inode_rename", Args: []arg{{Index: 1, Type: "dentry"}, {Index: 3, Type: "dentry"}},
		Selectors: []selector{
			{MatchPIDs: pids, MatchArgs: []matchArg{{Index: 1, Operator: "Prefix", Values: sp.Paths}}, MatchActions: guard},
			{MatchPIDs: pids, MatchArgs: []matchArg{{Index: 3, Operator: "Prefix", Values: sp.Paths}}, MatchActions: guard},
		},
	})
	return hooks
}

// selfProtectKill renders the task_kill guard into a doc of its own, so the
// path-guard doc stays at four hooks (a single LSM TracingPolicy enforces only
// a few hooks; see selfProtectHooks). Returns nil when no pids are known
// (e.g. a macOS dev daemon, where effigentd isn't in the agents' pid
// namespace), so the hook — and the doc — are omitted.
func selfProtectKill(pids []matchPID, eperm int, sp *policy.SelfProtect) []hook {
	if sp == nil || len(sp.KillPIDs) == 0 {
		return nil
	}
	vals := make([]string, 0, len(sp.KillPIDs))
	for _, p := range sp.KillPIDs {
		vals = append(vals, strconv.FormatUint(uint64(p), 10))
	}
	// task_kill(target, info, sig): resolve the target task's thread-group id
	// and block any signal the agent tree aims at these pids. systemctl stop
	// effigentd can't be matched this way (it signals via systemd, a non-agent
	// process) — a documented limit.
	return []hook{{
		Hook: "task_kill",
		Args: []arg{{Index: 0, Type: "int", Resolve: "tgid"}, {Index: 2, Type: "int"}},
		Selectors: []selector{{MatchPIDs: pids,
			MatchArgs:    []matchArg{{Index: 0, Operator: "Equal", Values: vals}},
			MatchActions: []matchAction{{Action: "Override", ArgError: &eperm}}}},
	}}
}

// cidrs normalizes IPs/CIDRs (already validated by the policy parser).
func cidrs(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if c, err := policy.ParseCIDR(s); err == nil {
			out = append(out, c)
		}
	}
	return out
}
