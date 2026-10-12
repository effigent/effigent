package tetragon

import (
	"fmt"

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
	Index int    `yaml:"index"`
	Type  string `yaml:"type"`
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
	}{{"-lsm", p.Spec.LSMHooks, nil}, {"-net", nil, p.Spec.Kprobes}} {
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
