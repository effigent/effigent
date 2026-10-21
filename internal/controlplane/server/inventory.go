package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/inventory"
	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
	ep "github.com/effigent/effigent/internal/endpoint/policy"
)

// Inventory (Monitor → Inventory): every agent and MCP server seen per
// machine, from the rollups kept at ingest (migration 016), and the people
// who pay for an AI tool but have no managed machine (Pricing Leaks' seats
// and usage joined with the People mapping). Anomalies: first-seen
// behaviour signals (migration 017).

const (
	inventoryDays    = 30
	inventoryMaxDays = 365
	anomalyEvent     = "anomaly.first_seen"
	anomalyKeep      = 180 * 24 * time.Hour // signals older than this are pruned
)

func daysParam(r *http.Request, def, min, max int) (int, error) {
	v := r.URL.Query().Get("days")
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("days must be %d to %d", min, max)
	}
	return n, nil
}

type inventoryMachine struct {
	EndpointID string `json:"endpoint_id"`
	Hostname   string `json:"hostname"`
	Revoked    bool   `json:"revoked,omitempty"`
}

type mcpServerView struct {
	Server    string    `json:"server"`
	Orphan    bool      `json:"orphan"` // seen with no known agent above it (track_orphan_mcp)
	Agents    []string  `json:"agents"`
	Machines  int       `json:"machines"`
	People    []string  `json:"people"`
	Tools     []string  `json:"tools"`   // tool names used (hooks only; the kernel sees the server, not its tools)
	Sources   []string  `json:"sources"` // hook | kernel
	Events    int64     `json:"events"`
	Unlisted  int64     `json:"unlisted_calls"` // calls the hook flagged outside the machine's mcp_allow
	FirstSeen time.Time `json:"first_seen"`     // first ever on any machine (baseline), else first in the window
	LastSeen  time.Time `json:"last_seen"`
	// Allowlist: the published base policy's mcp_allow for these agents:
	// allowed | not_allowed | no_allowlist (the agent's rule has none) | mixed.
	Allowlist string          `json:"allowlist"`
	Uses      []mcpMachineUse `json:"uses"`
}

type mcpMachineUse struct {
	inventoryMachine
	Agent     string    `json:"agent"`
	Person    string    `json:"person"`
	OSUsers   []string  `json:"os_users"`
	Tools     []string  `json:"tools"`
	Events    int64     `json:"events"`
	Unlisted  int64     `json:"unlisted_calls"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
	Allowlist string    `json:"allowlist"`
}

type agentView struct {
	inventoryMachine
	Agent     string    `json:"agent"`
	Owner     string    `json:"owner"`
	Person    string    `json:"person"`
	OS        string    `json:"os"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
	Events    int64     `json:"events"`
	Mode      string    `json:"mode"`
	Status    string    `json:"status"` // inventory.Status*
	By        []string  `json:"enforced_by"`
	Note      string    `json:"note,omitempty"`
	HookState string    `json:"hook_state,omitempty"`
}

// mcpAllowCheck answers whether a server is allowed for an agent by the
// published base policy (not each machine's compiled one).
type mcpAllowCheck func(agent, server string) string

func (s *Server) mcpAllow(ctx context.Context, tenant string) mcpAllowCheck {
	body := ep.DefaultYAML
	if pv, err := s.Store.LatestPolicy(ctx, tenant); err == nil && pv.Body != "" {
		body = []byte(pv.Body)
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.Logf("inventory %s: policy: %v", tenant, err)
	}
	pol, err := ep.Parse(body)
	if err != nil {
		return func(string, string) string { return "" }
	}
	return func(agent, server string) string {
		allow := pol.RuleFor(agent).MCPAllow
		if len(allow) == 0 {
			return "no_allowlist"
		}
		for _, p := range allow {
			if wildMatch(p, server) {
				return "allowed"
			}
		}
		return "not_allowed"
	}
}

// wildMatch: * matches any run of characters, case-insensitively (as the
// hook's mcp_allow does).
func wildMatch(p, s string) bool {
	p, s = strings.ToLower(p), strings.ToLower(s)
	parts := strings.Split(p, "*")
	if len(parts) == 1 {
		return p == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	for _, part := range parts[1 : len(parts)-1] {
		i := strings.Index(s, part)
		if i < 0 {
			return false
		}
		s = s[i+len(part):]
	}
	return strings.HasSuffix(s, parts[len(parts)-1])
}

func addUnique(list []string, v string) []string {
	if v == "" {
		return list
	}
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

// hookStateOf reads one agent's hook from a machine's health report.
func hookStateOf(e store.Endpoint, agent string) inventory.HookState {
	r := parseHookReport(e.Hooks)
	if r == nil {
		return inventory.HookState{}
	}
	h := inventory.HookState{Reported: true, Sensor: r.Sensor}
	if a, ok := r.Agents[inventory.HookAgent[agent]]; ok && inventory.HookAgent[agent] != "" {
		h.State, h.Broken = a.State, a.broken()
		if a.State == "installed" && len(a.DisabledBy) > 0 {
			h.State = "switched off by " + strings.Join(a.DisabledBy, ", ")
		}
	}
	return h
}

func (s *Server) getInventory(w http.ResponseWriter, r *http.Request, p Principal) {
	days, err := daysParam(r, inventoryDays, 1, inventoryMaxDays)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	since := spend.Day(now).AddDate(0, 0, -(days - 1))
	eps, err := s.Store.ListEndpoints(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	byID := map[string]store.Endpoint{}
	for _, e := range eps {
		byID[e.ID] = e
	}
	seats, usage, err := s.Store.SpendData(ctx, p.Tenant, since)
	if err != nil {
		s.fail(w, err)
		return
	}
	machines, obs, err := s.Store.SpendObservations(ctx, p.Tenant, since)
	if err != nil {
		s.fail(w, err)
		return
	}
	people, err := s.Store.SpendPeople(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	dir := spend.NewDirectory(people)
	for _, m := range machines {
		dir.AddKnown(m.Owner)
	}
	osUsers := map[string][]string{}
	for _, m := range machines {
		osUsers[m.ID] = m.OSUsers
	}
	personOf := func(e store.Endpoint, osUser string) string {
		if osUser != "" {
			k, _ := dir.ObsPerson(spend.Observation{EndpointID: e.ID, Hostname: e.Hostname, Owner: e.Owner, OSUsers: osUsers[e.ID], OSUser: osUser})
			return k
		}
		return dir.EndpointPerson(e.Owner, e.Hostname, osUsers[e.ID])
	}
	machineOfID := func(id string) inventoryMachine {
		e := byID[id]
		return inventoryMachine{EndpointID: id, Hostname: cmpOr(e.Hostname, id), Revoked: e.Revoked}
	}

	// agents
	sightings, err := s.Store.AgentSightings(ctx, p.Tenant, since)
	if err != nil {
		s.fail(w, err)
		return
	}
	agents := []agentView{}
	for _, a := range sightings {
		if inventory.IsOrphanMCP(a.Agent) {
			continue
		}
		e := byID[a.EndpointID]
		h := hookStateOf(e, a.Agent)
		st, by, note := inventory.Coverage(a.Agent, a.Mode, e.OS, h, a.HookEvents, a.KernelEvents)
		if by == nil {
			by = []string{}
		}
		agents = append(agents, agentView{inventoryMachine: machineOfID(a.EndpointID), Agent: a.Agent, Owner: e.Owner,
			Person: personOf(e, ""), OS: e.OS, FirstSeen: a.FirstAt, LastSeen: a.LastAt, Events: a.Events, Mode: a.Mode,
			Status: st, By: by, Note: note, HookState: h.State})
	}

	// MCP servers
	uses, err := s.Store.MCPUses(ctx, p.Tenant, since)
	if err != nil {
		s.fail(w, err)
		return
	}
	allow := s.mcpAllow(ctx, p.Tenant)
	servers := map[string]*mcpServerView{}
	perUse := map[string]*mcpMachineUse{}
	var order []string
	for _, u := range uses {
		sv := servers[u.Server]
		if sv == nil {
			sv = &mcpServerView{Server: u.Server, Agents: []string{}, People: []string{}, Tools: []string{}, Sources: []string{}, Uses: []mcpMachineUse{}}
			servers[u.Server] = sv
			order = append(order, u.Server)
		}
		e := byID[u.EndpointID]
		orphan := inventory.IsOrphanMCP(u.Agent)
		sv.Orphan = sv.Orphan || orphan
		if !orphan {
			sv.Agents = addUnique(sv.Agents, u.Agent)
		}
		sv.Sources = addUnique(sv.Sources, u.Source)
		sv.Tools = addUnique(sv.Tools, u.Tool)
		sv.Events += u.Events
		sv.Unlisted += u.Unlisted
		first := u.FirstAt
		if u.EverFirstAt != nil && u.EverFirstAt.Before(first) {
			first = *u.EverFirstAt
		}
		if sv.FirstSeen.IsZero() || first.Before(sv.FirstSeen) {
			sv.FirstSeen = first
		}
		if u.LastAt.After(sv.LastSeen) {
			sv.LastSeen = u.LastAt
		}
		k := u.Server + "\x00" + u.EndpointID + "\x00" + u.Agent
		mu := perUse[k]
		if mu == nil {
			mu = &mcpMachineUse{inventoryMachine: machineOfID(u.EndpointID), Agent: u.Agent, OSUsers: []string{}, Tools: []string{}, FirstSeen: first, LastSeen: u.LastAt}
			if !orphan {
				mu.Allowlist = allow(u.Agent, u.Server)
			}
			perUse[k] = mu
		}
		for _, o := range u.OSUsers {
			mu.OSUsers = addUnique(mu.OSUsers, o)
		}
		mu.Tools = addUnique(mu.Tools, u.Tool)
		mu.Events += u.Events
		mu.Unlisted += u.Unlisted
		if first.Before(mu.FirstSeen) {
			mu.FirstSeen = first
		}
		if u.LastAt.After(mu.LastSeen) {
			mu.LastSeen = u.LastAt
		}
		osUser := ""
		if len(mu.OSUsers) == 1 {
			osUser = mu.OSUsers[0]
		}
		mu.Person = personOf(e, osUser)
	}
	for _, k := range sortedKeys(perUse) {
		mu := perUse[k]
		sv := servers[strings.SplitN(k, "\x00", 2)[0]]
		sv.Uses = append(sv.Uses, *mu)
	}
	mcp := []mcpServerView{}
	for _, name := range order {
		sv := servers[name]
		hosts := map[string]bool{}
		states := map[string]bool{}
		for _, u := range sv.Uses {
			hosts[u.EndpointID] = true
			sv.People = addUnique(sv.People, u.Person)
			if u.Allowlist != "" {
				states[u.Allowlist] = true
			}
		}
		sv.Machines = len(hosts)
		switch len(states) {
		case 0:
			sv.Allowlist = "no_allowlist" // only orphan servers: the defaults rule, no agent
			if a := allow("", sv.Server); a != "" {
				sv.Allowlist = a
			}
		case 1:
			for st := range states {
				sv.Allowlist = st
			}
		default:
			sv.Allowlist = "mixed"
		}
		sort.Strings(sv.Tools)
		sort.Strings(sv.People)
		mcp = append(mcp, *sv)
	}
	sort.SliceStable(mcp, func(i, j int) bool { return mcp[i].LastSeen.After(mcp[j].LastSeen) })

	unmanaged := inventory.Unmanaged(inventory.UnmanagedInput{Since: since, Seats: seats, Usage: usage, Machines: machines, Obs: obs, People: people})
	connected := map[string]bool{}
	for _, x := range seats {
		connected[x.Vendor] = true
	}
	for _, x := range usage {
		connected[x.Vendor] = true
	}
	vendors := []string{}
	for _, v := range spend.Vendors {
		if connected[v] {
			vendors = append(vendors, v)
		}
	}
	enrolled := 0
	for _, e := range eps {
		if !e.Revoked {
			enrolled++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"days": days, "since": since, "generated_at": now,
		"machines": enrolled, "agents": agents, "mcp_servers": mcp,
		"unmanaged_people": unmanaged, "spend_vendors": vendors,
		"hook_agents": inventory.HookAgent,
	})
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ---- anomalies ----

type anomalyView struct {
	store.Anomaly
	Hostname string `json:"hostname"`
	Owner    string `json:"owner"`
	Person   string `json:"person"`
}

func (s *Server) listAnomalies(w http.ResponseWriter, r *http.Request, p Principal) {
	qs := r.URL.Query()
	limit, _ := strconv.Atoi(qs.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := store.AnomalyQuery{Limit: limit, Before: qs.Get("before"), Agent: qs.Get("agent"), Endpoint: qs.Get("endpoint"), Q: clip(qs.Get("q"), 200)}
	for _, k := range strings.Split(qs.Get("kind"), ",") {
		if k = strings.TrimSpace(k); k != "" {
			q.Kinds = append(q.Kinds, k)
		}
	}
	if v := qs.Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "since must be RFC 3339")
			return
		}
		q.Since = t
	}
	ctx := r.Context()
	list, next, err := s.Store.QueryAnomalies(ctx, p.Tenant, q)
	if err != nil {
		if err.Error() == "bad cursor" {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		s.fail(w, err)
		return
	}
	eps, err := s.Store.ListEndpoints(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	people, err := s.Store.SpendPeople(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	dir := spend.NewDirectory(people)
	byID := map[string]store.Endpoint{}
	for _, e := range eps {
		byID[e.ID] = e
		dir.AddKnown(e.Owner)
	}
	out := make([]anomalyView, 0, len(list))
	for _, a := range list {
		e := byID[a.EndpointID]
		out = append(out, anomalyView{Anomaly: a, Hostname: cmpOr(e.Hostname, a.EndpointID), Owner: e.Owner, Person: dir.EndpointPerson(e.Owner, e.Hostname, nil)})
	}
	stats, err := s.Store.BaselineStats(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"anomalies": out, "next_before": next, "kinds": inventory.Kinds, "caps": inventory.Caps,
		"window_days": int(inventory.Window.Hours() / 24), "warmup_days": int(inventory.Warmup.Hours() / 24),
		"daily_signal_cap": inventory.DailySignalCap, "baselines": stats, "webhook_event": anomalyEvent,
	})
}

// announceAnomalies sends a batch's first-seen signals to the webhooks that
// opted in (capped per webhook like action.blocked).
func (s *Server) announceAnomalies(ctx context.Context, e store.Endpoint, list []store.Anomaly) {
	for _, a := range list {
		data := map[string]any{"anomaly": a, "endpoint_id": e.ID, "hostname": e.Hostname}
		if s.ConsoleOrigin != "" {
			data["review_url"] = s.ConsoleOrigin + "/anomalies?endpoint=" + url.QueryEscape(e.ID) + "&kind=" + url.QueryEscape(a.Kind)
		}
		s.emit(ctx, e.Tenant, anomalyEvent, data)
	}
}

// pruneAnomalies drops signals older than anomalyKeep (the baselines
// themselves stay).
func (s *Server) pruneAnomalies(ctx context.Context) {
	if n, err := s.Store.PruneAnomalies(ctx, anomalyKeep); err != nil {
		s.Logf("anomalies: prune: %v", err)
	} else if n > 0 {
		s.Logf("anomalies: pruned %d signals older than %d days", n, int(anomalyKeep.Hours()/24))
	}
}
