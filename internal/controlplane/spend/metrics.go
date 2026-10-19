package spend

import (
	"sort"
	"time"
)

// Daily series for the console's Spend over time (GET /pricing-leaks/metrics).
// The report history (seats, leaks) is rolled up by the control plane; these
// two come straight from the stored vendor usage and effigentd's activity
// rollup, so the chart has a trend from the first sync on.

// UsagePoint is what one vendor reported for one day.
type UsagePoint struct {
	Day       time.Time `json:"day"`
	Vendor    string    `json:"vendor"`
	CostCents int64     `json:"cost_cents"`
	Requests  int64     `json:"requests"`
	Tokens    int64     `json:"tokens"`
	People    int       `json:"people"` // identities with use that day
	Estimated bool      `json:"estimated,omitempty"`
}

// DailyUsage sums usage rows per vendor and day. Like the report, a day's
// organisation total (identity "") is its cost when the vendor sends one;
// otherwise the per-person rows add up to it.
func DailyUsage(usage []UsageDay) []UsagePoint {
	type acc struct {
		org, person       UsagePoint // sums of the organisation's rows and of the per-person rows
		hasOrg, hasPerson bool
		people            map[string]bool
	}
	add := func(p *UsagePoint, u UsageDay) {
		p.CostCents += u.CostCents
		p.Requests += u.Requests
		p.Tokens += u.Tokens
		p.Estimated = p.Estimated || u.Estimated
	}
	byKey := map[string]*acc{}
	for _, u := range usage {
		d := Day(u.Day)
		k := u.Vendor + "|" + d.Format(time.DateOnly)
		a := byKey[k]
		if a == nil {
			a = &acc{person: UsagePoint{Day: d, Vendor: u.Vendor}, people: map[string]bool{}}
			byKey[k] = a
		}
		if u.Identity == organisationPerson {
			a.hasOrg = true
			add(&a.org, u)
			continue
		}
		a.hasPerson = true
		add(&a.person, u)
		if u.Active() {
			a.people[u.Identity] = true
		}
	}
	out := make([]UsagePoint, 0, len(byKey))
	for _, a := range byKey {
		p := a.person
		p.People = len(a.people)
		if a.hasOrg {
			p.CostCents = a.org.CostCents
			p.Estimated = p.Estimated || a.org.Estimated
			if !a.hasPerson {
				p.Requests, p.Tokens = a.org.Requests, a.org.Tokens
			}
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Day.Equal(out[j].Day) {
			return out[i].Day.Before(out[j].Day)
		}
		return out[i].Vendor < out[j].Vendor
	})
	return out
}

// ActivityRow is one machine's events for one agent on one day
// (cp.agent_activity_daily, summed over OS users and models).
type ActivityRow struct {
	Day        time.Time
	Agent      string
	EndpointID string
	Events     int64
}

// ActivityPoint is effigentd's side for one billed vendor and day.
type ActivityPoint struct {
	Day      time.Time `json:"day"`
	Vendor   string    `json:"vendor"`
	Events   int64     `json:"events"`
	Machines int       `json:"machines"`
	Agents   []string  `json:"agents"`
}

// DailyActivity groups effigentd's activity by the vendor that bills each
// agent (AgentVendor); agents no vendor bills (MCP servers…) are left out.
func DailyActivity(rows []ActivityRow) []ActivityPoint {
	type acc struct {
		p        ActivityPoint
		machines map[string]bool
		agents   map[string]bool
	}
	byKey := map[string]*acc{}
	for _, r := range rows {
		v := AgentVendor(r.Agent)
		if v == "" {
			continue
		}
		d := Day(r.Day)
		k := v + "|" + d.Format(time.DateOnly)
		a := byKey[k]
		if a == nil {
			a = &acc{p: ActivityPoint{Day: d, Vendor: v}, machines: map[string]bool{}, agents: map[string]bool{}}
			byKey[k] = a
		}
		a.p.Events += r.Events
		a.machines[r.EndpointID] = true
		a.agents[r.Agent] = true
	}
	out := make([]ActivityPoint, 0, len(byKey))
	for _, a := range byKey {
		p := a.p
		p.Machines, p.Agents = len(a.machines), sortedKeys(a.agents)
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Day.Equal(out[j].Day) {
			return out[i].Day.Before(out[j].Day)
		}
		return out[i].Vendor < out[j].Vendor
	})
	return out
}

// Alerting: which leaks are announced as they appear (the rest are on the
// page only). Runaway cost is the one that grows by the hour.
var AlertTypes = []string{RunawayCost}

// AlertRepeat is how long an announced leak that is still there waits before
// it is announced again.
const AlertRepeat = 7 * 24 * time.Hour
