package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
		s.audit(r, Principal{UserID: "endpoint:" + ep.ID, Tenant: ep.Tenant, Via: "endpoint"}, "approval.request", a.ID,
			map[string]any{"agent": a.Agent, "rule": a.Rule, "summary": a.Summary, "hostname": a.Hostname})
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
	if a.State == store.ApprovalUsed {
		resp.State = store.ApprovalApproved
	}
	writeJSON(w, http.StatusOK, resp)
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
	if set.SlackWebhook != "" {
		if err := s.Notify.Slack(ctx, set.SlackWebhook, m); err != nil {
			results["slack"] = "error: " + err.Error()
		} else {
			results["slack"] = "sent"
			ok = append(ok, "slack")
		}
	}
	if len(set.Emails) > 0 {
		if err := s.Notify.Email(ctx, set.Emails, m); err != nil {
			results["email"] = "error: " + err.Error()
		} else {
			results["email"] = "sent"
			ok = append(ok, "email")
		}
	}
	if len(results) == 0 {
		results["none"] = "no Slack webhook or email recipients configured; the request waits in the console"
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
		Footer: "The agent is paused. Approving lets this one action run once.",
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
	writeJSON(w, http.StatusOK, as)
}

func (s *Server) decideApproval(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Decision string `json:"decision"` // approve | deny
		Note     string `json:"note"`
		Name     string `json:"name"` // the approver's display name, for the agent's message
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil || (req.Decision != "approve" && req.Decision != "deny") {
		writeErr(w, http.StatusBadRequest, `body must be {"decision": "approve" | "deny", "note": "…"}`)
		return
	}
	name := clip(strings.Join(strings.Fields(req.Name), " "), 80)
	if name == "" {
		name = p.UserID
	}
	a, err := s.Store.DecideApproval(r.Context(), p.Tenant, r.PathValue("id"), req.Decision == "approve", p.UserID, name,
		clip(strings.TrimSpace(req.Note), 500), approvalUseWindow)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "no such approval request")
		return
	case errors.Is(err, store.ErrAlreadyDecided):
		writeErr(w, http.StatusConflict, err.Error())
		return
	case err != nil:
		s.fail(w, err)
		return
	}
	s.emit(r.Context(), p.Tenant, "approval.decided", s.approvalEvent(a))
	s.audit(r, p, "approval."+req.Decision, a.ID, map[string]any{"summary": a.Summary, "hostname": a.Hostname, "rule": a.Rule, "note": a.Note})
	writeJSON(w, http.StatusOK, a)
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
	writeJSON(w, http.StatusOK, a)
}

type notificationView struct {
	SlackWebhookSet  bool      `json:"slack_webhook_set"`
	SlackWebhookHint string    `json:"slack_webhook_hint,omitempty"` // last characters, to recognise it
	Emails           []string  `json:"emails"`
	EmailAvailable   bool      `json:"email_available"` // this control plane can send email
	UpdatedBy        string    `json:"updated_by,omitempty"`
	UpdatedAt        time.Time `json:"updated_at,omitempty"`
}

func (s *Server) notificationView(n store.NotificationSettings) notificationView {
	v := notificationView{SlackWebhookSet: n.SlackWebhook != "", Emails: n.Emails, EmailAvailable: s.Notify.EmailEnabled(),
		UpdatedBy: n.UpdatedBy, UpdatedAt: n.UpdatedAt}
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
	n.UpdatedBy = p.UserID
	if err := s.Store.PutNotificationSettings(r.Context(), p.Tenant, n); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "notifications.update", "approvals", map[string]any{"slack_webhook_set": n.SlackWebhook != "", "emails": n.Emails})
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
	m := notify.Message{
		Title:  "Test: approval requests from Effigent will arrive here",
		Fields: [][2]string{{"Action", "Bash: git push --force origin main (example)"}, {"Machine", "dev on example-laptop"}},
		Footer: "Sent from the Effigent console's notification settings.",
	}
	if s.ConsoleOrigin != "" {
		m.Link = s.ConsoleOrigin + "/approvals"
	}
	res := map[string]string{}
	if n.SlackWebhook != "" {
		res["slack"] = "sent"
		if err := s.Notify.Slack(r.Context(), n.SlackWebhook, m); err != nil {
			res["slack"] = err.Error()
		}
	}
	if len(n.Emails) > 0 {
		res["email"] = "sent"
		if err := s.Notify.Email(r.Context(), n.Emails, m); err != nil {
			res["email"] = err.Error()
		}
	}
	writeJSON(w, http.StatusOK, res)
}
