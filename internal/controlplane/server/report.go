package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/inventory"
	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// The posture report (Monitor → Posture report): a period's machines,
// agents in use, blocked actions, approvals, exceptions, policy changes,
// first-seen behaviour and Pricing Leaks, for readers who don't use the
// console every day. Everything comes from bounded tables and the ingest
// rollups (migrations 010, 016, 017), never a scan of cp.events. The same
// report goes out by email on a schedule (weekly / monthly).

var reportPeriods = []int{7, 30, 90}

// ReportSection lets another feature add a section to the report (e.g.
// break-glass sessions): it returns the section's data for the period, or
// nil to leave it out. Register with RegisterReportSection from an init().
type ReportSection struct {
	Key   string
	Build func(ctx context.Context, s *Server, tenant string, from, to time.Time) (any, error)
}

var reportSections []ReportSection

// RegisterReportSection adds a section to every posture report.
func RegisterReportSection(sec ReportSection) { reportSections = append(reportSections, sec) }

type postureReport struct {
	Days        int                  `json:"days"`
	From        time.Time            `json:"from"`
	To          time.Time            `json:"to"`
	GeneratedAt time.Time            `json:"generated_at"`
	Machines    reportMachines       `json:"machines"`
	Agents      reportAgents         `json:"agents"`
	Enforcement reportEnforcement    `json:"enforcement"`
	Approvals   store.ApprovalStats  `json:"approvals"`
	Exceptions  reportExceptions     `json:"exceptions"`
	Policy      store.PolicyActivity `json:"policy"`
	Anomalies   reportAnomalies      `json:"anomalies"`
	Spend       *reportSpend         `json:"spend"`
	// BreakGlass is filled by the registered "break_glass" section
	// (break_glass.go: store.BreakGlassActivity); null if it couldn't be built.
	BreakGlass any            `json:"break_glass"`
	Sections   map[string]any `json:"sections,omitempty"`
	Notes      []string       `json:"notes"`
}

type reportMachines struct {
	Enrolled        int            `json:"enrolled"`
	EnrolledInRange int            `json:"enrolled_in_period"`
	SeenInRange     int            `json:"seen_in_period"`
	OnlineNow       int            `json:"online_now"`
	OfflineNow      int            `json:"offline_now"`
	HooksReporting  int            `json:"hooks_reporting"`
	HooksHealthy    int            `json:"hooks_healthy"`
	HookProblems    []hookProblem  `json:"hook_problems"`
	ByOS            map[string]int `json:"by_os"`
}

type hookProblem struct {
	EndpointID string   `json:"endpoint_id"`
	Hostname   string   `json:"hostname"`
	Agents     []string `json:"agents"`
}

type reportAgentUse struct {
	Agent    string `json:"agent"`
	Machines int    `json:"machines"`
	People   int    `json:"people"`
	Events   int64  `json:"events"`
}

type reportGroup struct {
	Key      string   `json:"key"` // person key, or team name
	Name     string   `json:"name,omitempty"`
	Matched  bool     `json:"matched,omitempty"`
	Agents   []string `json:"agents"`
	Machines int      `json:"machines"`
	People   int      `json:"people,omitempty"`
	Events   int64    `json:"events"`
}

type reportAgents struct {
	InUse     []reportAgentUse `json:"in_use"`
	ByPerson  []reportGroup    `json:"by_person"`
	ByTeam    []reportGroup    `json:"by_team"`
	Unmanaged int              `json:"unmanaged_agents"` // machine+agent pairs not under policy (Cowork, detection only)
}

type reportKind struct {
	Kind       string `json:"kind"`
	Label      string `json:"label"`
	Blocked    int64  `json:"blocked"`
	WouldBlock int64  `json:"would_block"`
	Approvals  int64  `json:"approval_requests"`
}

type reportEnforcement struct {
	Blocked    int64                  `json:"blocked"`
	WouldBlock int64                  `json:"would_block"`
	FileAlerts int64                  `json:"file_alerts"`
	ByKind     []reportKind           `json:"by_kind"`
	ByAgent    map[string]int64       `json:"blocked_by_agent"`
	Daily      []store.EnforcementDay `json:"daily"`
}

type reportExceptions struct {
	Active         int `json:"active"`
	CreatedInRange int `json:"created_in_period"`
	ExpiringSoon   int `json:"expiring_7d"`
	Permanent      int `json:"permanent"`
}

type reportAnomalies struct {
	Total  int64            `json:"total"`
	ByKind map[string]int64 `json:"by_kind"`
}

type reportSpend struct {
	Connected       []string       `json:"connected"`
	MonthlyCents    int64          `json:"monthly_cents"`
	SavingsCents    int64          `json:"potential_savings_cents"`
	AtRiskCents     int64          `json:"at_risk_cents"`
	OpenLeaks       map[string]int `json:"open_leaks"`
	FoundInRange    int64          `json:"found_in_period"`
	ResolvedInRange int64          `json:"resolved_in_period"`
	ResolvedCents   int64          `json:"resolved_savings_cents"`
}

// enforcementKind maps a rule (and the action kind for the action lists)
// to a report category.
func enforcementKind(rule, detail string) (string, string) {
	switch {
	case strings.HasPrefix(rule, "actions_"):
		if detail != "" {
			return "action:" + detail, actionLabel(detail)
		}
		return "action", "Risky actions"
	case rule == "tool_deny" || rule == "tool_approve":
		return "tool", "Agent tools"
	case rule == "exec_deny" || rule == "exec_allow" || rule == "exec_approve" || strings.HasPrefix(rule, "command_"):
		return "command", "Commands and programs"
	case strings.HasPrefix(rule, "file_"):
		return "file", "Files"
	case strings.HasPrefix(rule, "network_") || strings.HasPrefix(rule, "domain_"):
		return "network", "Network and websites"
	case strings.HasPrefix(rule, "package_"):
		return "package", "Packages"
	case rule == "kernel_exec":
		return "kernel_exec", "Programs (kernel)"
	case rule == "kernel_file":
		return "kernel_file", "Files (kernel)"
	case rule == "kernel_connect":
		return "kernel_connect", "Network (kernel)"
	case rule == "":
		return "agent", "Agents started outside effigentd run"
	}
	return "other", "Other"
}

var actionLabels = map[string]string{
	"protected_push": "Push to a protected branch", "force_push": "Force push", "branch_delete": "Branch delete",
	"history_rewrite": "Git history rewrite", "hook_bypass": "Git hook bypass", "destructive_sql": "Destructive SQL",
	"sql_write": "SQL writes", "cloud_change": "Cloud changes", "cloud_destroy": "Cloud deletions", "access": "Access to an environment",
	"package_install": "Package installs", "package_unlisted": "Unlisted packages", "package_registry": "Other package registries",
	"package_scripts": "Package install scripts", "package_malicious": "Malicious packages", "package_vulnerable": "Vulnerable packages",
	"guardrail_edit": "Edits to guardrail files", "credential_read": "Credential reads", "remote_script": "Piped remote scripts",
	"fs_destroy": "Recursive deletes", "mcp_unlisted": "MCP servers outside the allowlist", "model_endpoint": "Unapproved model endpoints",
	"model_api_key": "Personal model API keys",
}

func actionLabel(k string) string { return cmpOr(actionLabels[k], strings.ReplaceAll(k, "_", " ")) }

func (s *Server) buildReport(ctx context.Context, tenant string, days int, now time.Time) (postureReport, error) {
	to := spend.Day(now).AddDate(0, 0, 1) // through today
	from := to.AddDate(0, 0, -days)
	rep := postureReport{Days: days, From: from, To: to, GeneratedAt: now, Notes: []string{}}

	eps, err := s.Store.ListEndpoints(ctx, tenant)
	if err != nil {
		return rep, err
	}
	health, err := s.Store.GetEndpointHealthSettings(ctx, tenant, s.offlineAfter())
	if err != nil {
		return rep, err
	}
	offlineAfter := time.Duration(health.OfflineAfterSeconds) * time.Second
	m := reportMachines{HookProblems: []hookProblem{}, ByOS: map[string]int{}}
	byID := map[string]store.Endpoint{}
	for _, e := range eps {
		byID[e.ID] = e
		if e.Revoked {
			continue
		}
		m.Enrolled++
		m.ByOS[cmpOr(e.OS, "unknown")]++
		if !e.EnrolledAt.Before(from) {
			m.EnrolledInRange++
		}
		if e.LastSeen != nil && !e.LastSeen.Before(from) {
			m.SeenInRange++
		}
		if e.OfflineAt == nil && e.LastSeen != nil && now.Sub(*e.LastSeen) <= offlineAfter {
			m.OnlineNow++
		} else {
			m.OfflineNow++
		}
		if hr := parseHookReport(e.Hooks); hr != nil {
			m.HooksReporting++
			if probs := hr.problems(); len(probs) == 0 {
				m.HooksHealthy++
			} else {
				hp := hookProblem{EndpointID: e.ID, Hostname: e.Hostname}
				for a := range probs {
					hp.Agents = append(hp.Agents, a)
				}
				sort.Strings(hp.Agents)
				m.HookProblems = append(m.HookProblems, hp)
			}
		}
	}
	sort.Slice(m.HookProblems, func(i, j int) bool { return m.HookProblems[i].Hostname < m.HookProblems[j].Hostname })
	rep.Machines = m

	// agents in use, by person and team (the daily activity rollup)
	_, obs, err := s.Store.SpendObservations(ctx, tenant, from)
	if err != nil {
		return rep, err
	}
	people, err := s.Store.SpendPeople(ctx, tenant)
	if err != nil {
		return rep, err
	}
	dir := spend.NewDirectory(people)
	for _, e := range eps {
		dir.AddKnown(e.Owner)
	}
	type acc struct {
		agents, machines, people map[string]bool
		events                   int64
	}
	newAcc := func() *acc {
		return &acc{agents: map[string]bool{}, machines: map[string]bool{}, people: map[string]bool{}}
	}
	byAgent, byPerson, byTeam := map[string]*acc{}, map[string]*acc{}, map[string]*acc{}
	add := func(mp map[string]*acc, k, agent, machine, person string, n int64) {
		a := mp[k]
		if a == nil {
			a = newAcc()
			mp[k] = a
		}
		a.agents[agent], a.machines[machine], a.people[person] = true, true, true
		a.events += n
	}
	for _, o := range obs {
		if o.Day.Before(from) || o.Day.After(to) || inventory.IsOrphanMCP(o.Agent) {
			continue
		}
		person, _ := dir.ObsPerson(o)
		add(byAgent, o.Agent, o.Agent, o.EndpointID, person, o.Events)
		add(byPerson, person, o.Agent, o.EndpointID, person, o.Events)
		teams := byID[o.EndpointID].Teams
		if len(teams) == 0 {
			teams = []string{""}
		}
		for _, t := range teams {
			add(byTeam, t, o.Agent, o.EndpointID, person, o.Events)
		}
	}
	keys := func(m map[string]bool) []string {
		out := []string{}
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	for k, a := range byAgent {
		rep.Agents.InUse = append(rep.Agents.InUse, reportAgentUse{Agent: k, Machines: len(a.machines), People: len(a.people), Events: a.events})
	}
	sort.Slice(rep.Agents.InUse, func(i, j int) bool { return rep.Agents.InUse[i].Events > rep.Agents.InUse[j].Events })
	for k, a := range byPerson {
		rep.Agents.ByPerson = append(rep.Agents.ByPerson, reportGroup{Key: k, Name: dir.Name(k), Matched: spend.IsPerson(k), Agents: keys(a.agents), Machines: len(a.machines), Events: a.events})
	}
	sort.Slice(rep.Agents.ByPerson, func(i, j int) bool { return rep.Agents.ByPerson[i].Events > rep.Agents.ByPerson[j].Events })
	for k, a := range byTeam {
		rep.Agents.ByTeam = append(rep.Agents.ByTeam, reportGroup{Key: k, Agents: keys(a.agents), Machines: len(a.machines), People: len(a.people), Events: a.events})
	}
	sort.Slice(rep.Agents.ByTeam, func(i, j int) bool { return rep.Agents.ByTeam[i].Events > rep.Agents.ByTeam[j].Events })
	if rep.Agents.InUse == nil {
		rep.Agents.InUse = []reportAgentUse{}
	}
	if rep.Agents.ByPerson == nil {
		rep.Agents.ByPerson = []reportGroup{}
	}
	if rep.Agents.ByTeam == nil {
		rep.Agents.ByTeam = []reportGroup{}
	}
	sightings, err := s.Store.AgentSightings(ctx, tenant, from)
	if err != nil {
		return rep, err
	}
	for _, a := range sightings {
		if inventory.IsOrphanMCP(a.Agent) {
			continue
		}
		e := byID[a.EndpointID]
		if st, _, _ := inventory.Coverage(a.Agent, a.Mode, e.OS, hookStateOf(e, a.Agent), a.HookEvents, a.KernelEvents); st != inventory.StatusEnforced {
			rep.Agents.Unmanaged++
		}
	}

	// enforcement
	counts, err := s.Store.EnforcementCounts(ctx, tenant, from, to)
	if err != nil {
		return rep, err
	}
	en := reportEnforcement{ByKind: []reportKind{}, ByAgent: map[string]int64{}}
	kinds := map[string]*reportKind{}
	for _, c := range counts {
		k, label := enforcementKind(c.Rule, c.Detail)
		if c.Type == "file_open" {
			en.FileAlerts += c.Events
			continue
		}
		rk := kinds[k]
		if rk == nil {
			rk = &reportKind{Kind: k, Label: label}
			kinds[k] = rk
		}
		switch c.Type {
		case "blocked", "approval_denied":
			if c.Type == "blocked" {
				en.Blocked += c.Events
				rk.Blocked += c.Events
				en.ByAgent[c.Agent] += c.Events
			}
		case "would_block":
			en.WouldBlock += c.Events
			rk.WouldBlock += c.Events
		case "approval_pending":
			rk.Approvals += c.Events
		}
	}
	for _, rk := range kinds {
		if rk.Blocked+rk.WouldBlock+rk.Approvals > 0 {
			en.ByKind = append(en.ByKind, *rk)
		}
	}
	sort.Slice(en.ByKind, func(i, j int) bool {
		a, b := en.ByKind[i], en.ByKind[j]
		if a.Blocked != b.Blocked {
			return a.Blocked > b.Blocked
		}
		return a.WouldBlock > b.WouldBlock
	})
	if en.Daily, err = s.Store.EnforcementDays(ctx, tenant, from, to); err != nil {
		return rep, err
	}
	rep.Enforcement = en

	if rep.Approvals, err = s.Store.ApprovalStats(ctx, tenant, from, to); err != nil {
		return rep, err
	}
	// exceptions live in the latest version's source
	if _, src, err := s.latestSource(ctx, tenant); err != nil && !errors.Is(err, store.ErrNotFound) {
		return rep, err
	} else {
		for _, x := range src.Exceptions {
			if x.Live(now) {
				rep.Exceptions.Active++
				if x.ExpiresAt == nil {
					rep.Exceptions.Permanent++
				} else if x.ExpiresAt.Sub(now) <= 7*24*time.Hour {
					rep.Exceptions.ExpiringSoon++
				}
			}
			if !x.CreatedAt.Before(from) {
				rep.Exceptions.CreatedInRange++
			}
		}
	}
	if rep.Policy, err = s.Store.PolicyActivity(ctx, tenant, from, to); err != nil {
		return rep, err
	}
	an, err := s.Store.AnomalyCounts(ctx, tenant, from, to)
	if err != nil {
		return rep, err
	}
	rep.Anomalies = reportAnomalies{ByKind: an}
	for _, n := range an {
		rep.Anomalies.Total += n
	}

	// Pricing Leaks, as its page computes it now, plus what changed in the period
	sr, conns, _, err := s.spendReport(ctx, tenant, now)
	if err != nil {
		return rep, err
	}
	connected := []string{}
	for _, c := range conns {
		if c.Configured || c.CSVSeats > 0 {
			connected = append(connected, c.Vendor)
		}
	}
	if len(sr.Vendors) > 0 || len(connected) > 0 {
		sp := &reportSpend{Connected: connected, MonthlyCents: sr.TotalMonthlyCents, SavingsCents: sr.TotalSavingsCents,
			AtRiskCents: sr.TotalAtRiskCents, OpenLeaks: map[string]int{}}
		for _, l := range sr.Leaks {
			sp.OpenLeaks[l.Type]++
		}
		if sp.FoundInRange, sp.ResolvedInRange, sp.ResolvedCents, err = s.Store.SpendLeakChanges(ctx, tenant, from, to); err != nil {
			return rep, err
		}
		rep.Spend = sp
	}

	for _, sec := range reportSections {
		v, err := sec.Build(ctx, s, tenant, from, to)
		if err != nil {
			s.Logf("report %s: section %s: %v", tenant, sec.Key, err)
			rep.Notes = append(rep.Notes, "The "+sec.Key+" section couldn't be built.")
			continue
		}
		if v == nil {
			continue
		}
		if sec.Key == "break_glass" {
			rep.BreakGlass = v
			continue
		}
		if rep.Sections == nil {
			rep.Sections = map[string]any{}
		}
		rep.Sections[sec.Key] = v
	}
	if first, err := s.Store.FirstRollupDay(ctx, tenant); err == nil && first != nil && first.After(from) {
		rep.Notes = append(rep.Notes, "Blocked actions are counted from "+first.Format("Jan 2, 2006")+", when this control plane started keeping them per day.")
	}
	return rep, nil
}

func (s *Server) getReport(w http.ResponseWriter, r *http.Request, p Principal) {
	days, err := daysParam(r, 30, 1, 90)
	if err != nil || !containsInt(reportPeriods, days) {
		writeErr(w, http.StatusBadRequest, "days must be 7, 30 or 90")
		return
	}
	rep, err := s.buildReport(r.Context(), p.Tenant, days, time.Now().UTC())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func containsInt(list []int, v int) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ---- scheduled email ----

func cadenceDays(c string) int {
	if c == "monthly" {
		return 30
	}
	return 7
}

func (s *Server) reportScheduleView(ctx context.Context, tenant string) (map[string]any, error) {
	sc, err := s.Store.GetReportSchedule(ctx, tenant)
	if err != nil {
		return nil, err
	}
	n, err := s.Store.GetNotificationSettings(ctx, tenant)
	if err != nil {
		return nil, err
	}
	return map[string]any{"schedule": sc, "default_emails": n.Emails, "email_available": s.Notify != nil && s.Notify.EmailEnabled()}, nil
}

func (s *Server) getReportSchedule(w http.ResponseWriter, r *http.Request, p Principal) {
	v, err := s.reportScheduleView(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func cleanEmails(in []string) ([]string, error) {
	out := []string{}
	if len(in) > 20 {
		return nil, errors.New("at most 20 recipients")
	}
	for _, e := range in {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			continue
		}
		a, err := mail.ParseAddress(e)
		if err != nil || a.Address != e || len(e) > 254 {
			return nil, fmt.Errorf("%q is not an email address", e)
		}
		out = addUnique(out, e)
	}
	return out, nil
}

func (s *Server) putReportSchedule(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Enabled bool     `json:"enabled"`
		Cadence string   `json:"cadence"`
		Emails  []string `json:"emails"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "body must be {enabled, cadence, emails}")
		return
	}
	if req.Cadence == "" {
		req.Cadence = "weekly"
	}
	if req.Cadence != "weekly" && req.Cadence != "monthly" {
		writeErr(w, http.StatusBadRequest, "cadence must be weekly or monthly")
		return
	}
	emails, err := cleanEmails(req.Emails)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()
	before, err := s.Store.GetReportSchedule(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	after, err := s.Store.PutReportSchedule(ctx, p.Tenant, store.ReportSchedule{Enabled: req.Enabled, Cadence: req.Cadence, Emails: emails}, p.UserID)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "report.schedule.update", "", map[string]any{
		"before": map[string]any{"enabled": before.Enabled, "cadence": before.Cadence, "emails": before.Emails},
		"after":  map[string]any{"enabled": after.Enabled, "cadence": after.Cadence, "emails": after.Emails, "next_at": after.NextAt},
	})
	v, err := s.reportScheduleView(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// sendReportNow emails the report to the schedule's recipients (or the
// notification emails) at once: a test of the schedule.
func (s *Server) sendReportNow(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Days int `json:"days"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req)
	if req.Days == 0 {
		req.Days = 7
	}
	if !containsInt(reportPeriods, req.Days) {
		writeErr(w, http.StatusBadRequest, "days must be 7, 30 or 90")
		return
	}
	sc, err := s.Store.GetReportSchedule(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	res := s.mailReport(r.Context(), p.Tenant, req.Days, sc.Emails)
	s.audit(r, p, "report.send", "", map[string]any{"days": req.Days, "channels": res})
	writeJSON(w, http.StatusOK, map[string]any{"result": res})
}

func (s *Server) runReportSchedules(ctx context.Context) {
	tick := time.NewTicker(spendPollTick)
	defer tick.Stop()
	last := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		due, err := s.Store.ClaimDueReports(ctx, 20)
		if err != nil && ctx.Err() == nil {
			s.Logf("report schedules: %v", err)
		}
		for _, d := range due {
			res := s.mailReport(ctx, d.Tenant, cadenceDays(d.Cadence), d.Emails)
			if err := s.Store.SetReportResult(ctx, d.Tenant, res); err != nil {
				s.Logf("report schedules %s: %v", d.Tenant, err)
			}
			s.auditSystem(ctx, d.Tenant, "report.email", d.Cadence, map[string]any{"days": cadenceDays(d.Cadence), "channels": res})
		}
		if time.Since(last) > time.Hour {
			last = time.Now()
			s.pruneAnomalies(ctx)
		}
	}
}

// mailReport builds the report and emails it, one message per recipient;
// it says where it went.
func (s *Server) mailReport(ctx context.Context, tenant string, days int, emails []string) map[string]string {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	res := map[string]string{}
	rep, err := s.buildReport(ctx, tenant, days, time.Now().UTC())
	if err != nil {
		s.Logf("report %s: %v", tenant, err)
		res["email"] = "error: the report couldn't be built"
		return res
	}
	if len(emails) == 0 {
		n, err := s.Store.GetNotificationSettings(ctx, tenant)
		if err != nil {
			s.Logf("report %s: notification settings: %v", tenant, err)
		}
		emails = n.Emails
	}
	switch {
	case len(emails) == 0:
		res["email"] = "no recipients"
	case s.Notify == nil || !s.Notify.EmailEnabled():
		res["email"] = "off: this control plane doesn't send email"
	default:
		m := reportMessage(rep, s.ConsoleOrigin)
		var failed []string
		for _, rcpt := range emails {
			if err := s.Notify.Email(ctx, []string{rcpt}, m); err != nil {
				failed = append(failed, rcpt+": "+err.Error())
			}
		}
		res["email"] = fmt.Sprintf("sent to %d", len(emails)-len(failed))
		if len(failed) > 0 {
			res["email"] = "error: " + clip(strings.Join(failed, "; "), 500)
		}
	}
	return res
}

func plural(n int64, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// reportMessage is the email: the headline numbers, and a link to the page.
func reportMessage(rep postureReport, origin string) notify.Message {
	last := rep.To.AddDate(0, 0, -1)
	period := rep.From.Format("Jan 2") + " – " + last.Format("Jan 2, 2006")
	m := rep.Machines
	agents := []string{}
	for i, a := range rep.Agents.InUse {
		if i == 5 {
			break
		}
		agents = append(agents, fmt.Sprintf("%s (%s, %s)", a.Agent, plural(int64(a.People), "person", "people"), plural(int64(a.Machines), "machine", "machines")))
	}
	if len(agents) == 0 {
		agents = []string{"none seen"}
	}
	kinds := []string{}
	for i, k := range rep.Enforcement.ByKind {
		if i == 4 {
			break
		}
		if k.Blocked > 0 {
			kinds = append(kinds, fmt.Sprintf("%s: %d", k.Label, k.Blocked))
		}
	}
	blocked := plural(rep.Enforcement.Blocked, "action blocked", "actions blocked")
	if len(kinds) > 0 {
		blocked += " (" + strings.Join(kinds, ", ") + ")"
	}
	if rep.Enforcement.WouldBlock > 0 {
		blocked += fmt.Sprintf("; %d more would have been blocked in monitor mode", rep.Enforcement.WouldBlock)
	}
	ap := rep.Approvals
	approvals := fmt.Sprintf("%d requested: %d approved, %d denied, %d expired", ap.Requested, ap.Approved, ap.Denied, ap.Expired)
	if ap.MedianDecideSeconds != nil {
		approvals += "; median time to decide " + humanSeconds(*ap.MedianDecideSeconds)
	}
	if ap.SelfApprovalRefused > 0 {
		approvals += fmt.Sprintf("; %d self-approvals refused", ap.SelfApprovalRefused)
	}
	machines := fmt.Sprintf("%d enrolled (%d new), %d online now, %d seen in the period", m.Enrolled, m.EnrolledInRange, m.OnlineNow, m.SeenInRange)
	if m.HooksReporting > 0 {
		machines += fmt.Sprintf("; agent hooks healthy on %d of %d", m.HooksHealthy, m.HooksReporting)
	}
	proposals := int64(0)
	for _, n := range rep.Policy.Proposals {
		proposals += n
	}
	fields := [][2]string{
		{"Period", period},
		{"Machines", machines},
		{"Agents in use", strings.Join(agents, "\n")},
		{"Blocked", blocked},
		{"Approvals", approvals},
		{"Exceptions", fmt.Sprintf("%d active (%d created in the period, %d expiring within 7 days)", rep.Exceptions.Active, rep.Exceptions.CreatedInRange, rep.Exceptions.ExpiringSoon)},
		{"Policy changes", fmt.Sprintf("%s, %s", plural(rep.Policy.Versions, "version published", "versions published"), plural(proposals, "change proposed", "changes proposed"))},
		{"New behaviour", plural(rep.Anomalies.Total, "first-seen signal", "first-seen signals") + " (new programs, hosts, MCP servers or action kinds for an agent on a machine)"},
	}
	if rep.Spend != nil {
		fields = append(fields, [2]string{"AI tool spend", fmt.Sprintf("%s a month; %s a month in potential savings", usd(rep.Spend.MonthlyCents), usd(rep.Spend.SavingsCents))})
	}
	link := ""
	if origin != "" {
		link = fmt.Sprintf("%s/report?days=%d", origin, rep.Days)
	}
	return notify.Message{
		Title:  fmt.Sprintf("Effigent posture report: the last %d days", rep.Days),
		Fields: fields,
		Link:   link,
		Footer: "Effigent sends this report on the schedule set on the Posture report page. Open the link for the full report (print it to PDF from the browser).",
	}
}

func humanSeconds(sec float64) string {
	d := time.Duration(sec * float64(time.Second))
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes()))
	default:
		return fmt.Sprintf("%.1f h", d.Hours())
	}
}
