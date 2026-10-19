// Package spend is Pricing Leaks: what an organisation pays AI coding tool
// vendors (seats, usage, cost from their admin APIs or CSV exports), joined
// with what effigentd sees running on each machine, to flag waste.
//
// The package is pure apart from the vendor clients (clients.go): sync pulls
// vendor data into normalized Seat / UsageDay rows (stored by the control
// plane), and Analyze turns those rows plus effigentd's observations into a
// Report. Nothing here reads the database.
package spend

import (
	"strings"
	"time"
)

// Vendors with a connector. Keep in sync with the console (PricingLeaks.tsx).
const (
	Cursor    = "cursor"
	Anthropic = "anthropic"
	Copilot   = "copilot" // GitHub Copilot; seats are keyed by GitHub login
	OpenAI    = "openai"
)

// Vendors lists the vendors with a connector, in display order.
var Vendors = []string{Cursor, Anthropic, Copilot, OpenAI}

// VendorLabel is the name shown in the console.
var VendorLabel = map[string]string{
	Cursor: "Cursor", Anthropic: "Anthropic (Claude Code)", Copilot: "GitHub Copilot", OpenAI: "OpenAI (Codex)",
	"google": "Google (Gemini CLI)", "byok": "Bring-your-own-key agents",
}

// IsVendor reports whether v has a connector.
func IsVendor(v string) bool {
	for _, x := range Vendors {
		if x == v {
			return true
		}
	}
	return false
}

// AgentVendor maps an effigentd agent name (cp.events.agent) to the vendor
// that bills for it. "byok" agents (open source) run on whatever model API
// key the developer gives them; "" = not a billed coding agent (MCP servers…).
func AgentVendor(agent string) string {
	a := strings.ToLower(agent)
	switch {
	case a == "" || strings.HasPrefix(a, "mcp:"):
		return ""
	case strings.HasPrefix(a, "claude"): // claude-code, claude-cowork
		return Anthropic
	case strings.HasPrefix(a, "codex"):
		return OpenAI
	case strings.HasPrefix(a, "cursor"):
		return Cursor
	case strings.Contains(a, "copilot"):
		return Copilot
	case strings.HasPrefix(a, "gemini"):
		return "google"
	case a == "aider" || a == "opencode" || a == "goose" || a == "cline" || a == "continue":
		return "byok"
	}
	return ""
}

// Seat is one paid (or assigned) seat on a vendor's company plan.
type Seat struct {
	Vendor string `json:"vendor"`
	// Identity is what the vendor keys the seat on: an email (Cursor,
	// Anthropic) or a GitHub login (Copilot).
	Identity string `json:"identity"`
	Name     string `json:"name,omitempty"`
	Plan     string `json:"plan,omitempty"` // e.g. business / enterprise (Copilot), member / owner (Cursor)
	// PriceCents is the seat's monthly price when the vendor or the CSV says
	// so; 0 = use the tenant's price table (Prices.Seat).
	PriceCents   int64      `json:"price_cents,omitempty"`
	AssignedAt   *time.Time `json:"assigned_at,omitempty"`
	LastActivity *time.Time `json:"last_activity_at,omitempty"`
	Source       string     `json:"source"` // api | csv
}

// UsageDay is one identity's usage of a vendor on one UTC day. Identity ""
// is the organisation's total for the day (cost reports that aren't per
// person); per-person rows then attribute part of it.
type UsageDay struct {
	Vendor    string    `json:"vendor"`
	Day       time.Time `json:"day"` // UTC midnight
	Identity  string    `json:"identity"`
	CostCents int64     `json:"cost_cents"`
	Requests  int64     `json:"requests"`
	Tokens    int64     `json:"tokens"`
	// Estimated: the cost is the vendor's estimate (Claude Code Analytics) or
	// our allocation of the org's cost by token share (OpenAI).
	Estimated bool   `json:"estimated,omitempty"`
	Source    string `json:"source"` // api | csv
}

// Active reports whether the row shows any use.
func (u UsageDay) Active() bool { return u.Requests > 0 || u.Tokens > 0 || u.CostCents > 0 }

// Observation is effigentd's view: an agent ran on a machine on a day.
type Observation struct {
	EndpointID string   `json:"endpoint_id"`
	Hostname   string   `json:"hostname"`
	Owner      string   `json:"owner"`    // cp.endpoints.owner (email or console user id)
	OSUsers    []string `json:"os_users"` // OS users seen on the machine (approval requests)
	// OSUser and GitEmail: who ran the agent, from the events themselves
	// (effigentd builds that send them; empty on older ones).
	OSUser   string    `json:"os_user,omitempty"`
	GitEmail string    `json:"git_email,omitempty"`
	Model    string    `json:"model,omitempty"`
	Agent    string    `json:"agent"`
	Day      time.Time `json:"day"`
	Events   int64     `json:"events"`
}

// Prices are monthly list prices in USD cents, used when vendor data doesn't
// carry a price. Tenants override any of them (cp.spend_settings).
type Prices struct {
	// Seat: per vendor, or "vendor/plan" (e.g. "copilot/enterprise").
	Seat map[string]int64 `json:"seat"`
	// Personal: the cheapest individual plan of the vendor behind an agent,
	// i.e. what a developer most likely pays (or expenses) off the company plan.
	Personal map[string]int64 `json:"personal"`
}

// DefaultPrices are public list prices as of October 2026 — assumptions, not
// vendor data. Anthropic and OpenAI API usage is pay-as-you-go (no seat);
// set a seat price if the workspace buys Claude Team / Enterprise seats.
var DefaultPrices = Prices{
	Seat: map[string]int64{
		Cursor:                  4000, // Cursor Teams, $40/user/month
		Copilot:                 1900, // Copilot Business
		Copilot + "/business":   1900,
		Copilot + "/enterprise": 3900,
		Anthropic:               0,
		OpenAI:                  0,
	},
	Personal: map[string]int64{
		Cursor: 2000, Anthropic: 2000, OpenAI: 2000, // Cursor Pro, Claude Pro, ChatGPT Plus
		Copilot: 1000, "google": 0, "byok": 0, // Copilot Pro; Gemini CLI's free tier; BYO key: unknown
	},
}

// Merge returns the defaults with the tenant's overrides applied.
func (p Prices) Merge(over Prices) Prices {
	out := Prices{Seat: map[string]int64{}, Personal: map[string]int64{}}
	for k, v := range p.Seat {
		out.Seat[k] = v
	}
	for k, v := range p.Personal {
		out.Personal[k] = v
	}
	for k, v := range over.Seat {
		if v >= 0 {
			out.Seat[strings.ToLower(k)] = v
		}
	}
	for k, v := range over.Personal {
		if v >= 0 {
			out.Personal[strings.ToLower(k)] = v
		}
	}
	return out
}

// SeatPrice is a seat's monthly price: its own, else vendor/plan, else vendor.
func (p Prices) SeatPrice(s Seat) int64 {
	if s.PriceCents > 0 {
		return s.PriceCents
	}
	if v, ok := p.Seat[s.Vendor+"/"+strings.ToLower(s.Plan)]; ok && s.Plan != "" {
		return v
	}
	return p.Seat[s.Vendor]
}

// Day truncates t to its UTC day.
func Day(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}
