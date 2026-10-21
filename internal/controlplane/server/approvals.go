package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// MaxApprovalWait caps how long POST /ep/v1/approvals holds the request open
// for a decision (effigentd's hook waits a little longer than this).
const MaxApprovalWait = 90 * time.Second

// approvalUseWindow: an approval stays usable at least this long after it is
// given, even when the request was about to expire.
const approvalUseWindow = 15 * time.Minute

// endpointApproval is what effigentd sends when a tool call matched an
// approval list. Summary is redacted on the endpoint.
type endpointApprovalReq struct {
	Fingerprint string `json:"fingerprint"`
	Agent       string `json:"agent"`
	SessionID   string `json:"session_id"`
	Tool        string `json:"tool"`
	Summary     string `json:"summary"`
	Cwd         string `json:"cwd"`
	Rule        string `json:"rule"`
	Reason      string `json:"reason"`
	OSUser      string `json:"os_user"`
	TTLMinutes  int    `json:"ttl_minutes"`
	WaitSeconds int    `json:"wait_seconds"`
}

// endpointApprovalResp: state is approved (go ahead: this call consumed the
// approval), pending, denied or expired.
type endpointApprovalResp struct {
	ID            string    `json:"id"`
	State         string    `json:"state"`
	DecidedByName string    `json:"decided_by_name,omitempty"`
	Note          string    `json:"note,omitempty"`
	ExpiresAt     time.Time `json:"expires_at"`
	Created       bool      `json:"created"`
	Notified      []string  `json:"notified,omitempty"` // channels the request went to (when created)
	// A request that needs two approvers stays pending after the first:
	// "1 of 2 approvals (Dana)".
	Approvals         int      `json:"approvals"`
	ApprovalsRequired int      `json:"approvals_required"`
	ApprovedBy        []string `json:"approved_by,omitempty"`
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func (s *Server) requestApproval(w http.ResponseWriter, r *http.Request, ep store.Endpoint) {
	var req endpointApprovalReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad approval request")
		return
	}
	if !strings.HasPrefix(req.Fingerprint, "fp1:") || len(req.Fingerprint) != 68 {
		writeErr(w, http.StatusBadRequest, "fingerprint must be an action fingerprint (fp1:…)")
		return
	}
	ttl := time.Duration(req.TTLMinutes) * time.Minute
	if ttl <= 0 {
		ttl = time.Hour
	}
	ttl = min(ttl, 7*24*time.Hour)
	a, created, err := s.Store.RequestApproval(r.Context(), store.Approval{
		Tenant: ep.Tenant, EndpointID: ep.ID, Fingerprint: req.Fingerprint, Hostname: ep.Hostname,
		Agent: clip(req.Agent, 64), SessionID: clip(req.SessionID, 128), Tool: clip(req.Tool, 128),
		Summary: clip(req.Summary, 2000), Cwd: clip(req.Cwd, 512), Rule: clip(req.Rule, 64),
		Reason: clip(req.Reason, 500), OSUser: clip(req.OSUser, 64),
	}, ttl)
	if err != nil {
		s.fail(w, err)
		return
	}
	resp := endpointApprovalResp{Created: created}
	if created {
		// who decides, and how: fixed now, when the request is filed
		f := s.fileApproval(r.Context(), a)
		a.GroupID, a.RouteID, a.ApprovalsRequired, a.ExcludeRequester, a.RequireTicket, a.Requester =
			f.GroupID, f.RouteID, f.ApprovalsRequired, f.ExcludeRequester, f.RequireTicket, f.Requester
		if err := s.Store.SetApprovalFiling(r.Context(), a.ID, f); err != nil {
			s.Logf("approval %s: %v", a.ID, err)
		}
		s.audit(r, Principal{UserID: "endpoint:" + ep.ID, Tenant: ep.Tenant, Via: "endpoint"}, "approval.request", a.ID,
			map[string]any{"agent": a.Agent, "rule": a.Rule, "summary": a.Summary, "hostname": a.Hostname, "group_id": a.GroupID, "route_id": a.RouteID,
				"approvals_required": a.ApprovalsRequired, "exclude_requester": a.ExcludeRequester, "require_ticket": a.RequireTicket, "requester": a.Requester.Label})
		resp.Notified = s.announce(context.WithoutCancel(r.Context()), a)
		s.emit(context.WithoutCancel(r.Context()), ep.Tenant, "approval.requested", s.approvalEvent(a))
	}

	wait := min(time.Duration(req.WaitSeconds)*time.Second, MaxApprovalWait)
	deadline := time.Now().Add(wait)
	for a.State == store.ApprovalPending && time.Now().Before(deadline) {
		select {
		case <-r.Context().Done(): // the agent gave up (Esc, hook timeout)
			return
		case <-time.After(time.Second):
		}
		if a, err = s.Store.ConsumeApproval(r.Context(), ep.ID, a.ID); err != nil {
			s.fail(w, err)
			return
		}
	}
	resp.ID, resp.State, resp.DecidedByName, resp.Note, resp.ExpiresAt = a.ID, a.State, a.DecidedByName, a.Note, a.ExpiresAt
	resp.Approvals, resp.ApprovalsRequired = a.Approvals(), max(a.ApprovalsRequired, 1)
	for _, v := range a.Votes {
		if v.Decision == "approve" && a.State == store.ApprovalPending {
			resp.ApprovedBy = append(resp.ApprovedBy, v.Name)
		}
	}
	if a.State == store.ApprovalUsed {
		resp.State = store.ApprovalApproved
	}
	writeJSON(w, http.StatusOK, resp)
}

// fileApproval routes a new request and resolves who asked. Routing or
// lookup errors are logged and leave the defaults (workspace admins, one
// approval, requester excluded): a request is never left undecidable.
func (s *Server) fileApproval(ctx context.Context, a store.Approval) store.ApprovalFiling {
	f := store.ApprovalFiling{ApprovalsRequired: 1, ExcludeRequester: true}
	if cfg, err := s.Store.GetRouting(ctx, a.Tenant); err != nil {
		s.Logf("approval %s: routing: %v", a.ID, err)
	} else {
		route, group := routeFor(cfg, a)
		if group != nil {
			f.GroupID = group.ID
		}
		if route != nil {
			f.RouteID = route.ID
		}
		rules := rulesFor(cfg, route)
		f.ApprovalsRequired, f.ExcludeRequester, f.RequireTicket = rules.Required(), rules.Excludes(), rules.RequireTicket
	}
	q, err := s.resolveRequester(ctx, a)
	if err != nil {
		s.Logf("approval %s: requester: %v", a.ID, err)
	}
	f.Requester = q
	return f
}

// announce sends a new request to the tenant's channels and records the
// result on the request. It returns the channels that accepted it.
func (s *Server) announce(ctx context.Context, a store.Approval) []string {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	set, err := s.Store.GetNotificationSettings(ctx, a.Tenant)
	if err != nil {
		s.Logf("approval %s: notification settings: %v", a.ID, err)
		return nil
	}
	m := s.approvalMessage(a)
	results := map[string]string{}
	var ok []string
	if s.SlackEnabled && (set.SlackApp.Connected() || set.SlackWebhook != "") {
		if err := s.postSlack(ctx, a.Tenant, set, m, &a); err != nil {
			results["slack"] = "error: " + err.Error()
		} else {
			results["slack"] = "sent"
			ok = append(ok, "slack")
			if a.SlackRef != "" {
				if err := s.Store.SetApprovalSlackRef(ctx, a.ID, a.SlackRef); err != nil {
					s.Logf("approval %s: %v", a.ID, err)
				}
			}
		}
	}
	recipients := set.Emails
	if cfg, err := s.Store.GetRouting(ctx, a.Tenant); err == nil {
		if g := cfg.Group(a.GroupID); g != nil {
			// routed: the group's members decide, so they are the ones asked
			recipients = nil
			for _, m := range g.Members {
				if m.Email != "" && !slices.ContainsFunc(recipients, func(e string) bool { return strings.EqualFold(e, m.Email) }) {
					recipients = append(recipients, m.Email)
				}
			}
			m.Fields = append(m.Fields, [2]string{"Decided by", g.Name})
		}
	}
	if len(recipients) > 0 {
		// one message per recipient: each carries buttons signed for that address
		var failed []string
		for _, rcpt := range recipients {
			em := m
			em.Actions = s.approvalActions(a, rcpt, "email")
			if err := s.Notify.Email(ctx, []string{rcpt}, em); err != nil {
				failed = append(failed, rcpt+": "+err.Error())
			}
		}
		if len(failed) == 0 {
			results["email"] = "sent"
			ok = append(ok, "email")
		} else {
			results["email"] = "error: " + strings.Join(failed, "; ")
		}
	}
	if len(results) == 0 {
		results["none"] = "no email recipients (or the routed group has no emails); the request waits in the console"
	}
	for ch, res := range results {
		if strings.HasPrefix(res, "error") {
			s.Logf("approval %s: %s %s", a.ID, ch, res)
		}
	}
	raw, _ := json.Marshal(results)
	if err := s.Store.SetApprovalNotified(ctx, a.ID, raw); err != nil {
		s.Logf("approval %s: %v", a.ID, err)
	}
	return ok
}

var agentNames = map[string]string{"claude-code": "Claude Code", "cursor-agent": "Cursor", "codex": "Codex", "gemini-cli": "Gemini CLI"}

func (s *Server) approvalMessage(a store.Approval) notify.Message {
	agent := agentNames[a.Agent]
	if agent == "" {
		agent = a.Agent
	}
	machine := a.Hostname
	if a.OSUser != "" {
		machine = a.OSUser + " on " + a.Hostname
	}
	m := notify.Message{
		Title: fmt.Sprintf("Approval needed: %s on %s", agent, a.Hostname),
		Fields: [][2]string{
			{"Action", clip(a.Summary, 500)},
			{"Why", a.Reason},
			{"Machine", machine},
			{"Rule", a.Rule},
			{"Expires", a.ExpiresAt.UTC().Format("Jan 2 15:04 MST")},
			{"Request", a.ID},
		},
		Footer: "The agent is paused. Approve or Deny opens a confirmation page; approving lets this one action run once.",
	}
	if a.Requester.Label != "" {
		m.Fields = append(m.Fields[:3], append([][2]string{{"Requested by", a.Requester.Label}}, m.Fields[3:]...)...)
	}
	if a.ApprovalsRequired > 1 {
		txt := fmt.Sprintf("%d different people must approve", a.ApprovalsRequired)
		if a.ExcludeRequester {
			txt += "; the requester can't be one of them"
		}
		m.Fields = append(m.Fields, [2]string{"Approvals", txt})
	}
	if a.RequireTicket {
		m.Fields = append(m.Fields, [2]string{"Ticket", "approving needs a ticket reference: approve in the Effigent console"})
	}
	if s.ConsoleOrigin != "" {
		m.Link = s.ConsoleOrigin + "/approvals?id=" + a.ID
	}
	return m
}

// ---- console ----

func (s *Server) listApprovals(w http.ResponseWriter, r *http.Request, p Principal) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	state := r.URL.Query().Get("state")
	switch state {
	case "", store.ApprovalPending, store.ApprovalApproved, store.ApprovalDenied, store.ApprovalExpired, store.ApprovalUsed:
	default:
		writeErr(w, http.StatusBadRequest, "unknown state")
		return
	}
	as, err := s.Store.ListApprovals(r.Context(), p.Tenant, state, limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	cfg, err := s.Store.GetRouting(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	type view struct {
		store.Approval
		GroupName        string `json:"group_name"`
		CanDecide        bool   `json:"can_decide"`         // this caller may decide it
		DecideIsOverride bool   `json:"decide_is_override"` // ...as an admin stepping in for the group
		// CanApprove: this caller may approve it (a ticket may still be
		// needed); else ApproveRefusal / ApproveRefusalMessage say why.
		CanApprove            bool   `json:"can_approve"`
		ApproveRefusal        string `json:"approve_refusal,omitempty"`
		ApproveRefusalMessage string `json:"approve_refusal_message,omitempty"`
		QuorumWarning         string `json:"quorum_warning,omitempty"`
	}
	s.ticketLinks(r.Context(), p.Tenant, as)
	var who *approver
	out := make([]view, 0, len(as))
	for _, a := range as {
		v := view{Approval: a}
		g := cfg.Group(a.GroupID)
		if g != nil {
			v.GroupName = g.Name
		}
		v.CanDecide, v.DecideIsOverride, _ = canDecide(p, a, cfg)
		if a.State == store.ApprovalPending && v.CanDecide {
			if who == nil {
				x := s.consoleApprover(r.Context(), p, cfg, "")
				who = &x
			}
			v.ApproveRefusal, v.ApproveRefusalMessage = voteRefusal(a, a.Requester, *who, true, "-")
			v.CanApprove = v.ApproveRefusal == ""
			v.QuorumWarning = quorumWarning(g, a.Requester, store.ApprovalRules{ApprovalsRequired: a.ApprovalsRequired, ExcludeRequester: &a.ExcludeRequester})
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) decideApproval(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Decision string `json:"decision"` // approve | deny
		Note     string `json:"note"`
		Name     string `json:"name"`   // the approver's display name, for the agent's message
		Ticket   string `json:"ticket"` // SEC-123 or a link (required to approve when the route says so)
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil || (req.Decision != "approve" && req.Decision != "deny") {
		writeErr(w, http.StatusBadRequest, `body must be {"decision": "approve" | "deny", "note": "…"}`)
		return
	}
	cur, err := s.Store.GetApproval(r.Context(), p.Tenant, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such approval request")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	cfg, err := s.Store.GetRouting(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	ok, override, member := canDecide(p, cur, cfg)
	if !ok {
		who := "workspace admins and security admins"
		if g := cfg.Group(cur.GroupID); g != nil {
			who = "members of " + g.Name + " (or a workspace admin)"
		}
		writeErr(w, http.StatusForbidden, "only "+who+" can decide this request")
		return
	}
	name := clip(strings.Join(strings.Fields(req.Name), " "), 80)
	if member != nil { // the group knows who this is
		name = cmpOr(member.Name, member.Email)
		if member.Email != "" && member.Name != "" {
			name = member.Name + " <" + member.Email + ">"
		}
	}
	if name == "" {
		name = p.UserID
	}
	groupName := ""
	if g := cfg.Group(cur.GroupID); g != nil {
		groupName = g.Name
	}
	if override {
		name += " (admin, for " + groupName + ")"
	}
	who := s.consoleApprover(r.Context(), p, cfg, name)
	res := s.castVote(r.Context(), r, p, cur, who, req.Decision == "approve", clip(strings.TrimSpace(req.Note), 500), req.Ticket, override, groupName, nil)
	switch {
	case res.Refusal == "error":
		s.fail(w, errors.New(res.Msg))
	case res.Refusal != "":
		writeJSON(w, res.Code, map[string]string{"error": res.Msg, "code": res.Refusal})
	default:
		writeJSON(w, http.StatusOK, res.A)
	}
}

// approvalEvent is a webhook's data for an approval: the request and where to review it.
func (s *Server) approvalEvent(a store.Approval) map[string]any {
	d := map[string]any{"approval": a}
	if s.ConsoleOrigin != "" {
		d["review_url"] = s.ConsoleOrigin + "/approvals?id=" + a.ID
	}
	return d
}

// getApproval returns one request, so automations can re-check it before acting.
func (s *Server) getApproval(w http.ResponseWriter, r *http.Request, p Principal) {
	a, err := s.Store.GetApproval(r.Context(), p.Tenant, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such approval request")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	if a.State == store.ApprovalPending && !a.ExpiresAt.After(time.Now()) {
		a.State = store.ApprovalExpired
	}
	one := []store.Approval{a}
	s.ticketLinks(r.Context(), p.Tenant, one)
	writeJSON(w, http.StatusOK, one[0])
}

type notificationView struct {
	SlackWebhookSet  bool         `json:"slack_webhook_set"`
	SlackWebhookHint string       `json:"slack_webhook_hint,omitempty"` // last characters, to recognise it
	Emails           []string     `json:"emails"`
	EmailAvailable   bool         `json:"email_available"` // this control plane can send email
	UpdatedBy        string       `json:"updated_by,omitempty"`
	UpdatedAt        time.Time    `json:"updated_at,omitempty"`
	SlackApp         slackAppView `json:"slack_app"`
	SlackEnabled     bool         `json:"slack_enabled"` // this control plane posts to Slack
	// TicketURLTemplate turns a ticket key on a vote into a link:
	// https://acme.atlassian.net/browse/{key}.
	TicketURLTemplate string `json:"ticket_url_template"`
}

func (s *Server) notificationView(n store.NotificationSettings) notificationView {
	v := notificationView{SlackWebhookSet: n.SlackWebhook != "", Emails: n.Emails, EmailAvailable: s.Notify.EmailEnabled(),
		UpdatedBy: n.UpdatedBy, UpdatedAt: n.UpdatedAt, SlackApp: s.slackAppView(n.SlackApp), SlackEnabled: s.SlackEnabled,
		TicketURLTemplate: n.TicketURLTemplate}
	if v.SlackWebhookSet {
		v.SlackWebhookHint = "…" + n.SlackWebhook[max(0, len(n.SlackWebhook)-4):]
	}
	if v.Emails == nil {
		v.Emails = []string{}
	}
	return v
}

func (s *Server) getNotifications(w http.ResponseWriter, r *http.Request, p Principal) {
	n, err := s.Store.GetNotificationSettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.notificationView(n))
}

func (s *Server) putNotifications(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		SlackWebhook *string  `json:"slack_webhook"` // omitted: keep; "": remove
		Emails       []string `json:"emails"`
		TicketURL    *string  `json:"ticket_url_template"` // omitted: keep; "": remove
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	n, err := s.Store.GetNotificationSettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	if req.SlackWebhook != nil {
		u := strings.TrimSpace(*req.SlackWebhook)
		if u != "" && !s.SlackEnabled {
			writeErr(w, http.StatusBadRequest, "Slack approvals aren't available yet; use email")
			return
		}
		if u != "" {
			if err := notify.ValidSlackWebhook(u); err != nil {
				writeErr(w, http.StatusBadRequest, err.Error())
				return
			}
		}
		n.SlackWebhook = u
	}
	if req.Emails != nil {
		seen := map[string]bool{}
		n.Emails = []string{}
		for _, e := range req.Emails {
			e = strings.TrimSpace(e)
			if e == "" || seen[strings.ToLower(e)] {
				continue
			}
			if err := notify.ValidEmail(e); err != nil {
				writeErr(w, http.StatusBadRequest, err.Error())
				return
			}
			seen[strings.ToLower(e)] = true
			n.Emails = append(n.Emails, e)
		}
		if len(n.Emails) > 20 {
			writeErr(w, http.StatusBadRequest, "at most 20 email recipients")
			return
		}
	}
	if req.TicketURL != nil {
		t, err := cleanTicketTemplate(*req.TicketURL)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		n.TicketURLTemplate = t
	}
	n.UpdatedBy = p.UserID
	if err := s.Store.PutNotificationSettings(r.Context(), p.Tenant, n); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "notifications.update", "approvals", map[string]any{"slack_webhook_set": n.SlackWebhook != "", "emails": n.Emails,
		"ticket_url_template": n.TicketURLTemplate})
	n, _ = s.Store.GetNotificationSettings(r.Context(), p.Tenant)
	writeJSON(w, http.StatusOK, s.notificationView(n))
}

// testNotifications sends a sample request to the configured channels.
func (s *Server) testNotifications(w http.ResponseWriter, r *http.Request, p Principal) {
	n, err := s.Store.GetNotificationSettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	var req struct {
		Sample string `json:"sample"` // "approval": the exact message an approver gets, for a sample request
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req)
	m := notify.Message{
		Title:  "Test: approval requests from Effigent will arrive here",
		Fields: [][2]string{{"Action", "Bash: git push --force origin main (example)"}, {"Machine", "dev on example-laptop"}},
		Footer: "Sent from the Effigent console's notification settings.",
	}
	if s.ConsoleOrigin != "" {
		m.Link = s.ConsoleOrigin + "/approvals"
	}
	var sample *store.Approval
	if req.Sample == "approval" {
		sample = &store.Approval{ID: "apr_sample", Tenant: p.Tenant, Agent: "claude-code", Hostname: "dana-mbp", OSUser: "dana",
			Summary: "Bash: git push --force origin main", Reason: "`git push --force origin main` needs approval",
			Rule: "command_approve", ExpiresAt: time.Now().Add(time.Hour)}
		m = s.approvalMessage(*sample)
		m.Title = "[Sample] " + m.Title
		m.Footer = "This is a sample from the Effigent console — nothing is waiting. " + m.Footer
	}
	res := map[string]string{}
	if s.SlackEnabled && (n.SlackApp.Connected() || n.SlackWebhook != "") {
		res["slack"] = "sent"
		if err := s.postSlack(r.Context(), p.Tenant, n, m, sample); err != nil {
			res["slack"] = err.Error()
		}
	}
	if len(n.Emails) > 0 {
		res["email"] = "sent"
		for _, rcpt := range n.Emails {
			em := m
			if sample != nil {
				em.Actions = s.approvalActions(*sample, rcpt, "email")
			}
			if err := s.Notify.Email(r.Context(), []string{rcpt}, em); err != nil {
				res["email"] = err.Error()
			}
		}
	}
	writeJSON(w, http.StatusOK, res)
}
