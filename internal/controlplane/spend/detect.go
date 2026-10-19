package spend

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// Leak types.
const (
	UnusedSeat    = "unused_seat"    // paid seat, no use in the window (vendor and effigentd agree)
	DuplicateTool = "duplicate_tool" // a person pays for several tools but really uses one
	ShadowSpend   = "shadow_spend"   // effigentd sees an agent for someone not on the company plan
	RunawayCost   = "runaway_cost"   // far above the team, or a sudden spike (a loop in CI)
)

// Thresholds (exported so tests and the docs can name them).
const (
	SeatGraceDays      = 14   // seats assigned more recently aren't "unused" yet
	RunawayMedianX     = 3.0  // a person above 3× the vendor's median cost is a runaway
	RunawayMinCents    = 5000 // ...if the excess is at least $50 in the window
	MinPeersForMedian  = 3    // the median needs at least this many paying people
	SpikeX             = 5.0  // a day at 5× the trailing 7-day mean is a spike
	SpikeMinCents      = 2000 // ...if it is at least $20 above that mean
	SpikeLookbackDays  = 7
	SpikeRecentDays    = 3 // only the last 3 days are checked for spikes (it's an alert, not history)
	DuplicateMinDays   = 5 // the tool a person relies on was used on at least 5 days
	DuplicateLowDays   = 2 // ...and the one they don't was used on at most 2 days (or 20% of that)
	DuplicateLowShare  = 0.2
	defaultWindowDays  = 30
	confidenceHigh     = "high"
	confidenceMedium   = "medium"
	confidenceLow      = "low"
	organisationPerson = ""
)

// Machine is an enrolled endpoint (whether or not agents ran on it).
type Machine struct {
	ID       string     `json:"id"`
	Hostname string     `json:"hostname"`
	Owner    string     `json:"owner"`
	OSUsers  []string   `json:"os_users"`
	LastSeen *time.Time `json:"last_seen"`
}

// Input is everything Analyze needs.
type Input struct {
	Now        time.Time
	WindowDays int // default 30
	Seats      []Seat
	Usage      []UsageDay
	Machines   []Machine
	Obs        []Observation
	People     []Person
	Prices     Prices // already merged with the tenant's overrides
	// Connected lists vendors whose company-plan data we have (a connector
	// that synced, or a CSV import). Shadow spend is only claimed for them.
	Connected []string
}

// Leak is one finding.
type Leak struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Vendor   string   `json:"vendor"`
	Person   string   `json:"person"` // person key ("" = the organisation)
	Name     string   `json:"name,omitempty"`
	Title    string   `json:"title"`
	Evidence []string `json:"evidence"`
	// MonthlySavingsCents: what acting on it saves per month (USD cents).
	MonthlySavingsCents int64 `json:"monthly_savings_cents"`
	// AtRiskCents: spend outside the company's control (shadow spend) — not
	// a saving, since the company doesn't pay it today.
	AtRiskCents int64  `json:"at_risk_cents"`
	Confidence  string `json:"confidence"`
	// Attribution: how effigentd's activity was tied to the person (Via*:
	// os_user, git_email, owner, host, "" = not matched). Leaks that rest on
	// a machine-level match (owner, host) are at most medium confidence.
	Attribution string `json:"attribution,omitempty"`
}

// VendorSpend is what the org pays one vendor.
type VendorSpend struct {
	Vendor      string `json:"vendor"`
	Label       string `json:"label"`
	Seats       int    `json:"seats"`
	ActiveSeats int    `json:"active_seats"`
	SeatCents   int64  `json:"seat_cents"`  // per month
	UsageCents  int64  `json:"usage_cents"` // in the window
	// MonthlyCents = seats + usage scaled to 30 days.
	MonthlyCents int64 `json:"monthly_cents"`
	Estimated    bool  `json:"estimated,omitempty"`
	Connected    bool  `json:"connected"`
}

// ToolUse is one person's use of one vendor.
type ToolUse struct {
	Vendor             string     `json:"vendor"`
	Seat               bool       `json:"seat"`
	SeatCents          int64      `json:"seat_cents,omitempty"`
	Agents             []string   `json:"agents,omitempty"`
	EffigentDays       int        `json:"effigent_days"` // days effigentd saw the vendor's agent
	VendorDays         int        `json:"vendor_days"`   // days the vendor reports use
	LastSeen           *time.Time `json:"last_seen,omitempty"`
	LastVendorActivity *time.Time `json:"last_vendor_activity,omitempty"`
	CostCents          int64      `json:"cost_cents"` // usage in the window
}

// PersonUsage is one person (or unmatched identity) and their tools.
type PersonUsage struct {
	Person   string    `json:"person"`
	Name     string    `json:"name,omitempty"`
	Matched  bool      `json:"matched"`       // resolved to a work email
	Via      string    `json:"via,omitempty"` // strongest match of effigentd's activity (Via*)
	Machines []string  `json:"machines,omitempty"`
	Tools    []ToolUse `json:"tools"`
}

// Report is the Pricing Leaks page.
type Report struct {
	GeneratedAt       time.Time     `json:"generated_at"`
	WindowDays        int           `json:"window_days"`
	Vendors           []VendorSpend `json:"vendors"`
	TotalMonthlyCents int64         `json:"total_monthly_cents"`
	Leaks             []Leak        `json:"leaks"`
	TotalSavingsCents int64         `json:"total_savings_cents"`
	TotalAtRiskCents  int64         `json:"total_at_risk_cents"`
	People            []PersonUsage `json:"people"`
	// Unattributed: machines that run agents but map to no person — set an
	// owner (Machines) or add the hostname to someone in People.
	Unattributed []string `json:"unattributed"`
}

type tool struct {
	seat         *Seat
	seatCents    int64
	agents       map[string]bool
	effDays      map[time.Time]bool
	vendorDays   map[time.Time]bool
	lastSeen     time.Time
	lastVendor   time.Time
	cost         int64
	dailyCost    map[time.Time]int64
	hasUsageRows bool
}

type analysis struct {
	in       Input
	dir      Directory
	start    time.Time // first day of the window
	today    time.Time
	people   map[string]map[string]*tool
	names    map[string]string
	machines map[string]map[string]bool
	covered  map[string]bool   // people with an enrolled machine seen in the window
	via      map[string]string // strongest way effigentd's activity matched the person
	tracks   map[string]bool   // vendor reports per-person activity
	conn     map[string]bool
	orgDaily map[string]map[time.Time]int64
}

func (a *analysis) tool(person, vendor string) *tool {
	m := a.people[person]
	if m == nil {
		m = map[string]*tool{}
		a.people[person] = m
	}
	t := m[vendor]
	if t == nil {
		t = &tool{agents: map[string]bool{}, effDays: map[time.Time]bool{}, vendorDays: map[time.Time]bool{}, dailyCost: map[time.Time]int64{}}
		m[vendor] = t
	}
	return t
}

// resolveUsage resolves a usage identity: an email, or "kind:value" (key:ci-bot).
func (a *analysis) resolveUsage(vendor, id string) string {
	if kind, v, ok := strings.Cut(id, ":"); ok && !strings.Contains(kind, "@") && kind != "" {
		return a.dir.Resolve(kind, v)
	}
	return a.dir.Resolve(SeatKind(vendor), id)
}

// Analyze joins vendor data with effigentd's observations and finds leaks.
func Analyze(in Input) Report {
	if in.WindowDays <= 0 {
		in.WindowDays = defaultWindowDays
	}
	if in.Prices.Seat == nil {
		in.Prices = DefaultPrices
	}
	a := &analysis{in: in, dir: NewDirectory(in.People), today: Day(in.Now),
		people: map[string]map[string]*tool{}, names: map[string]string{}, machines: map[string]map[string]bool{},
		covered: map[string]bool{}, via: map[string]string{}, tracks: map[string]bool{}, conn: map[string]bool{}, orgDaily: map[string]map[time.Time]int64{}}
	a.start = a.today.AddDate(0, 0, -(in.WindowDays - 1))
	for _, v := range in.Connected {
		a.conn[v] = true
	}
	for _, p := range in.People {
		if p.Name != "" {
			a.names[norm(p.Email)] = p.Name
		}
	}
	// a git email that is someone's seat or a machine owner is that person
	for _, s := range in.Seats {
		if SeatKind(s.Vendor) == KindEmail {
			a.dir.AddKnown(s.Identity)
		}
	}
	for _, m := range in.Machines {
		a.dir.AddKnown(m.Owner)
	}

	for i := range in.Seats {
		s := &in.Seats[i]
		key := a.dir.Resolve(SeatKind(s.Vendor), s.Identity)
		if key == "" {
			continue
		}
		t := a.tool(key, s.Vendor)
		if t.seat == nil || a.in.Prices.SeatPrice(*s) > t.seatCents {
			t.seat, t.seatCents = s, a.in.Prices.SeatPrice(*s)
		}
		if s.LastActivity != nil {
			a.tracks[s.Vendor] = true
			if s.LastActivity.After(t.lastVendor) {
				t.lastVendor = *s.LastActivity
			}
			if !s.LastActivity.Before(a.start) {
				t.vendorDays[Day(*s.LastActivity)] = true
			}
		}
		if a.names[key] == "" && s.Name != "" {
			a.names[key] = s.Name
		}
	}
	for _, u := range in.Usage {
		d := Day(u.Day)
		if d.Before(a.start) || d.After(a.today) {
			continue
		}
		if u.Identity == organisationPerson {
			if a.orgDaily[u.Vendor] == nil {
				a.orgDaily[u.Vendor] = map[time.Time]int64{}
			}
			a.orgDaily[u.Vendor][d] += u.CostCents
			continue
		}
		key := a.resolveUsage(u.Vendor, u.Identity)
		if key == "" {
			continue
		}
		a.tracks[u.Vendor] = true
		t := a.tool(key, u.Vendor)
		t.hasUsageRows = true
		t.cost += u.CostCents
		t.dailyCost[d] += u.CostCents
		if u.Active() {
			t.vendorDays[d] = true
			if end := d.Add(24*time.Hour - time.Second); end.After(t.lastVendor) {
				t.lastVendor = minTime(end, in.Now)
			}
		}
	}
	for _, m := range in.Machines {
		if m.LastSeen == nil || m.LastSeen.Before(a.start) {
			continue
		}
		if key, via := a.dir.endpointPerson(m.Owner, m.Hostname, m.OSUsers); key != "" {
			a.covered[key] = true
			a.matched(key, via)
			a.machine(key, m.Hostname)
		}
	}
	unattributed := map[string]bool{}
	for _, o := range in.Obs {
		d := Day(o.Day)
		v := AgentVendor(o.Agent)
		if v == "" || d.Before(a.start) || d.After(a.today) {
			continue
		}
		key, via := a.dir.ObsPerson(o)
		if key == "" {
			continue
		}
		if !IsPerson(key) {
			unattributed[o.Hostname] = true
		}
		a.covered[key] = true
		a.matched(key, via)
		a.machine(key, o.Hostname)
		t := a.tool(key, v)
		t.agents[o.Agent] = true
		t.effDays[d] = true
		if end := d.Add(24*time.Hour - time.Second); end.After(t.lastSeen) {
			t.lastSeen = minTime(end, in.Now)
		}
	}

	r := Report{GeneratedAt: in.Now.UTC(), WindowDays: in.WindowDays, Leaks: []Leak{}, People: []PersonUsage{}, Unattributed: sortedKeys(unattributed)}
	r.Vendors = a.vendorSpend()
	for _, v := range r.Vendors {
		r.TotalMonthlyCents += v.MonthlyCents
	}
	r.Leaks = append(r.Leaks, a.unusedSeats()...)
	r.Leaks = append(r.Leaks, a.duplicates(r.Leaks)...)
	r.Leaks = append(r.Leaks, a.shadow()...)
	r.Leaks = append(r.Leaks, a.runaway()...)
	for i := range r.Leaks {
		l := &r.Leaks[i]
		l.ID = l.Type + ":" + l.Vendor + ":" + l.Person
		if l.Name == "" {
			l.Name = a.names[l.Person]
		}
		if l.Type != RunawayCost && a.covered[l.Person] { // runaway rests on vendor data only
			l.Attribution = a.via[l.Person]
			if viaRank(l.Attribution) == 2 { // assumes one person per machine
				if l.Confidence == confidenceHigh {
					l.Confidence = confidenceMedium
				}
				l.Evidence = append(l.Evidence, "effigentd's activity is attributed by "+ViaLabel[l.Attribution]+" (one person per machine); map their OS user or git email on the People page to confirm")
			}
		}
		r.TotalSavingsCents += l.MonthlySavingsCents
		r.TotalAtRiskCents += l.AtRiskCents
	}
	sort.SliceStable(r.Leaks, func(i, j int) bool {
		x, y := r.Leaks[i], r.Leaks[j]
		if x.MonthlySavingsCents != y.MonthlySavingsCents {
			return x.MonthlySavingsCents > y.MonthlySavingsCents
		}
		if x.AtRiskCents != y.AtRiskCents {
			return x.AtRiskCents > y.AtRiskCents
		}
		return x.ID < y.ID
	})
	r.People = a.peopleView()
	return r
}

// matched keeps the strongest way a person was tied to effigentd's activity.
func (a *analysis) matched(person, via string) {
	if cur, ok := a.via[person]; !ok || viaRank(via) > viaRank(cur) {
		a.via[person] = via
	}
}

func (a *analysis) machine(person, host string) {
	if host == "" {
		return
	}
	if a.machines[person] == nil {
		a.machines[person] = map[string]bool{}
	}
	a.machines[person][host] = true
}

func (a *analysis) vendorSpend() []VendorSpend {
	seen := map[string]bool{}
	for _, v := range Vendors {
		seen[v] = true
	}
	for _, s := range a.in.Seats {
		seen[s.Vendor] = true
	}
	for _, u := range a.in.Usage {
		seen[u.Vendor] = true
	}
	order := append([]string{}, Vendors...)
	for _, v := range sortedKeys(seen) {
		if !IsVendor(v) {
			order = append(order, v)
		}
	}
	scale := 30.0 / float64(a.in.WindowDays)
	var out []VendorSpend
	for _, v := range order {
		vs := VendorSpend{Vendor: v, Label: cmpOr(VendorLabel[v], v), Connected: a.conn[v]}
		var perPerson int64
		for _, tools := range a.people {
			t := tools[v]
			if t == nil {
				continue
			}
			if t.seat != nil {
				vs.Seats++
				vs.SeatCents += t.seatCents
				if len(t.vendorDays) > 0 || len(t.effDays) > 0 {
					vs.ActiveSeats++
				}
			}
			perPerson += t.cost
		}
		if org, ok := a.orgDaily[v]; ok {
			for _, c := range org {
				vs.UsageCents += c
			}
		} else {
			vs.UsageCents = perPerson
		}
		for _, u := range a.in.Usage {
			if u.Vendor == v && u.Estimated {
				vs.Estimated = true
				break
			}
		}
		vs.MonthlyCents = vs.SeatCents + int64(math.Round(float64(vs.UsageCents)*scale))
		if vs.Seats == 0 && vs.UsageCents == 0 && !vs.Connected {
			continue
		}
		out = append(out, vs)
	}
	if out == nil {
		out = []VendorSpend{}
	}
	return out
}

// days counts a tool's days of use: the vendor's or effigentd's.
func (t *tool) days() int {
	n := len(t.vendorDays)
	for d := range t.effDays {
		if !t.vendorDays[d] {
			n++
		}
	}
	return n
}

func (a *analysis) unusedSeats() []Leak {
	var out []Leak
	for _, person := range sortedKeys(a.people) {
		for _, v := range sortedKeys(a.people[person]) {
			t := a.people[person][v]
			if t.seat == nil || t.seatCents <= 0 || t.days() > 0 {
				continue
			}
			if t.seat.AssignedAt != nil && a.in.Now.Sub(*t.seat.AssignedAt) < SeatGraceDays*24*time.Hour {
				continue
			}
			vendorKnows, effKnows := a.tracks[v], a.covered[person]
			if !vendorKnows && !effKnows {
				continue // no evidence either way
			}
			var ev []string
			if vendorKnows {
				if t.lastVendor.IsZero() {
					ev = append(ev, fmt.Sprintf("%s reports no activity for this seat", VendorLabel[v]))
				} else {
					ev = append(ev, fmt.Sprintf("%s: last activity %s (%d days ago)", VendorLabel[v], t.lastVendor.Format("2006-01-02"), int(a.in.Now.Sub(t.lastVendor).Hours()/24)))
				}
			}
			if effKnows {
				ev = append(ev, fmt.Sprintf("effigentd: no %s agent on %s in %d days", VendorLabel[v], strings.Join(sortedKeys(a.machines[person]), ", "), a.in.WindowDays))
			} else {
				ev = append(ev, "effigentd: no agent activity is linked to this person (map their OS user, git email or machine on the People page)")
			}
			conf := confidenceMedium
			if vendorKnows && effKnows {
				conf = confidenceHigh
			}
			out = append(out, Leak{Type: UnusedSeat, Vendor: v, Person: person, Confidence: conf, MonthlySavingsCents: t.seatCents,
				Title:    fmt.Sprintf("Unused %s seat", VendorLabel[v]),
				Evidence: append(ev, fmt.Sprintf("Seat: %s/month%s", money(t.seatCents), planNote(t.seat)))})
		}
	}
	return out
}

func planNote(s *Seat) string {
	if s.Plan == "" {
		return ""
	}
	return " (" + s.Plan + ")"
}

func (a *analysis) duplicates(already []Leak) []Leak {
	flagged := map[string]bool{}
	for _, l := range already {
		flagged[l.Vendor+"|"+l.Person] = true
	}
	var out []Leak
	for _, person := range sortedKeys(a.people) {
		tools := a.people[person]
		var main string
		best := 0
		for _, v := range sortedKeys(tools) {
			if d := tools[v].days(); d > best {
				main, best = v, d
			}
		}
		if best < DuplicateMinDays {
			continue
		}
		low := DuplicateLowDays
		if s := int(math.Floor(float64(best) * DuplicateLowShare)); s > low {
			low = s
		}
		for _, v := range sortedKeys(tools) {
			t := tools[v]
			if v == main || t.seat == nil || t.seatCents <= 0 || flagged[v+"|"+person] || t.days() > low {
				continue
			}
			out = append(out, Leak{Type: DuplicateTool, Vendor: v, Person: person, MonthlySavingsCents: t.seatCents,
				Confidence: map[bool]string{true: confidenceHigh, false: confidenceMedium}[a.covered[person] && a.tracks[v]],
				Title:      fmt.Sprintf("Pays for %s, works in %s", VendorLabel[v], cmpOr(VendorLabel[main], main)),
				Evidence: []string{
					fmt.Sprintf("%s used on %d of the last %d days%s", cmpOr(VendorLabel[main], main), best, a.in.WindowDays, agentsNote(tools[main])),
					fmt.Sprintf("%s used on %d days%s", VendorLabel[v], t.days(), agentsNote(t)),
					fmt.Sprintf("Dropping the %s seat saves %s/month", VendorLabel[v], money(t.seatCents)),
				}})
		}
	}
	return out
}

func agentsNote(t *tool) string {
	if len(t.agents) == 0 {
		return ""
	}
	return " (effigentd saw " + strings.Join(sortedKeys(t.agents), ", ") + ")"
}

func (a *analysis) shadow() []Leak {
	var out []Leak
	for _, person := range sortedKeys(a.people) {
		tools := a.people[person]
		for _, v := range sortedKeys(tools) {
			t := tools[v]
			if len(t.effDays) == 0 || t.seat != nil || t.hasUsageRows {
				continue
			}
			who := "this person"
			conf := confidenceHigh
			if !IsPerson(person) {
				who, conf = "this machine's user", confidenceMedium
			}
			ev := []string{fmt.Sprintf("effigentd saw %s on %d of the last %d days on %s", strings.Join(sortedKeys(t.agents), ", "),
				len(t.effDays), a.in.WindowDays, strings.Join(sortedKeys(a.machines[person]), ", "))}
			switch {
			case IsVendor(v):
				if !a.conn[v] {
					continue // we don't know the company plan for this vendor
				}
				ev = append(ev, fmt.Sprintf("%s has no seat or usage for %s on the company account", VendorLabel[v], who))
				if v == Anthropic || v == OpenAI {
					ev = append(ev, "If they use a shared company API key, map the key name to them on the People page")
				}
			case v == "google":
				conf = confidenceLow
				ev = append(ev, "No company Gemini plan is connected: this runs on a personal Google account or API key")
			case v == "byok":
				if a.usesCompanyAPI(tools) {
					continue // they appear on a connected API account: likely the company key
				}
				conf = confidenceLow
				ev = append(ev, "Open-source agent on a model API key that isn't on a connected company account")
			default:
				continue
			}
			risk := a.in.Prices.Personal[v]
			if risk > 0 {
				ev = append(ev, fmt.Sprintf("Likely a personal plan (from %s/month) paid or expensed outside the company plan", money(risk)))
			}
			label := cmpOr(VendorLabel[v], v)
			out = append(out, Leak{Type: ShadowSpend, Vendor: v, Person: person, AtRiskCents: risk, Confidence: conf,
				Title: fmt.Sprintf("%s used off the company plan", label), Evidence: ev})
		}
	}
	return out
}

func (a *analysis) usesCompanyAPI(tools map[string]*tool) bool {
	for _, v := range []string{Anthropic, OpenAI} {
		if t := tools[v]; t != nil && a.conn[v] && (t.hasUsageRows || t.seat != nil) {
			return true
		}
	}
	return false
}

func (a *analysis) runaway() []Leak {
	var out []Leak
	scale := 30.0 / float64(a.in.WindowDays)
	vendors := map[string]bool{}
	for _, tools := range a.people {
		for v, t := range tools {
			if t.cost > 0 {
				vendors[v] = true
			}
		}
	}
	for v := range a.orgDaily {
		vendors[v] = true
	}
	for _, v := range sortedKeys(vendors) {
		var costs []int64
		for _, tools := range a.people {
			if t := tools[v]; t != nil && t.cost > 0 {
				costs = append(costs, t.cost)
			}
		}
		med := median(costs)
		personSpike := false
		for _, person := range sortedKeys(a.people) {
			t := a.people[person][v]
			if t == nil || t.cost <= 0 {
				continue
			}
			var l *Leak
			if len(costs) >= MinPeersForMedian && med > 0 && float64(t.cost) > RunawayMedianX*float64(med) {
				excess := t.cost - int64(RunawayMedianX*float64(med))
				if excess >= RunawayMinCents {
					l = &Leak{Type: RunawayCost, Vendor: v, Person: person, Confidence: confidenceHigh,
						MonthlySavingsCents: int64(math.Round(float64(excess) * scale)),
						Title:               fmt.Sprintf("%s spend %.0f× the team median", VendorLabel[v], float64(t.cost)/float64(med)),
						Evidence: []string{
							fmt.Sprintf("%s in the last %d days; team median %s across %d people", money(t.cost), a.in.WindowDays, money(med), len(costs)),
							fmt.Sprintf("Savings = spend above %.0f× the median", RunawayMedianX),
						}}
				}
			}
			if day, cost, base, excess, ok := a.spike(t.dailyCost); ok {
				personSpike = true
				ev := fmt.Sprintf("Spike on %s: %s vs a %s/day average the week before%s", day.Format("2006-01-02"), money(cost), money(base), agentsNote(t))
				if l == nil {
					l = &Leak{Type: RunawayCost, Vendor: v, Person: person, Confidence: confidenceMedium, MonthlySavingsCents: excess,
						Title:    fmt.Sprintf("%s cost spike", VendorLabel[v]),
						Evidence: []string{ev, "Often an agent looping (e.g. in CI); savings = the spend above the usual daily level"}}
				} else {
					l.Evidence = append(l.Evidence, ev)
				}
			}
			if l != nil {
				out = append(out, *l)
			}
		}
		if org := a.orgDaily[v]; org != nil && !personSpike {
			if day, cost, base, excess, ok := a.spike(org); ok {
				out = append(out, Leak{Type: RunawayCost, Vendor: v, Person: organisationPerson, Name: "Whole organisation", Confidence: confidenceMedium,
					MonthlySavingsCents: excess, Title: fmt.Sprintf("%s organisation cost spike", VendorLabel[v]),
					Evidence: []string{fmt.Sprintf("Spike on %s: %s vs a %s/day average the week before", day.Format("2006-01-02"), money(cost), money(base)),
						"Not attributed to a person: check API keys used by CI and automations"}})
			}
		}
	}
	return out
}

// spike looks for the most recent day (of the last SpikeRecentDays) far
// above the trailing week's mean. excess sums every spiking recent day.
func (a *analysis) spike(daily map[time.Time]int64) (day time.Time, cost, base, excess int64, ok bool) {
	for back := 0; back < SpikeRecentDays; back++ {
		d := a.today.AddDate(0, 0, -back)
		var sum int64
		for i := 1; i <= SpikeLookbackDays; i++ {
			sum += daily[d.AddDate(0, 0, -i)]
		}
		mean := sum / SpikeLookbackDays
		c := daily[d]
		if float64(c) >= SpikeX*math.Max(float64(mean), 1) && c-mean >= SpikeMinCents {
			if !ok {
				day, cost, base, ok = d, c, mean, true
			}
			excess += c - mean
		}
	}
	return
}

func (a *analysis) peopleView() []PersonUsage {
	out := []PersonUsage{}
	for _, person := range sortedKeys(a.people) {
		p := PersonUsage{Person: person, Name: a.names[person], Matched: IsPerson(person), Via: a.via[person], Machines: sortedKeys(a.machines[person]), Tools: []ToolUse{}}
		for _, v := range sortedKeys(a.people[person]) {
			t := a.people[person][v]
			u := ToolUse{Vendor: v, Seat: t.seat != nil, SeatCents: t.seatCents, Agents: sortedKeys(t.agents),
				EffigentDays: len(t.effDays), VendorDays: len(t.vendorDays), CostCents: t.cost}
			if !t.lastSeen.IsZero() {
				ls := t.lastSeen
				u.LastSeen = &ls
			}
			if !t.lastVendor.IsZero() {
				lv := t.lastVendor
				u.LastVendorActivity = &lv
			}
			p.Tools = append(p.Tools, u)
		}
		out = append(out, p)
	}
	return out
}

func median(xs []int64) int64 {
	if len(xs) == 0 {
		return 0
	}
	s := append([]int64{}, xs...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	if len(s)%2 == 1 {
		return s[len(s)/2]
	}
	return (s[len(s)/2-1] + s[len(s)/2]) / 2
}

func money(cents int64) string {
	if cents%100 == 0 {
		return fmt.Sprintf("$%d", cents/100)
	}
	return fmt.Sprintf("$%.2f", float64(cents)/100)
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
