package compile

import (
	"fmt"
	"path"
	"slices"
	"strings"
	"time"

	ep "github.com/effigent/effigent/internal/endpoint/policy"
)

// Exception lifts one company-wide entry for some machines: "Dana's laptop may
// run curl", "no approval needed for git push* on the release box". It removes
// Value from List in the rule of the agents it names (every agent when empty),
// or, for exec_allow, adds Value. Machines are picked by endpoint id or
// hostname, owner, or team; any match counts.
type Exception struct {
	ID        string     `json:"id"`
	Endpoints []string   `json:"endpoints,omitempty"` // endpoint ids or hostnames
	Owners    []string   `json:"owners,omitempty"`    // console user ids or emails (cp.endpoints.owner)
	Teams     []string   `json:"teams,omitempty"`
	Agents    []string   `json:"agents,omitempty"` // endpoint agent names; empty = every agent
	List      string     `json:"list"`
	Value     string     `json:"value"`
	Reason    string     `json:"reason,omitempty"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedBy string     `json:"created_by,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

// ExceptionLists are the lists an exception can change. exec_allow adds;
// every other list removes.
var ExceptionLists = []string{
	"exec_deny", "file_deny", "domain_deny", "network_deny", "file_alert",
	"exec_approve", "file_approve", "domain_approve", "network_approve", "command_approve", "tool_approve",
	"exec_allow",
}

// Live reports whether the exception applies at time now.
func (x Exception) Live(now time.Time) bool { return x.ExpiresAt == nil || now.Before(*x.ExpiresAt) }

// Applies reports whether the exception covers machine m.
func (x Exception) Applies(m Machine) bool {
	for _, e := range x.Endpoints {
		if e == m.EndpointID || strings.EqualFold(e, m.Hostname) {
			return true
		}
	}
	for _, o := range x.Owners {
		if o != "" && strings.EqualFold(o, m.Owner) {
			return true
		}
	}
	for _, t := range x.Teams {
		if slices.ContainsFunc(m.Teams, func(h string) bool { return strings.EqualFold(h, t) }) {
			return true
		}
	}
	return false
}

// Validate checks an exception on its own.
func (x Exception) Validate() error {
	switch {
	case !slices.Contains(ExceptionLists, x.List):
		return fmt.Errorf("list must be one of %s", strings.Join(ExceptionLists, ", "))
	case strings.TrimSpace(x.Value) == "":
		return fmt.Errorf("value is required")
	case len(x.Endpoints)+len(x.Owners)+len(x.Teams) == 0:
		return fmt.Errorf("pick at least one machine, owner or team")
	case x.List == "exec_allow" && !strings.HasPrefix(x.Value, "/"):
		return fmt.Errorf("exec_allow needs an absolute path (e.g. /usr/bin/curl)")
	}
	return nil
}

// listOf returns a pointer to one of a rule's lists.
func listOf(r *ep.Rule, name string) *[]string {
	switch name {
	case "exec_deny":
		return &r.ExecDeny
	case "exec_allow":
		return &r.ExecAllow
	case "file_deny":
		return &r.FileDeny
	case "file_alert":
		return &r.FileAlert
	case "domain_deny":
		return &r.DomainDeny
	case "network_deny":
		return &r.NetDeny
	case "exec_approve":
		return &r.ExecApprove
	case "file_approve":
		return &r.FileApprove
	case "domain_approve":
		return &r.DomainApprove
	case "network_approve":
		return &r.NetApprove
	case "command_approve":
		return &r.CommandApprove
	case "tool_approve":
		return &r.ToolApprove
	}
	return nil
}

// matchEntry: an exception value matches a list entry exactly, or — for exec
// lists — by program name ("curl" matches /usr/bin/curl and /bin/curl), and
// for network lists by canonical CIDR ("1.2.3.4" matches "1.2.3.4/32").
func matchEntry(list, value, entry string) bool {
	switch {
	case entry == value:
		return true
	case strings.HasPrefix(list, "exec_") && !strings.Contains(value, "/"):
		return path.Base(entry) == value
	case strings.HasPrefix(list, "network_"):
		a, err1 := ep.ParseCIDR(value)
		b, err2 := ep.ParseCIDR(entry)
		return err1 == nil && err2 == nil && a == b
	case strings.HasPrefix(list, "domain_"):
		return strings.EqualFold(strings.TrimSuffix(entry, "."), strings.TrimSuffix(value, "."))
	}
	return false
}

// applyExceptions changes the merged per-agent rules of one machine. It
// returns the exceptions that applied. An exception that would empty an
// agent's own explicit list is refused: YAML can't carry an empty override,
// so the agent would silently fall back to the defaults' list.
func applyExceptions(merged map[string]ep.Rule, bp *ep.Policy, exs []Exception, m Machine, now time.Time) ([]Exception, error) {
	var applied []Exception
	for _, x := range exs {
		if !x.Live(now) || !x.Applies(m) {
			continue
		}
		for name, r := range merged {
			if len(x.Agents) > 0 && !slices.Contains(x.Agents, name) {
				continue
			}
			if len(x.Agents) > 0 && name == DefaultsAgent {
				continue // an agent-specific exception never loosens the defaults
			}
			l := listOf(&r, x.List)
			if x.List == "exec_allow" {
				if !slices.Contains(*l, x.Value) {
					*l = append(slices.Clone(*l), x.Value)
				}
			} else {
				kept := slices.DeleteFunc(slices.Clone(*l), func(e string) bool { return matchEntry(x.List, x.Value, e) })
				// An empty list can't be written for one agent: it would fall
				// back to the defaults' list (which still has the entry).
				if len(kept) == 0 && len(*l) > 0 && name != DefaultsAgent && (len(x.Agents) > 0 || hasOwnList(bp, name, x.List)) {
					return nil, fmt.Errorf("exception %s would leave %s's %s empty; make it apply to every agent, or keep another entry in that list", x.ID, name, x.List)
				}
				*l = kept
			}
			merged[name] = r
		}
		applied = append(applied, x)
	}
	return applied, nil
}

// hasOwnList reports whether the base policy gives agent its own value for list.
func hasOwnList(bp *ep.Policy, agent, list string) bool {
	for i := range bp.Agents {
		if bp.Agents[i].Name == agent {
			r := bp.Agents[i].Rule
			return *listOf(&r, list) != nil
		}
	}
	return false
}
