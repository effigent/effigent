package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// Who decides what. A workspace keeps approver groups (members of the
// workspace, by Clerk user id, with their email) and ordered routing rules.
// A new request goes to the first rule that matches it, else the default
// group, else — as before routing existed — any workspace admin. The group
// is fixed when the request is filed; who belongs to it is read when someone
// decides, so a new member can pick up an open request.

// routeKinds maps an approval list to the kind a rule names.
var routeKinds = map[string]string{
	"command_approve": "command", "exec_approve": "command",
	"domain_approve": "website", "network_approve": "website",
	"tool_approve": "tool", "file_approve": "file", "file_write_approve": "file",
	"actions_approve": "command", "package_approve": "command",
}

// patternRe compiles a rule pattern: case-insensitive, unanchored, * = anything.
func patternRe(p string) (*regexp.Regexp, error) {
	parts := strings.Split(strings.TrimSpace(p), "*")
	for i := range parts {
		parts[i] = regexp.QuoteMeta(parts[i])
	}
	return regexp.Compile("(?is)" + strings.Join(parts, ".*"))
}

// routeFor returns the rule and group a request goes to (nil, nil = workspace admins).
func routeFor(c store.RoutingConfig, a store.Approval) (*store.ApprovalRoute, *store.ApproverGroup) {
	text := a.Summary + "\n" + a.Reason
	for i := range c.Routes {
		r := &c.Routes[i]
		if len(r.Kinds) > 0 && !slices.Contains(r.Kinds, routeKinds[a.Rule]) {
			continue
		}
		if len(r.Machines) > 0 && !slices.ContainsFunc(r.Machines, func(m string) bool { return strings.EqualFold(m, a.Hostname) }) {
			continue
		}
		if len(r.Agents) > 0 && !slices.Contains(r.Agents, a.Agent) {
			continue
		}
		if len(r.Patterns) > 0 && !slices.ContainsFunc(r.Patterns, func(p string) bool {
			re, err := patternRe(p)
			return err == nil && re.MatchString(text)
		}) {
			continue
		}
		if g := c.Group(r.GroupID); g != nil {
			return r, g
		}
	}
	if g := c.Group(c.DefaultGroup); g != nil {
		return nil, g
	}
	return nil, nil
}

// memberOf finds a principal (Clerk user id) or an email in a group.
func memberOf(g *store.ApproverGroup, userID, email string) *store.GroupMember {
	if g == nil {
		return nil
	}
	for i := range g.Members {
		m := &g.Members[i]
		if (userID != "" && m.UserID == userID) || (email != "" && strings.EqualFold(m.Email, email)) {
			return m
		}
	}
	return nil
}

// canDecide applies the routing to a decision from the console or the API:
// the routed group's members decide; workspace admins may step in (an
// override, recorded as such); API keys need the approvals scope (and can
// only deny: voteRefusal refuses their approvals). Requests
// without a group are for workspace admins, as before routing.
func canDecide(p Principal, a store.Approval, c store.RoutingConfig) (ok, override bool, member *store.GroupMember) {
	if p.Via == "api-key" {
		return p.HasScope("approvals"), false, nil
	}
	g := c.Group(a.GroupID)
	if g == nil {
		return p.CanWrite(), false, nil
	}
	if m := memberOf(g, p.UserID, ""); m != nil {
		return true, false, m
	}
	if p.CanWrite() {
		return true, true, nil
	}
	return false, false, nil
}

func newRoutingID(prefix string) string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// cleanRouting validates a routing document and fills in missing ids.
func cleanRouting(c store.RoutingConfig) (store.RoutingConfig, error) {
	out := store.RoutingConfig{Groups: []store.ApproverGroup{}, Routes: []store.ApprovalRoute{}}
	if len(c.Groups) > 50 || len(c.Routes) > 200 {
		return out, fmt.Errorf("at most 50 groups and 200 rules")
	}
	ids := map[string]bool{}
	names := map[string]bool{}
	for _, g := range c.Groups {
		g.Name = strings.TrimSpace(g.Name)
		if g.Name == "" {
			return out, fmt.Errorf("every group needs a name")
		}
		if names[strings.ToLower(g.Name)] {
			return out, fmt.Errorf("two groups are called %q", g.Name)
		}
		names[strings.ToLower(g.Name)] = true
		if g.ID == "" {
			g.ID = newRoutingID("grp_")
		}
		if ids[g.ID] {
			return out, fmt.Errorf("duplicate group id %q", g.ID)
		}
		ids[g.ID] = true
		g.Name, g.Description = clip(g.Name, 80), clip(strings.TrimSpace(g.Description), 300)
		seen := map[string]bool{}
		members := []store.GroupMember{}
		for _, m := range g.Members {
			m.UserID, m.Email, m.Name = strings.TrimSpace(m.UserID), strings.TrimSpace(m.Email), clip(strings.TrimSpace(m.Name), 120)
			if m.UserID == "" || seen[m.UserID] {
				continue
			}
			if m.Email != "" && notify.ValidEmail(m.Email) != nil {
				m.Email = ""
			}
			seen[m.UserID] = true
			members = append(members, m)
		}
		if len(members) > 500 {
			return out, fmt.Errorf("group %q has more than 500 members", g.Name)
		}
		g.Members = members
		out.Groups = append(out.Groups, g)
	}
	for _, r := range c.Routes {
		if r.ID == "" {
			r.ID = newRoutingID("rte_")
		}
		r.Name = clip(strings.TrimSpace(r.Name), 120)
		if !ids[r.GroupID] {
			return out, fmt.Errorf("rule %q sends requests to a group that doesn't exist", r.Name)
		}
		r.Kinds, r.Patterns, r.Machines, r.Agents = clean(r.Kinds), clean(r.Patterns), clean(r.Machines), clean(r.Agents)
		for _, k := range r.Kinds {
			if !slices.Contains([]string{"command", "website", "tool", "file"}, k) {
				return out, fmt.Errorf("rule %q: unknown kind %q (command, website, tool, file)", r.Name, k)
			}
		}
		for _, p := range r.Patterns {
			if _, err := patternRe(p); err != nil || len(p) > 200 {
				return out, fmt.Errorf("rule %q: pattern %q is not valid", r.Name, p)
			}
		}
		rules, err := cleanRules(r.ApprovalRules, "rule "+strconv.Quote(r.Name))
		if err != nil {
			return out, err
		}
		r.ApprovalRules = rules
		out.Routes = append(out.Routes, r)
	}
	if c.DefaultGroup != "" && !ids[c.DefaultGroup] {
		return out, fmt.Errorf("the default group doesn't exist")
	}
	out.DefaultGroup = c.DefaultGroup
	rules, err := cleanRules(c.DefaultRules, "default")
	if err != nil {
		return out, err
	}
	out.DefaultRules = rules
	return out, nil
}

// cleanRules checks one rule's decision settings and writes the defaults
// out, so the saved document says what applies.
func cleanRules(r store.ApprovalRules, what string) (store.ApprovalRules, error) {
	if r.ApprovalsRequired < 0 || r.ApprovalsRequired > 2 {
		return r, fmt.Errorf("%s: approvals_required is 1 or 2", what)
	}
	ex := r.Excludes()
	return store.ApprovalRules{ApprovalsRequired: r.Required(), ExcludeRequester: &ex, RequireTicket: r.RequireTicket}, nil
}

// routingWarnings lists the rules whose group is too small for their
// quorum. The requester isn't known yet, so a group exactly the size of a
// two-person quorum is flagged too when the requester is excluded: if one
// of its members files the request, an admin has to give the second vote.
// Without a group (workspace admins decide) nothing is checked.
func routingWarnings(c store.RoutingConfig) []string {
	out := []string{}
	check := func(what string, g *store.ApproverGroup, rules store.ApprovalRules) {
		if g == nil {
			return
		}
		n, q := len(g.Members), rules.Required()
		switch {
		case n < q:
			out = append(out, fmt.Sprintf("%s: %s has %d member(s) and %d approvals are needed; a workspace admin will have to step in", what, g.Name, n, q))
		case n == q && q > 1 && rules.Excludes():
			out = append(out, fmt.Sprintf("%s: %s has exactly %d members; when one of them makes the request, a workspace admin will have to give the second approval", what, g.Name, n))
		}
	}
	for _, r := range c.Routes {
		check("rule "+strconv.Quote(cmpOr(r.Name, r.ID)), c.Group(r.GroupID), r.ApprovalRules)
	}
	check("default", c.Group(c.DefaultGroup), c.DefaultRules)
	return out
}

// routingView is the document as the console reads it: every rule's
// decision settings spelled out (saved configs from before they existed
// read as 1 approval, requester excluded) plus the quorum warnings.
type routingView struct {
	store.RoutingConfig
	Warnings []string `json:"warnings"`
}

func viewRouting(c store.RoutingConfig) routingView {
	for i := range c.Routes {
		c.Routes[i].ApprovalRules, _ = cleanRules(c.Routes[i].ApprovalRules, "")
	}
	c.DefaultRules, _ = cleanRules(c.DefaultRules, "")
	return routingView{RoutingConfig: c, Warnings: routingWarnings(c)}
}

func (s *Server) getRouting(w http.ResponseWriter, r *http.Request, p Principal) {
	c, err := s.Store.GetRouting(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewRouting(c))
}

func (s *Server) putRouting(w http.ResponseWriter, r *http.Request, p Principal) {
	var req store.RoutingConfig
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	c, err := cleanRouting(req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	before, _ := s.Store.GetRouting(r.Context(), p.Tenant)
	if err := s.Store.PutRouting(r.Context(), p.Tenant, p.UserID, c); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "approval_routing.update", "approvals", map[string]any{"before": routingSummary(before), "after": routingSummary(c)})
	c, _ = s.Store.GetRouting(r.Context(), p.Tenant)
	writeJSON(w, http.StatusOK, viewRouting(c))
}

// routingSummary is the audit view: groups with their members' emails, rules in order.
func routingSummary(c store.RoutingConfig) map[string]any {
	groups := map[string]any{}
	name := map[string]string{}
	for _, g := range c.Groups {
		var who []string
		for _, m := range g.Members {
			who = append(who, cmpOr(m.Email, m.UserID))
		}
		groups[g.Name] = who
		name[g.ID] = g.Name
	}
	var rules []string
	for _, r := range c.Routes {
		rules = append(rules, fmt.Sprintf("%s → %s (kinds %v, patterns %v, machines %v, agents %v; %s)", cmpOr(r.Name, "rule"), name[r.GroupID], r.Kinds, r.Patterns, r.Machines, r.Agents, rulesSummary(r.ApprovalRules)))
	}
	return map[string]any{"groups": groups, "rules": rules, "default": name[c.DefaultGroup], "default_rules": rulesSummary(c.DefaultRules)}
}

func rulesSummary(r store.ApprovalRules) string {
	s := fmt.Sprintf("%d approval(s)", r.Required())
	if r.Excludes() {
		s += ", requester excluded"
	} else {
		s += ", requester may approve"
	}
	if r.RequireTicket {
		s += ", ticket required"
	}
	return s
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// testRouting answers "who would decide this?" with the production rules.
func (s *Server) testRouting(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Summary  string               `json:"summary"`
		Reason   string               `json:"reason"`
		Rule     string               `json:"rule"`
		Hostname string               `json:"hostname"`
		Agent    string               `json:"agent"`
		Endpoint string               `json:"endpoint_id"` // optional; else the newest machine with that hostname
		OSUser   string               `json:"os_user"`     // optional, to resolve the requester like a real request
		Config   *store.RoutingConfig `json:"config"`      // unsaved edits; omitted = the saved rules
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	var c store.RoutingConfig
	var err error
	if req.Config != nil {
		if c, err = cleanRouting(*req.Config); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	} else if c, err = s.Store.GetRouting(r.Context(), p.Tenant); err != nil {
		s.fail(w, err)
		return
	}
	if req.Rule == "" {
		req.Rule = "command_approve"
	}
	a := store.Approval{Tenant: p.Tenant, EndpointID: req.Endpoint, Summary: req.Summary, Reason: req.Reason, Rule: req.Rule,
		Hostname: req.Hostname, Agent: req.Agent, OSUser: req.OSUser}
	if a.EndpointID == "" && a.Hostname != "" {
		if eps, err := s.Store.ListEndpoints(r.Context(), p.Tenant); err == nil {
			for _, e := range eps {
				if strings.EqualFold(e.Hostname, a.Hostname) && !e.Revoked {
					a.EndpointID = e.ID
					break
				}
			}
		}
	}
	route, group := routeFor(c, a)
	rules := rulesFor(c, route)
	q, err := s.resolveRequester(r.Context(), a)
	if err != nil {
		s.fail(w, err)
		return
	}
	warning := quorumWarning(group, q, rules)
	if rules.Excludes() && q.Unknown() {
		// voteRefusal would refuse every approval of such a request
		warning = "Effigent doesn't know who would be asking (" + requestedFrom(a) + "): with the requester kept out, every approval " +
			"would be refused. Set the machine's owner (Machines) or map its OS user in People"
	}
	out := map[string]any{"route_id": "", "route_name": "", "group_id": "", "group_name": "", "default": route == nil && group != nil,
		"approvals_required": rules.Required(), "exclude_requester": rules.Excludes(), "require_ticket": rules.RequireTicket,
		"requester": q, "eligible_approvers": eligible(group, q, rules.Excludes()), "warning": warning}
	if route != nil {
		out["route_id"], out["route_name"] = route.ID, route.Name
	}
	if group != nil {
		out["group_id"], out["group_name"] = group.ID, group.Name
		var excluded []string
		for _, m := range group.Members {
			if rules.Excludes() && q.Matches(m.UserID, []string{m.Email}) {
				excluded = append(excluded, cmpOr(m.Email, m.UserID))
			}
		}
		out["excluded_members"] = excluded
	}
	writeJSON(w, http.StatusOK, out)
}
