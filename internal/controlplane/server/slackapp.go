package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// A workspace's own Slack app makes Slack approvals attributable: Effigent
// posts each request with the bot token, Approve / Deny are interactive
// buttons, and Slack sends the click — signed with the app's signing secret
// and naming the Slack user — to POST /slack/interactions. The control plane
// looks the user up (users.info: name, email), checks they may approve, and
// records them on the request and in the audit trail.
//
// Each button's value is a link token (actionlinks.go) for the request,
// bound to the Slack workspace: request id, tenant and expiry stay
// HMAC-protected, and the tenant it names says whose signing secret must
// have signed the click.

const (
	slackFieldToken  = "slack_bot_token"
	slackFieldSecret = "slack_signing_secret"
	slackChannelApp  = "slack-app" // linkClaims.Channel for interactive Slack buttons
	slackMaxSkew     = 5 * time.Minute
)

var slackChannelID = regexp.MustCompile(`^[CG][A-Z0-9]{6,}$`)

// slackActions are the interactive Approve / Deny buttons for a request.
func (s *Server) slackActions(a store.Approval, teamID string) []notify.Action {
	if s.Key == nil {
		return nil
	}
	tok := s.signLink(linkClaims{Approval: a.ID, Tenant: a.Tenant, Recipient: teamID, Channel: slackChannelApp, Expires: a.ExpiresAt.Unix()})
	return []notify.Action{
		{Label: "Approve", Style: "primary", ActionID: "approve", Value: tok},
		{Label: "Deny", Style: "danger", ActionID: "deny", Value: tok},
	}
}

// postSlack sends a request message through the tenant's app (when
// connected) or its incoming webhook. Webhook messages have no deciding
// buttons: nobody could tell who clicked them, so they open the console.
func (s *Server) postSlack(ctx context.Context, tenant string, set store.NotificationSettings, m notify.Message, a *store.Approval) error {
	if set.SlackApp.Connected() {
		tok, err := s.open(tenant, slackFieldToken, set.SlackApp.BotTokenEnc)
		if err != nil {
			return err
		}
		if a != nil {
			m.Actions = s.slackActions(*a, set.SlackApp.TeamID)
			m.Footer = strings.Replace(m.Footer, "Approve or Deny opens a confirmation page;", "Approve / Deny records who clicked;", 1)
		}
		_, err = s.Notify.SlackPost(ctx, tok, set.SlackApp.Channel, m)
		return err
	}
	if a != nil {
		m.Footer = strings.Replace(m.Footer, "Approve or Deny opens a confirmation page;", "Approve or deny it in the Effigent console;", 1)
	}
	m.Actions = nil
	return s.Notify.Slack(ctx, set.SlackWebhook, m)
}

type slackAppView struct {
	Connected       bool   `json:"connected"`
	TeamID          string `json:"team_id,omitempty"`
	TeamName        string `json:"team_name,omitempty"`
	Channel         string `json:"channel,omitempty"`
	Approvers       string `json:"approvers"`
	InteractionsURL string `json:"interactions_url,omitempty"`
	// Available: this control plane can store Slack credentials (EFFIGENT_SECRETS_KEY).
	Available bool `json:"available"`
	// DirectoryAvailable: it can check Slack approvers against workspace
	// members (CLERK_SECRET_KEY); without it "members" mode refuses every click.
	DirectoryAvailable bool `json:"directory_available"`
}

func (s *Server) slackAppView(a store.SlackApp) slackAppView {
	v := slackAppView{Connected: a.Connected(), TeamID: a.TeamID, TeamName: a.TeamName, Channel: a.Channel, Approvers: a.Approvers,
		Available: len(s.SecretsKey) == 32, DirectoryAvailable: s.Directory != nil}
	if v.Approvers == "" {
		v.Approvers = "members"
	}
	if s.PublicBaseURL != "" {
		v.InteractionsURL = strings.TrimSuffix(s.PublicBaseURL, "/") + "/slack/interactions"
	}
	return v
}

// putSlackApp connects (or updates) the workspace's Slack app. The token and
// secret may be omitted to keep the stored ones.
func (s *Server) putSlackApp(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		BotToken      string `json:"bot_token"`
		SigningSecret string `json:"signing_secret"`
		Channel       string `json:"channel"`
		Approvers     string `json:"approvers"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	if !s.SlackEnabled {
		writeErr(w, http.StatusServiceUnavailable, "Slack approvals aren't available yet; use email")
		return
	}
	if len(s.SecretsKey) != 32 {
		writeErr(w, http.StatusServiceUnavailable, errNoSecretsKey.Error())
		return
	}
	n, err := s.Store.GetNotificationSettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	app := n.SlackApp
	token, secret := strings.TrimSpace(req.BotToken), strings.TrimSpace(req.SigningSecret)
	if token == "" && app.BotTokenEnc != "" {
		if token, err = s.open(p.Tenant, slackFieldToken, app.BotTokenEnc); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error()+" — paste the bot token again")
			return
		}
	}
	if secret == "" && app.SigningSecretEnc != "" {
		if secret, err = s.open(p.Tenant, slackFieldSecret, app.SigningSecretEnc); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error()+" — paste the signing secret again")
			return
		}
	}
	channel := strings.TrimSpace(req.Channel)
	if channel == "" {
		channel = app.Channel
	}
	approvers := req.Approvers
	if approvers == "" {
		approvers = app.Approvers
	}
	switch {
	case token == "":
		writeErr(w, http.StatusBadRequest, "the bot token is required (xoxb-…, from OAuth & Permissions)")
		return
	case len(secret) < 16 || strings.ContainsAny(secret, " \t\n"):
		writeErr(w, http.StatusBadRequest, "the signing secret is required (Basic Information → App Credentials)")
		return
	case !slackChannelID.MatchString(channel):
		writeErr(w, http.StatusBadRequest, "use the channel ID (C… — channel details → About, at the bottom), not its name")
		return
	case approvers != "members" && approvers != "workspace":
		writeErr(w, http.StatusBadRequest, `approvers must be "members" or "workspace"`)
		return
	}
	team, err := s.Notify.SlackAuthTest(r.Context(), token)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if channel != app.Channel || team.TeamID != app.TeamID || req.BotToken != "" {
		// prove the bot can post there before saving
		_, err := s.Notify.SlackPost(r.Context(), token, channel, notify.Message{
			Title:  "Effigent is connected",
			Footer: "AI agent approval requests for this workspace will arrive in this channel. Approve / Deny record who clicked.",
		})
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if app.BotTokenEnc, err = s.seal(p.Tenant, slackFieldToken, token); err != nil {
		s.fail(w, err)
		return
	}
	if app.SigningSecretEnc, err = s.seal(p.Tenant, slackFieldSecret, secret); err != nil {
		s.fail(w, err)
		return
	}
	app.Channel, app.TeamID, app.TeamName, app.Approvers = channel, team.TeamID, clip(team.Team, 120), approvers
	n.SlackApp, n.UpdatedBy = app, p.UserID
	if err := s.Store.PutNotificationSettings(r.Context(), p.Tenant, n); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "notifications.slack_app.connect", team.TeamID,
		map[string]any{"team": team.Team, "channel": channel, "approvers": approvers, "token_changed": req.BotToken != "", "secret_changed": req.SigningSecret != ""})
	n, _ = s.Store.GetNotificationSettings(r.Context(), p.Tenant)
	writeJSON(w, http.StatusOK, s.notificationView(n))
}

func (s *Server) deleteSlackApp(w http.ResponseWriter, r *http.Request, p Principal) {
	n, err := s.Store.GetNotificationSettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	team := n.SlackApp.TeamID
	n.SlackApp = store.SlackApp{Approvers: n.SlackApp.Approvers}
	n.UpdatedBy = p.UserID
	if err := s.Store.PutNotificationSettings(r.Context(), p.Tenant, n); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "notifications.slack_app.disconnect", team, nil)
	writeJSON(w, http.StatusOK, s.notificationView(n))
}

// ---- interactions ----

type slackInteraction struct {
	Type string `json:"type"`
	Team struct {
		ID     string `json:"id"`
		Domain string `json:"domain"`
	} `json:"team"`
	User struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		TeamID   string `json:"team_id"`
	} `json:"user"`
	ResponseURL string `json:"response_url"`
	Actions     []struct {
		ActionID string `json:"action_id"`
		Value    string `json:"value"`
	} `json:"actions"`
}

// verifySlackSignature checks X-Slack-Signature: v0=hex(HMAC-SHA256(secret, "v0:{ts}:{body}")).
func verifySlackSignature(secret string, h http.Header, body []byte, now time.Time) error {
	ts, err := strconv.ParseInt(h.Get("X-Slack-Request-Timestamp"), 10, 64)
	if err != nil {
		return errors.New("missing timestamp")
	}
	if d := now.Sub(time.Unix(ts, 0)); d > slackMaxSkew || d < -slackMaxSkew {
		return errors.New("stale timestamp")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "v0:%d:", ts)
	mac.Write(body)
	want := "v0=" + hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(h.Get("X-Slack-Signature"))) {
		return errors.New("bad signature")
	}
	return nil
}

func (s *Server) slackInteractions(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "body too large")
		return
	}
	form, err := url.ParseQuery(string(body))
	var in slackInteraction
	if err != nil || json.Unmarshal([]byte(form.Get("payload")), &in) != nil {
		writeErr(w, http.StatusBadRequest, "not a Slack interaction")
		return
	}
	if in.Type != "block_actions" || len(in.Actions) == 0 {
		w.WriteHeader(http.StatusOK) // other interaction types: nothing to do
		return
	}
	act := in.Actions[0]
	if act.ActionID != "approve" && act.ActionID != "deny" {
		w.WriteHeader(http.StatusOK) // "Review in Effigent" (a URL button) reports its click too
		return
	}
	// The button's own token says which tenant this is; it is ours (HMAC),
	// so only that tenant's signing secret may have signed the click.
	c, _, err := s.parseLink(act.Value) // an expired request is answered after the identity check
	if err != nil || c.Channel != slackChannelApp {
		writeErr(w, http.StatusUnauthorized, "unknown button")
		return
	}
	set, err := s.Store.GetNotificationSettings(r.Context(), c.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	app := set.SlackApp
	if !s.SlackEnabled || !app.Connected() {
		writeErr(w, http.StatusUnauthorized, "Slack is not connected for this workspace")
		return
	}
	secret, err := s.open(c.Tenant, slackFieldSecret, app.SigningSecretEnc)
	if err != nil {
		s.Logf("slack interaction %s: %v", c.Tenant, err)
		writeErr(w, http.StatusUnauthorized, "cannot verify")
		return
	}
	if err := verifySlackSignature(secret, r.Header, body, time.Now()); err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid Slack signature: "+err.Error())
		return
	}
	if in.Team.ID != app.TeamID || c.Recipient != app.TeamID {
		writeErr(w, http.StatusForbidden, "this button belongs to another Slack workspace")
		return
	}
	// Slack wants an answer within 3 seconds; the rest (users.info, the
	// directory, the decision) is reported through response_url.
	rr := r.Clone(context.WithoutCancel(r.Context()))
	w.WriteHeader(http.StatusOK)
	go s.handleSlackDecision(rr, app, c, in, act.ActionID == "approve")
}

func (s *Server) handleSlackDecision(r *http.Request, app store.SlackApp, c linkClaims, in slackInteraction, approve bool) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	// every answer may carry names and emails from Slack profiles: escaped,
	// so a display name like "<!channel>" can't ping anyone
	say := func(text string) {
		if err := s.Notify.SlackRespond(ctx, in.ResponseURL, map[string]any{"response_type": "ephemeral", "replace_original": false, "text": notify.SlackEscape(text)}); err != nil {
			s.Logf("slack interaction %s: %v", c.Approval, err)
		}
	}
	token, err := s.open(c.Tenant, slackFieldToken, app.BotTokenEnc)
	if err != nil {
		s.Logf("slack interaction %s: %v", c.Tenant, err)
		say("Effigent can't read this workspace's Slack connection. Decide in the Effigent console.")
		return
	}
	u, err := s.slackUser(ctx, token, app.TeamID, in.User.ID)
	if err != nil {
		s.Logf("slack interaction %s: users.info %s: %v", c.Approval, in.User.ID, err)
		say("Effigent couldn't look up your Slack account (" + err.Error() + "). Nothing was decided.")
		return
	}
	switch {
	case u.IsBot || u.Deleted:
		say("Only people can approve. Nothing was decided.")
		return
	case u.IsRestricted:
		say("Guest accounts can't approve agent actions. Nothing was decided.")
		return
	case u.Email == "":
		say("Effigent can't see the email on your Slack profile (the app needs users:read.email), so it can't tell who you are. Nothing was decided.")
		return
	}
	role, why := s.slackApproverRole(ctx, c.Tenant, app, u.Email)
	if role == "" {
		say(why + " Nothing was decided.")
		return
	}
	if c.Approval == "apr_sample" {
		say(fmt.Sprintf("This was a sample — nothing is waiting. A real click would be recorded as %s <%s> (%s).", u.Name(), u.Email, role))
		return
	}
	verb := map[bool]string{true: "approve", false: "deny"}[approve]
	by := "slack:" + app.TeamID + ":" + u.ID
	name := clip(fmt.Sprintf("%s <%s> (via Slack)", u.Name(), u.Email), 200)
	a, err := s.Store.DecideApproval(ctx, c.Tenant, c.Approval, approve, by, name, "", approvalUseWindow)
	if errors.Is(err, store.ErrAlreadyDecided) {
		cur, _ := s.Store.GetApproval(ctx, c.Tenant, c.Approval)
		state, line := cur.State, byLineText(cur)
		if state == store.ApprovalPending {
			state = "expired"
		}
		s.slackReplace(ctx, in.ResponseURL, cur, slackStatus(state, line, cur.DecidedAt))
		say("This request is already " + map[string]string{store.ApprovalUsed: "approved (and used)"}[state] + map[bool]string{true: state}[state != store.ApprovalUsed] + line + ".")
		return
	} else if errors.Is(err, store.ErrNotFound) {
		say("This approval request no longer exists.")
		return
	} else if err != nil {
		s.Logf("slack interaction %s: %v", c.Approval, err)
		say("Effigent couldn't record the decision. Try again, or decide in the console.")
		return
	}
	p := Principal{UserID: by, Tenant: c.Tenant, Role: role, Via: "slack"}
	s.audit(r, p, "approval."+verb, a.ID, map[string]any{"summary": a.Summary, "hostname": a.Hostname, "rule": a.Rule, "note": "",
		"via": "slack", "slack_user_id": u.ID, "slack_team_id": app.TeamID, "slack_username": u.Username, "name": u.Name(), "email": u.Email})
	s.emit(ctx, c.Tenant, "approval.decided", s.approvalEvent(a))
	s.slackReplace(ctx, in.ResponseURL, a, slackStatus(a.State, fmt.Sprintf(" by %s (%s)", u.Name(), u.Email), a.DecidedAt))
}

// slackApproverRole applies the workspace's rule for who may decide from
// Slack. It returns the role to record, or "" and why not.
func (s *Server) slackApproverRole(ctx context.Context, tenant string, app store.SlackApp, email string) (string, string) {
	if app.Approvers == "workspace" {
		return "slack_member", ""
	}
	if s.Directory == nil {
		return "", "Effigent can't check approvers from Slack yet (the control plane has no CLERK_SECRET_KEY). Decide in the Effigent console."
	}
	role, err := s.Directory.MemberRole(ctx, tenant, email)
	if err != nil {
		s.Logf("directory %s: %v", tenant, err)
		return "", "Effigent couldn't check whether you're an approver. Try again, or decide in the console."
	}
	if role != "admin" && role != "security_admin" {
		if role == "" {
			return "", email + " isn't a member of this Effigent workspace (sign in with the same email, or ask an admin)."
		}
		return "", email + " is a " + role + " in Effigent; only admins and security admins can approve."
	}
	return role, ""
}

func slackStatus(state, by string, at *time.Time) string {
	icon := map[string]string{store.ApprovalApproved: "✅", store.ApprovalUsed: "✅", store.ApprovalDenied: "⛔", "expired": "⌛"}[state]
	when := ""
	if at != nil {
		when = " at " + at.UTC().Format("Jan 2 15:04 MST")
	}
	label := map[string]string{store.ApprovalApproved: "Approved", store.ApprovalUsed: "Approved (and used)", store.ApprovalDenied: "Denied", "expired": "Expired"}[state]
	if label == "" {
		label = state
	}
	return strings.TrimSpace(icon + " *" + label + "*" + notify.SlackEscape(by) + when)
}

// slackReplace rewrites the original request message without its buttons,
// ending with who decided.
func (s *Server) slackReplace(ctx context.Context, responseURL string, a store.Approval, status string) {
	m := s.approvalMessage(a)
	m.Actions, m.Footer = nil, ""
	blocks := notify.SlackBlocks(m)
	blocks = append(blocks, map[string]any{"type": "context", "elements": []map[string]any{{"type": "mrkdwn", "text": status}}})
	if err := s.Notify.SlackRespond(ctx, responseURL, map[string]any{"replace_original": true, "text": m.Title, "blocks": blocks}); err != nil {
		s.Logf("slack interaction %s: %v", a.ID, err)
	}
}

func byLineText(a store.Approval) string {
	if a.DecidedByName == "" {
		return ""
	}
	return " by " + a.DecidedByName
}

// slackUser caches users.info for a few minutes (repeat clicks, rate limits).
func (s *Server) slackUser(ctx context.Context, token, team, user string) (notify.SlackUser, error) {
	k := team + ":" + user
	s.slackMu.Lock()
	if e, ok := s.slackUsers[k]; ok && time.Since(e.at) < 5*time.Minute {
		s.slackMu.Unlock()
		return e.u, nil
	}
	s.slackMu.Unlock()
	u, err := s.Notify.SlackUserInfo(ctx, token, user)
	if err != nil {
		return u, err
	}
	s.slackMu.Lock()
	if s.slackUsers == nil || len(s.slackUsers) > 5000 {
		s.slackUsers = map[string]slackUserEntry{}
	}
	s.slackUsers[k] = slackUserEntry{u: u, at: time.Now()}
	s.slackMu.Unlock()
	return u, nil
}

type slackUserEntry struct {
	u  notify.SlackUser
	at time.Time
}
