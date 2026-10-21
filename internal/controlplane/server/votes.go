package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// Who may approve, and how many. A request records, when it is filed, the
// rules of the route it matched (approvals_required, exclude_requester,
// require_ticket) and who asked: the machine's owner and the people its OS
// user, hostname or git emails are mapped to. Every decision — console, API,
// email link, Slack — is a vote through castVote: the requester can't
// approve their own request (admins included), a two-approver request needs
// two different people (an admin stepping in is one of them, never both),
// and any deny denies.

// approver is who is deciding, as far as the control plane can tell.
type approver struct {
	Voter  string   // the vote's key: console user id, link:email:<addr>, slack:<team>:<user>, apikey:<id>, admin
	UserID string   // console user id, when known
	Emails []string // lower case, verified (Clerk, the group's records, the signed link, Slack's profile)
	Name   string
	Via    string // console | api-key | admin-token | email | slack
	// Person: a person, not an API key or the admin token. Only people count
	// toward a two-person approval, and only people can be told apart from
	// the requester.
	Person bool
}

// Vote refusals (also the audit and API codes).
const (
	refuseSelf      = "self_approval_refused"
	refuseNotPerson = "not_a_person"
	refuseTicket    = "ticket_required"
	refuseVoted     = "already_voted"
)

// voteRefusal says why who can't cast this vote on a ("" = they can). The
// routing check (canDecide: group member, admin, API key scope) comes first.
func voteRefusal(a store.Approval, requester store.Requester, who approver, approve bool, ticket string) (code, msg string) {
	v := store.Vote{Voter: who.Voter, UserID: who.UserID, Emails: who.Emails}
	for _, o := range a.Votes {
		if o.SamePerson(v) {
			return refuseVoted, "you already " + map[string]string{"approve": "approved", "deny": "denied"}[o.Decision] + " this request; it needs another approver"
		}
	}
	if !approve {
		return "", "" // whoever may decide may deny, the requester too
	}
	switch {
	case a.ExcludeRequester && who.Person && requester.Matches(who.UserID, who.Emails):
		return refuseSelf, "you are the requester (" + cmpOr(requester.Label, "this machine's user") + "): someone else must approve it"
	case a.ApprovalsRequired > 1 && !who.Person:
		return refuseNotPerson, fmt.Sprintf("this request needs %d different people to approve; an API key or the admin token can't be one of them", a.ApprovalsRequired)
	case a.RequireTicket && ticket == "":
		return refuseTicket, "approving this request needs a ticket reference (e.g. SEC-123 or a link)"
	}
	return "", ""
}

// requesterOf resolves who asked for a request: the machine's owner (an
// email, or a console user id), the people its OS user ("dana" or
// "dana@host"), hostname or git emails are mapped to, and every email those
// people go by. The git emails effigentd saw are the requester's too. Values
// are matched lower case.
func requesterOf(owner, hostname, osUser string, gitEmails []string, people []store.PersonRow) store.Requester {
	q := store.Requester{UserIDs: []string{}, Emails: []string{}}
	add := func(e string) {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" && !slices.Contains(q.Emails, e) {
			q.Emails = append(q.Emails, e)
		}
	}
	owner = strings.TrimSpace(owner)
	known := []string{}
	if strings.Contains(owner, "@") {
		known = append(known, strings.ToLower(owner))
	} else if owner != "" {
		q.UserIDs = append(q.UserIDs, owner)
	}
	for _, g := range gitEmails {
		known = append(known, strings.ToLower(g))
	}
	u, h := strings.ToLower(strings.TrimSpace(osUser)), strings.ToLower(strings.TrimSpace(hostname))
	var persons []string
	for _, p := range people {
		hit := slices.Contains(known, strings.ToLower(p.Email))
		for _, x := range p.Identities {
			switch x.Kind {
			case spend.KindOSUser:
				hit = hit || (u != "" && (x.Value == u || x.Value == u+"@"+h))
			case spend.KindHost:
				hit = hit || (h != "" && x.Value == h)
			case spend.KindEmail, spend.KindGitEmail:
				hit = hit || slices.Contains(known, x.Value)
			}
		}
		if !hit {
			continue
		}
		persons = append(persons, p.Email)
		add(p.Email)
		for _, x := range p.Identities {
			if x.Kind == spend.KindEmail || x.Kind == spend.KindGitEmail {
				add(x.Value)
			}
		}
	}
	for _, e := range known {
		add(e)
	}
	switch {
	case len(persons) > 0:
		q.Label = strings.Join(persons, ", ")
	case owner != "":
		q.Label = owner
	case u != "":
		q.Label = u + " on " + hostname
	}
	return q
}

// resolveRequester reads what requesterOf needs for a request.
func (s *Server) resolveRequester(ctx context.Context, a store.Approval) (store.Requester, error) {
	owner := ""
	if a.EndpointID != "" {
		if e, err := s.Store.GetEndpoint(ctx, a.Tenant, a.EndpointID); err == nil {
			owner = e.Owner
		} else if !errors.Is(err, store.ErrNotFound) {
			return store.Requester{}, err
		}
	}
	people, err := s.Store.ListPeople(ctx, a.Tenant)
	if err != nil {
		return store.Requester{}, err
	}
	var git []string
	if a.EndpointID != "" {
		if git, err = s.Store.GitEmailsSeen(ctx, a.Tenant, a.EndpointID, a.OSUser, time.Now().AddDate(0, 0, -30)); err != nil {
			return store.Requester{}, err
		}
	}
	return requesterOf(owner, a.Hostname, a.OSUser, git, people), nil
}

// rulesFor is how requests on a route (nil = the default) are decided.
func rulesFor(c store.RoutingConfig, route *store.ApprovalRoute) store.ApprovalRules {
	if route != nil {
		return route.ApprovalRules
	}
	return c.DefaultRules
}

// eligible counts the group's members who may approve a request (not the
// requester). -1: no group (workspace admins; the control plane can't list them).
func eligible(g *store.ApproverGroup, q store.Requester, exclude bool) int {
	if g == nil {
		return -1
	}
	n := 0
	for _, m := range g.Members {
		if !exclude || !q.Matches(m.UserID, []string{m.Email}) {
			n++
		}
	}
	return n
}

// quorumWarning explains when a group can't reach the quorum on its own.
func quorumWarning(g *store.ApproverGroup, q store.Requester, rules store.ApprovalRules) string {
	n := eligible(g, q, rules.Excludes())
	if n < 0 || n >= rules.Required() {
		return ""
	}
	why := ""
	if rules.Excludes() && n < len(g.Members) {
		why = " (the requester is excluded)"
	}
	return fmt.Sprintf("%s has %d member(s) who may approve this%s and %d approvals are needed: a workspace admin will have to step in", g.Name, n, why, rules.Required())
}

// emailsOf lists the emails the routing knows for a console user (any group).
func emailsOf(c store.RoutingConfig, userID string) []string {
	var out []string
	for _, g := range c.Groups {
		for _, m := range g.Members {
			if m.UserID == userID && m.Email != "" && !slices.Contains(out, strings.ToLower(m.Email)) {
				out = append(out, strings.ToLower(m.Email))
			}
		}
	}
	return out
}

// userIDOf finds the console user the routing knows by an email.
func userIDOf(c store.RoutingConfig, email string) string {
	for _, g := range c.Groups {
		if m := memberOf(&g, "", email); m != nil {
			return m.UserID
		}
	}
	return ""
}

// userEmails is implemented by directories that can list a console user's
// verified emails (ClerkDirectory).
type userEmails interface {
	UserEmails(ctx context.Context, tenant, userID string) ([]string, error)
}

// consoleApprover is who a console or API caller is.
func (s *Server) consoleApprover(ctx context.Context, p Principal, c store.RoutingConfig, name string) approver {
	switch p.Via {
	case "api-key":
		return approver{Voter: p.UserID, Name: name, Via: "api-key"}
	case "admin-token":
		return approver{Voter: p.UserID, Name: name, Via: "admin-token"}
	}
	who := approver{Voter: p.UserID, UserID: p.UserID, Emails: emailsOf(c, p.UserID), Name: name, Via: "console", Person: true}
	if d, ok := s.Directory.(userEmails); ok && s.Directory != nil {
		if es, err := d.UserEmails(ctx, p.Tenant, p.UserID); err != nil {
			s.Logf("directory %s: %v", p.Tenant, err)
		} else {
			for _, e := range es {
				if !slices.Contains(who.Emails, e) {
					who.Emails = append(who.Emails, e)
				}
			}
		}
	}
	return who
}

// ---- tickets ----

var jiraKey = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,19}-[0-9]{1,9}$`)

// cleanTicket accepts a Jira-style key (SEC-123) or an http(s) link.
func cleanTicket(t string) (string, error) {
	t = strings.TrimSpace(t)
	if t == "" {
		return "", nil
	}
	if k := strings.ToUpper(t); jiraKey.MatchString(k) {
		return k, nil
	}
	if u, err := url.Parse(t); err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && len(t) <= 500 {
		return t, nil
	}
	return "", fmt.Errorf("a ticket is a key like SEC-123 or an https:// link")
}

// cleanTicketTemplate checks a tenant's ticket link template.
func cleanTicketTemplate(t string) (string, error) {
	t = strings.TrimSpace(t)
	if t == "" {
		return "", nil
	}
	u, err := url.Parse(strings.ReplaceAll(t, "{key}", "KEY-1"))
	if err != nil || u.Scheme != "https" || u.Host == "" || !strings.Contains(t, "{key}") || len(t) > 300 {
		return "", fmt.Errorf(`the ticket link must be an https:// URL with {key} in it, e.g. https://acme.atlassian.net/browse/{key}`)
	}
	return t, nil
}

// ticketURL is the link for a ticket: itself when it is a link, the template
// with the key filled in when it is a key, else "".
func ticketURL(template, ticket string) string {
	switch {
	case ticket == "":
		return ""
	case strings.Contains(ticket, "://"):
		return ticket
	case template != "":
		return strings.ReplaceAll(template, "{key}", url.PathEscape(ticket))
	}
	return ""
}

// ticketLinks fills in the votes' ticket links from the tenant's template.
func (s *Server) ticketLinks(ctx context.Context, tenant string, as []store.Approval) {
	var tmpl *string
	for i := range as {
		for j := range as[i].Votes {
			v := &as[i].Votes[j]
			if v.Ticket == "" {
				continue
			}
			if tmpl == nil { // read once, and only when some vote has a ticket
				n, _ := s.Store.GetNotificationSettings(ctx, tenant)
				tmpl = &n.TicketURLTemplate
			}
			v.TicketURL = ticketURL(*tmpl, v.Ticket)
		}
	}
}

// ---- casting a vote ----

// voteResult is what castVote did. Code is an HTTP status for a refusal
// (Refusal says which); A is the request after the vote.
type voteResult struct {
	A       store.Approval
	Final   bool
	Code    int
	Refusal string
	Msg     string
}

// castVote is every decision's path: it applies the request's rules, records
// the vote, audits it as p and announces the result. who must already have
// passed the routing check (canDecide, or a link's group membership).
func (s *Server) castVote(ctx context.Context, r *http.Request, p Principal, a store.Approval, who approver, approve bool, note, ticket string,
	override bool, groupName string, extra map[string]any) voteResult {
	decision := map[bool]string{true: "approve", false: "deny"}[approve]
	if a.State != store.ApprovalPending {
		return voteResult{A: a, Code: http.StatusConflict, Refusal: "already_decided", Msg: store.ErrAlreadyDecided.Error()}
	}
	ticket, err := cleanTicket(ticket)
	if err != nil {
		return voteResult{A: a, Code: http.StatusBadRequest, Refusal: "bad_ticket", Msg: err.Error()}
	}
	requester := a.Requester
	if a.ExcludeRequester && approve {
		// the people mapping may have grown since the request was filed: both count
		if now, err := s.resolveRequester(ctx, a); err != nil {
			s.Logf("approval %s: requester: %v", a.ID, err)
		} else {
			requester = requester.Merge(now)
		}
	}
	if code, msg := voteRefusal(a, requester, who, approve, ticket); code != "" {
		if code == refuseSelf {
			s.audit(r, p, "approval."+refuseSelf, a.ID, map[string]any{"summary": a.Summary, "hostname": a.Hostname,
				"requester": requester.Label, "approver": who.Name, "emails": who.Emails, "via": who.Via})
		}
		status := http.StatusForbidden
		if code == refuseTicket {
			status = http.StatusBadRequest
		} else if code == refuseVoted {
			status = http.StatusConflict
		}
		return voteResult{A: a, Code: status, Refusal: code, Msg: msg}
	}
	got, final, err := s.Store.VoteApproval(ctx, a.Tenant, a.ID, store.Vote{Voter: who.Voter, UserID: who.UserID, Emails: who.Emails,
		Name: who.Name, Via: who.Via, Decision: decision, Note: note, Ticket: ticket, AdminOverride: override}, approvalUseWindow)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return voteResult{A: a, Code: http.StatusNotFound, Refusal: "not_found", Msg: "no such approval request"}
	case errors.Is(err, store.ErrAlreadyDecided):
		cur, _ := s.Store.GetApproval(ctx, a.Tenant, a.ID)
		return voteResult{A: cur, Code: http.StatusConflict, Refusal: "already_decided", Msg: err.Error()}
	case errors.Is(err, store.ErrAlreadyVoted):
		return voteResult{A: got, Code: http.StatusConflict, Refusal: refuseVoted, Msg: err.Error()}
	case err != nil:
		s.Logf("approval %s: vote: %v", a.ID, err)
		return voteResult{A: a, Code: http.StatusInternalServerError, Refusal: "error", Msg: "internal error"}
	}
	n, _ := s.Store.GetNotificationSettings(ctx, a.Tenant)
	details := map[string]any{"summary": got.Summary, "hostname": got.Hostname, "rule": got.Rule, "note": note,
		"group": groupName, "admin_override": override, "final": final, "state": got.State,
		"approvals": got.Approvals(), "approvals_required": got.ApprovalsRequired, "requester": requester.Label}
	if ticket != "" {
		details["ticket"], details["ticket_url"] = ticket, ticketURL(n.TicketURLTemplate, ticket)
	}
	for k, v := range extra {
		details[k] = v
	}
	s.audit(r, p, "approval."+decision, got.ID, details)
	as := []store.Approval{got}
	s.ticketLinks(ctx, got.Tenant, as)
	got = as[0]
	if final {
		s.emit(ctx, got.Tenant, "approval.decided", s.approvalEvent(got))
	} else {
		s.emit(ctx, got.Tenant, "approval.voted", s.approvalEvent(got))
		s.slackProgress(ctx, got)
	}
	return voteResult{A: got, Final: final}
}

// progressLine says how far a two-approver request got: "1 of 2 approvals (Dana)".
func progressLine(a store.Approval) string {
	var names []string
	for _, v := range a.Votes {
		if v.Decision == "approve" {
			names = append(names, v.Name)
		}
	}
	return fmt.Sprintf("%d of %d approvals (%s)", len(names), a.ApprovalsRequired, strings.Join(names, ", "))
}

// slackProgress updates the Slack app's message of a request that is still
// waiting for its second approval.
func (s *Server) slackProgress(ctx context.Context, a store.Approval) {
	channel, ts, ok := strings.Cut(a.SlackRef, ":")
	if !s.SlackEnabled || !ok {
		return
	}
	set, err := s.Store.GetNotificationSettings(ctx, a.Tenant)
	if err != nil || !set.SlackApp.Connected() {
		return
	}
	tok, err := s.open(a.Tenant, slackFieldToken, set.SlackApp.BotTokenEnc)
	if err != nil {
		s.Logf("approval %s: slack: %v", a.ID, err)
		return
	}
	m := s.approvalMessage(a)
	m.Actions = s.slackActions(a, set.SlackApp.TeamID)
	blocks := s.slackBlocksWith(m, "⏳ *"+progressLine(a)+"*")
	if err := s.Notify.SlackUpdate(ctx, tok, channel, ts, m.Title, blocks); err != nil {
		s.Logf("approval %s: slack update: %v", a.ID, err)
	}
}
