package spend

import (
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

func daysAgo(n int) time.Time   { return Day(now).AddDate(0, 0, -n) }
func tp(t time.Time) *time.Time { return &t }

// A small company: Cursor and Copilot seats, Anthropic usage per person,
// OpenAI connected; effigentd on five machines.
func scenario() Input {
	in := Input{
		Now: now,
		People: []Person{
			{Email: "Dana@acme.io", Name: "Dana Katz", Aliases: []string{"github:dana-k", "dana-mbp"}},
			{Email: "omer@acme.io", Name: "Omer Levi"},
			{Email: "noa@acme.io", Name: "Noa Peretz"},
		},
		Machines: []Machine{
			{ID: "e1", Hostname: "dana-mbp", LastSeen: tp(now)}, // no owner: matched by the hostname alias
			{ID: "e2", Hostname: "omer-mbp", Owner: "omer@acme.io", LastSeen: tp(now)},
			{ID: "e3", Hostname: "noa-ws", Owner: "noa@acme.io", LastSeen: tp(now)},
			{ID: "e4", Hostname: "build-7", LastSeen: tp(now)},
			{ID: "e5", Hostname: "raj-ws", Owner: "raj@acme.io", LastSeen: tp(now)},
		},
		Seats: []Seat{
			{Vendor: Cursor, Identity: "dana@acme.io", Source: "api"},
			{Vendor: Cursor, Identity: "omer@acme.io", Source: "api"},
			{Vendor: Cursor, Identity: "noa@acme.io", Source: "api"},
			{Vendor: Cursor, Identity: "idle@acme.io", Name: "Idle Person", Source: "api"},
			{Vendor: Copilot, Identity: "dana-k", Plan: "business", LastActivity: tp(daysAgo(40)), Source: "api"},
			{Vendor: Copilot, Identity: "ghost-user", Plan: "enterprise", LastActivity: tp(daysAgo(60)), Source: "api"},
			{Vendor: Copilot, Identity: "new-hire", Plan: "business", AssignedAt: tp(daysAgo(3)), Source: "api"},
		},
		Prices:    DefaultPrices,
		Connected: []string{Cursor, Copilot, Anthropic, OpenAI},
	}
	add := func(o Observation, days int) {
		for i := 0; i < days; i++ {
			o.Day, o.Events = daysAgo(i), 40
			in.Obs = append(in.Obs, o)
		}
	}
	add(Observation{Hostname: "dana-mbp", Agent: "claude-code"}, 20)
	in.Obs = append(in.Obs, Observation{Hostname: "dana-mbp", Agent: "cursor-agent", Day: daysAgo(10), Events: 3})
	add(Observation{Hostname: "omer-mbp", Owner: "omer@acme.io", Agent: "cursor-agent"}, 20)
	add(Observation{Hostname: "noa-ws", Owner: "noa@acme.io", Agent: "codex"}, 5)
	add(Observation{Hostname: "build-7", Agent: "aider"}, 3)
	add(Observation{Hostname: "raj-ws", Owner: "raj@acme.io", Agent: "claude-code"}, 20)
	add(Observation{Hostname: "raj-ws", Owner: "raj@acme.io", Agent: "mcp:github"}, 20) // not a billed agent

	in.Usage = append(in.Usage, UsageDay{Vendor: Cursor, Day: daysAgo(10), Identity: "dana@acme.io", Requests: 2})
	for i := 0; i < 20; i++ {
		in.Usage = append(in.Usage,
			UsageDay{Vendor: Cursor, Day: daysAgo(i), Identity: "omer@acme.io", Requests: 30, CostCents: 10},
			UsageDay{Vendor: Anthropic, Day: daysAgo(i), Identity: "dana@acme.io", CostCents: 500, Tokens: 1e6},
			UsageDay{Vendor: Anthropic, Day: daysAgo(i), Identity: "omer@acme.io", CostCents: 400, Tokens: 1e6},
			UsageDay{Vendor: Anthropic, Day: daysAgo(i), Identity: "noa@acme.io", CostCents: 600, Tokens: 1e6},
			UsageDay{Vendor: Anthropic, Day: daysAgo(i), Identity: "raj@acme.io", CostCents: 5000, Tokens: 1e7},
		)
	}
	for i := 1; i <= 7; i++ {
		in.Usage = append(in.Usage, UsageDay{Vendor: Anthropic, Day: daysAgo(i), Identity: "key:ci-bot", CostCents: 200, Tokens: 1e5})
	}
	in.Usage = append(in.Usage, UsageDay{Vendor: Anthropic, Day: daysAgo(0), Identity: "key:ci-bot", CostCents: 8000, Tokens: 1e7})
	return in
}

func find(r Report, typ, vendor, person string) *Leak {
	for i := range r.Leaks {
		l := &r.Leaks[i]
		if l.Type == typ && l.Vendor == vendor && l.Person == person {
			return l
		}
	}
	return nil
}

func TestAnalyzeScenario(t *testing.T) {
	r := Analyze(scenario())
	for _, l := range r.Leaks {
		t.Logf("%-15s %-10s %-22s save %6d risk %5d %-6s %s | %s", l.Type, l.Vendor, l.Person, l.MonthlySavingsCents, l.AtRiskCents, l.Confidence, l.Title, strings.Join(l.Evidence, " | "))
	}
	want := []struct {
		typ, vendor, person, conf string
		save, risk                int64
	}{
		{UnusedSeat, Cursor, "noa@acme.io", confidenceHigh, 4000, 0},          // effigentd covers Noa, Cursor shows nothing
		{UnusedSeat, Cursor, "idle@acme.io", confidenceMedium, 4000, 0},       // no machine: vendor evidence only
		{UnusedSeat, Copilot, "dana@acme.io", confidenceHigh, 1900, 0},        // login dana-k → Dana via alias
		{UnusedSeat, Copilot, "github:ghost-user", confidenceMedium, 3900, 0}, // enterprise price, unmatched login
		{DuplicateTool, Cursor, "dana@acme.io", confidenceHigh, 4000, 0},      // Claude Code daily, Cursor on one day
		{ShadowSpend, OpenAI, "noa@acme.io", confidenceHigh, 0, 2000},         // codex, not on the OpenAI org
		{ShadowSpend, "byok", "host:build-7", confidenceLow, 0, 0},            // aider on an unowned box
		{RunawayCost, Anthropic, "raj@acme.io", confidenceHigh, 70000, 0},     // 100000 - 3 × the 10000 median
		{RunawayCost, Anthropic, "key:ci-bot", confidenceMedium, 7800, 0},     // spike today
	}
	for _, w := range want {
		l := find(r, w.typ, w.vendor, w.person)
		if l == nil {
			t.Errorf("missing %s %s %s", w.typ, w.vendor, w.person)
			continue
		}
		if l.MonthlySavingsCents != w.save || l.AtRiskCents != w.risk || l.Confidence != w.conf {
			t.Errorf("%s %s %s: save %d risk %d conf %s, want %d %d %s", w.typ, w.vendor, w.person, l.MonthlySavingsCents, l.AtRiskCents, l.Confidence, w.save, w.risk, w.conf)
		}
	}
	if len(r.Leaks) != len(want) {
		t.Errorf("%d leaks, want %d", len(r.Leaks), len(want))
	}
	// not flagged
	for _, l := range r.Leaks {
		switch {
		case l.Person == "github:new-hire":
			t.Errorf("seat in its grace period flagged: %+v", l)
		case l.Person == "omer@acme.io":
			t.Errorf("Omer uses his Cursor seat daily: %+v", l)
		case l.Type == ShadowSpend && l.Person == "raj@acme.io":
			t.Errorf("Raj is on the Anthropic account: %+v", l)
		}
	}
	if find(r, DuplicateTool, Copilot, "dana@acme.io") != nil {
		t.Error("a seat flagged unused must not also be a duplicate")
	}
	var total int64
	for _, w := range want {
		total += w.save
	}
	if r.TotalSavingsCents != total || r.TotalAtRiskCents != 2000 {
		t.Errorf("totals %d / %d, want %d / 2000", r.TotalSavingsCents, r.TotalAtRiskCents, total)
	}
	if r.Leaks[0].Person != "raj@acme.io" {
		t.Errorf("leaks not sorted by savings: first %s", r.Leaks[0].ID)
	}
	if len(r.Unattributed) != 1 || r.Unattributed[0] != "build-7" {
		t.Errorf("unattributed %v", r.Unattributed)
	}
	if l := find(r, UnusedSeat, Cursor, "idle@acme.io"); l.Name != "Idle Person" {
		t.Errorf("name from the seat: %q", l.Name)
	}

	byVendor := map[string]VendorSpend{}
	for _, v := range r.Vendors {
		byVendor[v.Vendor] = v
	}
	if c := byVendor[Cursor]; c.Seats != 4 || c.SeatCents != 16000 || c.ActiveSeats != 2 || c.UsageCents != 200 || c.MonthlyCents != 16200 {
		t.Errorf("cursor spend %+v", c)
	}
	if c := byVendor[Copilot]; c.Seats != 3 || c.SeatCents != 1900+3900+1900 {
		t.Errorf("copilot spend %+v", c)
	}
	// Anthropic: no org-level rows, so the per-person sum: 20 days × 6500 + 9400
	if a := byVendor[Anthropic]; a.UsageCents != 139400 || a.MonthlyCents != 139400 {
		t.Errorf("anthropic spend %+v", a)
	}
	if o, ok := byVendor[OpenAI]; !ok || !o.Connected || o.MonthlyCents != 0 {
		t.Errorf("openai spend %+v", o)
	}
}

func TestOrgLevelSpike(t *testing.T) {
	in := Input{Now: now, Connected: []string{OpenAI}}
	for i := 1; i <= 10; i++ {
		in.Usage = append(in.Usage, UsageDay{Vendor: OpenAI, Day: daysAgo(i), CostCents: 1000})
	}
	in.Usage = append(in.Usage, UsageDay{Vendor: OpenAI, Day: daysAgo(0), CostCents: 9000})
	r := Analyze(in)
	l := find(r, RunawayCost, OpenAI, "")
	if l == nil || l.MonthlySavingsCents != 8000 || l.Name != "Whole organisation" {
		t.Fatalf("org spike: %+v", r.Leaks)
	}
	if r.Vendors[0].Vendor != OpenAI || r.Vendors[0].UsageCents != 19000 {
		t.Fatalf("vendor spend from org rows: %+v", r.Vendors)
	}
}

func TestNoEvidenceNoLeak(t *testing.T) {
	// a Cursor seat, Cursor reports no activity at all for anyone, and the
	// person has no machine: nothing says the seat is unused
	r := Analyze(Input{Now: now, Seats: []Seat{{Vendor: Cursor, Identity: "x@acme.io"}}, Connected: []string{Cursor}})
	if len(r.Leaks) != 0 {
		t.Fatalf("leaks without evidence: %+v", r.Leaks)
	}
	// zero-price seats (API pay-as-you-go) never become savings
	r = Analyze(Input{Now: now, Seats: []Seat{{Vendor: Anthropic, Identity: "x@acme.io", LastActivity: tp(daysAgo(90))}}})
	if len(r.Leaks) != 0 {
		t.Fatalf("zero-price seat flagged: %+v", r.Leaks)
	}
	// shadow spend needs the vendor's plan data
	r = Analyze(Input{Now: now, Machines: []Machine{{Hostname: "m", Owner: "a@acme.io", LastSeen: tp(now)}},
		Obs: []Observation{{Hostname: "m", Owner: "a@acme.io", Agent: "cursor-agent", Day: daysAgo(1)}}})
	if len(r.Leaks) != 0 {
		t.Fatalf("shadow spend without a Cursor connector: %+v", r.Leaks)
	}
}

func TestPricesMerge(t *testing.T) {
	p := DefaultPrices.Merge(Prices{Seat: map[string]int64{"Cursor": 3200, "anthropic": 15000}})
	if p.SeatPrice(Seat{Vendor: Cursor}) != 3200 || p.SeatPrice(Seat{Vendor: Anthropic}) != 15000 {
		t.Fatalf("override: %+v", p.Seat)
	}
	if p.SeatPrice(Seat{Vendor: Copilot, Plan: "Enterprise"}) != 3900 || p.SeatPrice(Seat{Vendor: Copilot, Plan: "unknown"}) != 1900 {
		t.Fatal("plan prices")
	}
	if p.SeatPrice(Seat{Vendor: Cursor, PriceCents: 4500}) != 4500 {
		t.Fatal("a seat's own price wins")
	}
	if DefaultPrices.Seat[Cursor] != 4000 {
		t.Fatal("Merge changed the defaults")
	}
}

func TestDirectory(t *testing.T) {
	d := NewDirectory([]Person{
		{Email: "Dana@Acme.io", Aliases: []string{"github:Dana-K", "dana", "dana@gmail.com", "dana-mbp"}},
		{Email: "omer@acme.io", Aliases: []string{"dana"}}, // taken: stays Dana's
	})
	cases := []struct{ kind, v, want string }{
		{"github", "dana-k", "dana@acme.io"},
		{"email", "DANA@gmail.com", "dana@acme.io"},
		{"os", "dana", "dana@acme.io"},
		{"github", "someone", "github:someone"},
		{"email", "x@acme.io", "x@acme.io"},
		{"host", " ", ""},
	}
	for _, c := range cases {
		if got := d.Resolve(c.kind, c.v); got != c.want {
			t.Errorf("Resolve(%s, %q) = %q, want %q", c.kind, c.v, got, c.want)
		}
	}
	if got := d.EndpointPerson("", "dana-mbp", nil); got != "dana@acme.io" {
		t.Errorf("hostname alias: %q", got)
	}
	if got := d.EndpointPerson("user_2abc", "box", []string{"dana"}); got != "dana@acme.io" {
		t.Errorf("os user alias: %q", got)
	}
	if got := d.EndpointPerson("user_2abc", "box", nil); got != "user:user_2abc" {
		t.Errorf("unmatched owner: %q", got)
	}
	if got := d.EndpointPerson("", "box", []string{"dana", "omer@acme.io"}); got != "host:box" {
		t.Errorf("two people on one machine must not guess: %q", got)
	}
}

func TestAgentVendor(t *testing.T) {
	for agent, v := range map[string]string{"claude-code": Anthropic, "claude-cowork": Anthropic, "codex": OpenAI, "cursor-agent": Cursor,
		"gemini-cli": "google", "aider": "byok", "goose": "byok", "mcp:github": "", "hermes": ""} {
		if got := AgentVendor(agent); got != v {
			t.Errorf("%s: %q, want %q", agent, got, v)
		}
	}
}
