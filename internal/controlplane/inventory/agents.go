package inventory

import (
	"sort"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
)

// HookAgent maps an effigentd policy agent name to the name its hook is
// reported under (internal/endpoint/hookstate, cmd/effigentd hookAgents).
// Agents not listed have no hook: effigentd detects them, and only the
// kernel layer (Linux) can enforce on them.
var HookAgent = map[string]string{"claude-code": "claude", "codex": "codex", "gemini-cli": "gemini", "cursor-agent": "cursor"}

// Agent statuses on the inventory page.
const (
	StatusEnforced      = "enforced"       // a hook in place, or the kernel layer
	StatusHooksOff      = "hooks_off"      // has a hook, but it is missing / switched off, and no kernel layer
	StatusDetectionOnly = "detection_only" // no hook exists for it and no kernel layer: seen, not controlled
	StatusUnmanaged     = "unmanaged"      // runs where effigentd can't enforce (Claude Cowork's VM)
)

// HookState is one agent's hook on a machine, from its health report.
type HookState struct {
	Reported bool   // the machine reports hooks at all
	Sensor   string // tetragon | hooks
	State    string // installed | missing | modified | unreadable ("" = not in the report)
	Broken   bool   // not installed, or a user switched it off
}

// Coverage says how effigentd controls an agent on a machine: which layers
// apply (hooks, kernel) and the resulting status, with a short note.
func Coverage(agent, mode, os string, h HookState, hookEvents, kernelEvents int64) (status string, by []string, note string) {
	if mode == "unmanaged" {
		return StatusUnmanaged, nil, "runs in its own virtual machine: effigentd sees it start and stop, policy doesn't reach it"
	}
	kernel := h.Sensor == "tetragon" || (h.Sensor == "" && kernelEvents > 0) || (!h.Reported && os == "linux" && kernelEvents > 0)
	_, hasHook := HookAgent[agent]
	hooks := false
	switch {
	case !hasHook:
	case h.Reported && h.State != "":
		hooks = !h.Broken
	case hookEvents > 0: // an older effigentd that doesn't report hooks: its hook did answer
		hooks = true
	}
	if hooks {
		by = append(by, "hooks")
	}
	if kernel {
		by = append(by, "kernel")
	}
	switch {
	case hooks || kernel:
		status = StatusEnforced
		if hasHook && !hooks && h.Reported && h.State != "" {
			note = "kernel only: its hook is " + h.State + " (commands, tools, MCP and approvals aren't checked)"
		}
	case hasHook:
		status, note = StatusHooksOff, "its hook is missing or switched off: nothing is enforced"
		if h.State != "" {
			note = "its hook is " + h.State + ": nothing is enforced"
		}
	default:
		status, note = StatusDetectionOnly, "no hook exists for this agent and the machine has no kernel layer: seen, not controlled"
	}
	return status, by, note
}

// IsOrphanMCP reports an MCP server effigentd tracks as its own root (no
// known agent above it, track_orphan_mcp): agent "mcp-<server>".
func IsOrphanMCP(agent string) bool { return strings.HasPrefix(agent, "mcp-") }

// ---- unmanaged people ----

// VendorUse is one vendor's seat or usage of a person in the window.
type VendorUse struct {
	Vendor     string     `json:"vendor"`
	Identity   string     `json:"identity"` // as the vendor knows them: an email or a GitHub login
	Seat       bool       `json:"seat"`
	Plan       string     `json:"plan,omitempty"`
	UsageCents int64      `json:"usage_cents"`
	Requests   int64      `json:"requests"`
	ActiveDays int        `json:"active_days"`
	LastActive *time.Time `json:"last_active_at,omitempty"`
}

// UnmanagedPerson pays for (or uses) an AI coding tool but effigentd saw no
// agent of theirs on an enrolled machine in the window.
type UnmanagedPerson struct {
	Person   string      `json:"person"` // work email, or kind:value when the vendor identity isn't mapped
	Name     string      `json:"name,omitempty"`
	Matched  bool        `json:"matched"` // a person, not an unmapped login
	Reason   string      `json:"reason"`  // no_machine | no_activity
	Machines []string    `json:"machines"`
	Vendors  []VendorUse `json:"vendors"`
}

// UnmanagedInput is what Unmanaged needs: Pricing Leaks' seats and usage,
// effigentd's observations since Since and the People mapping.
type UnmanagedInput struct {
	Since    time.Time
	Seats    []spend.Seat
	Usage    []spend.UsageDay
	Machines []spend.Machine
	Obs      []spend.Observation
	People   []spend.Person
}

// Unmanaged lists the people with a vendor seat or vendor usage since Since
// whom no effigentd activity on an enrolled machine resolves to: either
// no machine of theirs is enrolled (no_machine), or one is but no agent ran
// on it in the window (no_activity: they likely work elsewhere).
func Unmanaged(in UnmanagedInput) []UnmanagedPerson {
	dir := spend.NewDirectory(in.People)
	for _, s := range in.Seats {
		if spend.SeatKind(s.Vendor) == "email" {
			dir.AddKnown(s.Identity)
		}
	}
	for _, m := range in.Machines {
		dir.AddKnown(m.Owner)
	}
	active := map[string]bool{}
	for _, o := range in.Obs {
		if o.Day.Before(spend.Day(in.Since)) || IsOrphanMCP(o.Agent) {
			continue
		}
		k, _ := dir.ObsPerson(o)
		active[k] = true
	}
	machines := map[string][]string{}
	for _, m := range in.Machines {
		k := dir.EndpointPerson(m.Owner, m.Hostname, m.OSUsers)
		machines[k] = append(machines[k], m.Hostname)
	}
	type acc struct {
		p    UnmanagedPerson
		uses map[string]*VendorUse
		days map[string]map[time.Time]bool
	}
	people := map[string]*acc{}
	get := func(vendor, identity string) *VendorUse {
		k := dir.Resolve(spend.SeatKind(vendor), identity)
		if k == "" {
			return nil
		}
		a := people[k]
		if a == nil {
			a = &acc{p: UnmanagedPerson{Person: k, Name: dir.Name(k), Matched: spend.IsPerson(k)}, uses: map[string]*VendorUse{}, days: map[string]map[time.Time]bool{}}
			people[k] = a
		}
		u := a.uses[vendor]
		if u == nil {
			u = &VendorUse{Vendor: vendor, Identity: strings.ToLower(strings.TrimSpace(identity))}
			a.uses[vendor], a.days[vendor] = u, map[time.Time]bool{}
		}
		return u
	}
	for _, s := range in.Seats {
		if u := get(s.Vendor, s.Identity); u != nil {
			u.Seat, u.Plan = true, s.Plan
			if s.LastActivity != nil && (u.LastActive == nil || s.LastActivity.After(*u.LastActive)) {
				t := *s.LastActivity
				u.LastActive = &t
			}
		}
	}
	for _, d := range in.Usage {
		if d.Identity == "" || !d.Active() || d.Day.Before(spend.Day(in.Since)) {
			continue
		}
		u := get(d.Vendor, d.Identity)
		if u == nil {
			continue
		}
		u.UsageCents += d.CostCents
		u.Requests += d.Requests
		people[dir.Resolve(spend.SeatKind(d.Vendor), d.Identity)].days[d.Vendor][spend.Day(d.Day)] = true
		if u.LastActive == nil || d.Day.After(*u.LastActive) {
			t := d.Day
			u.LastActive = &t
		}
	}
	out := []UnmanagedPerson{}
	for k, a := range people {
		if active[k] {
			continue
		}
		p := a.p
		p.Machines = machines[k]
		if p.Machines == nil {
			p.Machines = []string{}
		}
		sort.Strings(p.Machines)
		p.Reason = "no_machine"
		if len(p.Machines) > 0 {
			p.Reason = "no_activity"
		}
		for v, u := range a.uses {
			u.ActiveDays = len(a.days[v])
			p.Vendors = append(p.Vendors, *u)
		}
		sort.Slice(p.Vendors, func(i, j int) bool { return p.Vendors[i].Vendor < p.Vendors[j].Vendor })
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Matched != out[j].Matched {
			return out[i].Matched
		}
		return out[i].Person < out[j].Person
	})
	return out
}
