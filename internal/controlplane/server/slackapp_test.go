package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/jackc/pgx/v5"
)

// fakeSlack stands in for slack.com/api and hooks.slack.com/actions.
type fakeSlack struct {
	mu        sync.Mutex
	posts     []string // chat.postMessage bodies
	responses []string // response_url bodies
	users     map[string]map[string]any
	token     string
}

func (f *fakeSlack) RoundTrip(r *http.Request) (*http.Response, error) {
	b, _ := io.ReadAll(r.Body)
	reply := func(v any) (*http.Response, error) {
		raw, _ := json.Marshal(v)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), Header: http.Header{}}, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Host == "hooks.slack.com" && strings.HasPrefix(r.URL.Path, "/actions/") {
		f.responses = append(f.responses, string(b))
		return reply(map[string]any{"ok": true})
	}
	if r.URL.Host != "slack.test" {
		return nil, fmt.Errorf("unexpected host %s", r.URL.Host)
	}
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		return reply(map[string]any{"ok": false, "error": "invalid_auth"})
	}
	switch r.URL.Path {
	case "/api/auth.test":
		return reply(map[string]any{"ok": true, "team_id": "T1", "team": "Acme", "user_id": "UBOT", "bot_id": "B1"})
	case "/api/chat.postMessage":
		if !strings.Contains(string(b), `"channel":"C0SECURITY"`) && !strings.Contains(string(b), `"channel":"C0SECOPS"`) {
			return reply(map[string]any{"ok": false, "error": "not_in_channel"})
		}
		f.posts = append(f.posts, string(b))
		return reply(map[string]any{"ok": true, "ts": "1.2"})
	case "/api/users.info":
		form, _ := url.ParseQuery(string(b))
		u, ok := f.users[form.Get("user")]
		if !ok {
			return reply(map[string]any{"ok": false, "error": "user_not_found"})
		}
		return reply(map[string]any{"ok": true, "user": u})
	}
	return reply(map[string]any{"ok": false, "error": "unknown_method"})
}

func (f *fakeSlack) waitResponse(t *testing.T, n int) string {
	t.Helper()
	for range 300 {
		f.mu.Lock()
		if len(f.responses) >= n {
			r := f.responses[n-1]
			f.mu.Unlock()
			return r
		}
		f.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no Slack response #%d", n)
	return ""
}

func (f *fakeSlack) responseCount() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.responses) }

type fakeDirectory map[string]string

func (d fakeDirectory) MemberRole(_ context.Context, _ string, email string) (string, error) {
	return d[strings.ToLower(email)], nil
}

func slackUserJSON(id, name, email string, extra map[string]any) map[string]any {
	u := map[string]any{"id": id, "team_id": "T1", "name": strings.ToLower(strings.Fields(name)[0]), "real_name": name,
		"profile": map[string]any{"email": email, "real_name": name, "display_name": ""}}
	for k, v := range extra {
		u[k] = v
	}
	return u
}

func TestSlackApprover(t *testing.T) {
	dbURL := testDatabaseURL(t)
	ctx := context.Background()
	st, err := store.Open(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	tenant := fmt.Sprintf("org:slack-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	const botToken, signing = "xoxb-1-2-abcdef", "8f742231b10e8888abcd99yyyzzz85a5"
	slack := &fakeSlack{token: botToken, users: map[string]map[string]any{
		"U_ADMIN":  slackUserJSON("U_ADMIN", "Sam Sec", "Sec@Acme.io", nil),
		"U_DEV":    slackUserJSON("U_DEV", "Dana Dev", "dev@acme.io", nil),
		"U_GUEST":  slackUserJSON("U_GUEST", "Gus Guest", "gus@partner.io", map[string]any{"is_restricted": true}),
		"U_NOMAIL": slackUserJSON("U_NOMAIL", "No Mail", "", nil),
		"U_EVE":    slackUserJSON("U_EVE", "<!channel> Eve", "eve@acme.io", nil),
	}}
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, ConsoleOrigin: "https://app.example", SlackEnabled: true,
		Notify:    &notify.Sender{HTTP: &http.Client{Transport: slack}, SlackAPIBase: "https://slack.test/api"},
		Directory: fakeDirectory{"sec@acme.io": "security_admin", "dev@acme.io": "member", "eve@acme.io": "admin"}}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	s.PublicBaseURL = srv.URL

	call := func(method, path, bearer string, body any, out any) int {
		t.Helper()
		var rd io.Reader = http.NoBody
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, srv.URL+path, rd)
		if bearer == "" {
			req.Header.Set("Authorization", "Bearer t0ken")
			req.Header.Set("X-Effigent-Tenant", tenant)
		} else {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if out != nil && res.StatusCode < 300 {
			_ = json.NewDecoder(res.Body).Decode(out)
		}
		return res.StatusCode
	}

	// ---- connecting ----
	connect := map[string]any{"bot_token": botToken, "signing_secret": signing, "channel": "C0SECURITY"}
	s.SlackEnabled = false // email only: Slack can't be connected
	if code := call("PUT", "/api/v1/notifications/slack-app", "", connect, nil); code != http.StatusServiceUnavailable {
		t.Fatalf("connect with Slack off: %d", code)
	}
	if code := call("PUT", "/api/v1/notifications", "", map[string]any{"slack_webhook": "https://hooks.slack.com/services/T/B/x"}, nil); code != 400 {
		t.Fatalf("webhook with Slack off: %d", code)
	}
	s.SlackEnabled = true
	if code := call("PUT", "/api/v1/notifications/slack-app", "", connect, nil); code != http.StatusServiceUnavailable {
		t.Fatalf("connect without EFFIGENT_SECRETS_KEY: %d", code)
	}
	s.SecretsKey, _ = SecretsKeyFrom(strings.Repeat("k", 40))
	if code := call("PUT", "/api/v1/notifications/slack-app", "", map[string]any{"bot_token": botToken, "signing_secret": signing, "channel": "#security"}, nil); code != 400 {
		t.Fatalf("channel name accepted: %d", code)
	}
	if code := call("PUT", "/api/v1/notifications/slack-app", "", map[string]any{"bot_token": botToken, "signing_secret": signing, "channel": "C0ELSEWHERE"}, nil); code != 400 {
		t.Fatalf("channel the bot can't post to accepted: %d", code)
	}
	if code := call("PUT", "/api/v1/notifications/slack-app", "", map[string]any{"bot_token": "xoxb-wrong", "signing_secret": signing, "channel": "C0SECURITY"}, nil); code != 400 {
		t.Fatalf("bad token accepted: %d", code)
	}
	var nv notificationView
	if code := call("PUT", "/api/v1/notifications/slack-app", "", connect, &nv); code != 200 || !nv.SlackApp.Connected || nv.SlackApp.TeamName != "Acme" || nv.SlackApp.Approvers != "members" {
		t.Fatalf("connect: %d %+v", code, nv.SlackApp)
	}
	// changing only the channel keeps the stored token and secret, and proves the new channel works
	slack.mu.Lock()
	posted := len(slack.posts)
	slack.mu.Unlock()
	if code := call("PUT", "/api/v1/notifications/slack-app", "", map[string]any{"channel": "C0SECOPS"}, &nv); code != 200 || nv.SlackApp.Channel != "C0SECOPS" || len(slack.posts) != posted+1 {
		t.Fatalf("channel change: %d %+v, posts %d→%d", code, nv.SlackApp, posted, len(slack.posts))
	}
	// editing email recipients leaves the Slack app connected
	if code := call("PUT", "/api/v1/notifications", "", map[string]any{"emails": []string{"sec@acme.io"}}, &nv); code != 200 || !nv.SlackApp.Connected || nv.SlackApp.Channel != "C0SECOPS" {
		t.Fatalf("emails edit disconnected Slack: %d %+v", code, nv.SlackApp)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/notifications", nil)
	req.Header.Set("Authorization", "Bearer t0ken")
	req.Header.Set("X-Effigent-Tenant", tenant)
	res, _ := http.DefaultClient.Do(req)
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if strings.Contains(string(raw), botToken) || strings.Contains(string(raw), signing) {
		t.Fatalf("secrets returned by the API: %s", raw)
	}
	set, _ := st.GetNotificationSettings(ctx, tenant)
	if strings.Contains(set.SlackApp.BotTokenEnc, "xoxb") || strings.Contains(set.SlackApp.SigningSecretEnc, signing) || !strings.HasPrefix(set.SlackApp.BotTokenEnc, "v1:") {
		t.Fatalf("secrets not sealed: %+v", set.SlackApp)
	}
	if _, err := s.open("org:other", slackFieldToken, set.SlackApp.BotTokenEnc); err == nil {
		t.Fatal("a sealed token opened for another tenant")
	}

	// ---- a request goes out through the app, with interactive buttons ----
	var tok struct {
		Token struct{ Token string } `json:"token"`
	}
	call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
	var er EnrollResponse
	call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": "dana-mbp"}}, &er)
	ask := func(n int) endpointApprovalResp {
		var r endpointApprovalResp
		call("POST", "/ep/v1/approvals", er.Secret, map[string]any{"fingerprint": "fp1:" + strings.Repeat(fmt.Sprintf("%02x", n), 32), "agent": "claude-code",
			"tool": "Bash", "summary": fmt.Sprintf("Bash: git push origin release-%d", n), "rule": "command_approve", "reason": "needs approval"}, &r)
		return r
	}
	r1 := ask(1)
	slack.mu.Lock()
	post := slack.posts[len(slack.posts)-1]
	slack.mu.Unlock()
	var msg struct {
		Blocks []struct {
			Elements []struct {
				ActionID string `json:"action_id"`
				Value    string `json:"value"`
				URL      string `json:"url"`
			} `json:"elements"`
		} `json:"blocks"`
	}
	_ = json.Unmarshal([]byte(post), &msg)
	var value string
	for _, b := range msg.Blocks {
		for _, e := range b.Elements {
			if e.ActionID == "approve" {
				value = e.Value
			}
			if e.URL != "" && strings.Contains(e.URL, "/a/") {
				t.Fatalf("Slack app message carries a link that decides: %s", post)
			}
		}
	}
	if len(r1.Notified) != 1 || value == "" || !strings.Contains(post, "release-1") {
		t.Fatalf("request message: notified %v, %s", r1.Notified, post)
	}

	// ---- clicks ----
	type click struct {
		user, action, value, team, secret string
		at                                time.Time
	}
	n := 0
	send := func(c click) int {
		t.Helper()
		if c.team == "" {
			c.team = "T1"
		}
		if c.secret == "" {
			c.secret = signing
		}
		if c.at.IsZero() {
			c.at = time.Now()
		}
		n++
		payload, _ := json.Marshal(map[string]any{"type": "block_actions", "team": map[string]any{"id": c.team}, "user": map[string]any{"id": c.user, "team_id": c.team},
			"response_url": fmt.Sprintf("https://hooks.slack.com/actions/T1/%d/xyz", n), "actions": []map[string]any{{"action_id": c.action, "value": c.value}}})
		body := url.Values{"payload": {string(payload)}}.Encode()
		ts := fmt.Sprint(c.at.Unix())
		mac := hmac.New(sha256.New, []byte(c.secret))
		mac.Write([]byte("v0:" + ts + ":" + body))
		req, _ := http.NewRequest("POST", srv.URL+"/slack/interactions", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("X-Slack-Request-Timestamp", ts)
		req.Header.Set("X-Slack-Signature", "v0="+hex.EncodeToString(mac.Sum(nil)))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	state := func(id string) store.Approval {
		var a store.Approval
		call("GET", "/api/v1/approvals/"+id, "", nil, &a)
		return a
	}

	if code := send(click{user: "U_ADMIN", action: "approve", value: value, secret: "wrong-secret-wrong-secret"}); code != 401 {
		t.Fatalf("bad signature: %d", code)
	}
	if code := send(click{user: "U_ADMIN", action: "approve", value: value, at: time.Now().Add(-6 * time.Minute)}); code != 401 {
		t.Fatalf("stale timestamp: %d", code)
	}
	if code := send(click{user: "U_ADMIN", action: "approve", value: value, team: "T2"}); code != 403 {
		t.Fatalf("other workspace: %d", code)
	}
	if code := send(click{user: "U_ADMIN", action: "approve", value: value[:len(value)-4] + "AAAA"}); code != 401 {
		t.Fatalf("tampered button value: %d", code)
	}
	emailTok := s.signLink(linkClaims{Approval: r1.ID, Tenant: tenant, Recipient: "T1", Channel: "email", Expires: time.Now().Add(time.Hour).Unix()})
	if code := send(click{user: "U_ADMIN", action: "approve", value: emailTok}); code != 401 {
		t.Fatalf("an email link's token used as a Slack button: %d", code)
	}
	before := slack.responseCount()
	if code := send(click{user: "U_ADMIN", action: "review", value: ""}); code != 200 {
		t.Fatalf("Review in Effigent click: %d", code)
	}
	if st := state(r1.ID); st.State != "pending" || slack.responseCount() != before {
		t.Fatalf("refused clicks decided or answered: %s, %d responses", st.State, slack.responseCount())
	}

	// a member who isn't an approver, a guest, someone without a visible email: refused, nothing decided
	for _, c := range []struct{ user, want string }{
		{"U_DEV", "only admins and security admins"},
		{"U_GUEST", "Guest accounts"},
		{"U_NOMAIL", "users:read.email"},
	} {
		before = slack.responseCount()
		if code := send(click{user: c.user, action: "approve", value: value}); code != 200 {
			t.Fatalf("%s click: %d", c.user, code)
		}
		if r := slack.waitResponse(t, before+1); !strings.Contains(r, c.want) || !strings.Contains(r, `"ephemeral"`) {
			t.Fatalf("%s: %s", c.user, r)
		}
		if st := state(r1.ID); st.State != "pending" {
			t.Fatalf("%s decided: %s", c.user, st.State)
		}
	}

	// the security admin approves: recorded with their Slack identity and email
	before = slack.responseCount()
	if code := send(click{user: "U_ADMIN", action: "approve", value: value}); code != 200 {
		t.Fatalf("approver click: %d", code)
	}
	upd := slack.waitResponse(t, before+1)
	if !strings.Contains(upd, `"replace_original":true`) || !strings.Contains(upd, "Approved") || !strings.Contains(upd, "Sam Sec (Sec@Acme.io)") || strings.Contains(upd, `"action_id":"approve"`) {
		t.Fatalf("message update: %s", upd)
	}
	a := state(r1.ID)
	if a.State != "approved" || a.DecidedBy != "slack:T1:U_ADMIN" || a.DecidedByName != "Sam Sec <Sec@Acme.io> (via Slack)" {
		t.Fatalf("decision: %s by %q %q", a.State, a.DecidedBy, a.DecidedByName)
	}
	var audit []store.AuditEntry
	call("GET", "/api/v1/audit?action=approval.approve", "", nil, &audit)
	if len(audit) != 1 || audit[0].Actor != "slack:T1:U_ADMIN" || audit[0].ActorVia != "slack" || audit[0].ActorRole != "security_admin" {
		t.Fatalf("audit: %+v", audit)
	}
	var det map[string]any
	_ = json.Unmarshal(audit[0].Details, &det)
	if det["slack_user_id"] != "U_ADMIN" || det["slack_team_id"] != "T1" || det["slack_username"] != "sam" || det["email"] != "Sec@Acme.io" || det["via"] != "slack" {
		t.Fatalf("audit details: %v", det)
	}
	if r := ask(1); r.State != "approved" || r.DecidedByName != "Sam Sec <Sec@Acme.io> (via Slack)" {
		t.Fatalf("agent sees: %+v", r)
	}

	// a second click: already decided
	before = slack.responseCount()
	send(click{user: "U_ADMIN", action: "deny", value: value})
	if r := slack.waitResponse(t, before+2); !strings.Contains(r, "already approved (and used) by Sam Sec \\u0026lt;Sec@Acme.io\\u0026gt; (via Slack)") {
		t.Fatalf("second click: %s", r)
	}

	// names from Slack profiles are escaped: "<!channel>" in a name pings nobody
	r4 := ask(4)
	tok4 := s.slackActions(store.Approval{ID: r4.ID, Tenant: tenant, ExpiresAt: r4.ExpiresAt}, "T1")[0].Value
	before = slack.responseCount()
	send(click{user: "U_EVE", action: "approve", value: tok4})
	if r := slack.waitResponse(t, before+1); (strings.Contains(r, "<!channel>") || strings.Contains(r, `\u003c!channel`)) || !strings.Contains(r, "\\u0026lt;!channel\\u0026gt; Eve") {
		t.Fatalf("unescaped name in the update: %s", r)
	}
	before = slack.responseCount()
	send(click{user: "U_ADMIN", action: "approve", value: tok4})
	if r := slack.waitResponse(t, before+2); (strings.Contains(r, "<!channel>") || strings.Contains(r, `\u003c!channel`)) || !strings.Contains(r, "already approved by \\u0026lt;!channel\\u0026gt; Eve") {
		t.Fatalf("unescaped name in the ephemeral answer: %s", r)
	}

	// an expired request is refused
	r2 := ask(2)
	_, _ = conn.Exec(ctx, `update cp.approvals set expires_at = now() - interval '1 minute' where id = $1`, r2.ID)
	tok2 := s.signLink(linkClaims{Approval: r2.ID, Tenant: tenant, Recipient: "T1", Channel: slackChannelApp, Expires: time.Now().Add(-time.Minute).Unix()})
	before = slack.responseCount()
	send(click{user: "U_ADMIN", action: "approve", value: tok2})
	if r := slack.waitResponse(t, before+2); !strings.Contains(r, "expired") {
		t.Fatalf("expired: %s", r)
	}
	if st := state(r2.ID); st.State == "approved" {
		t.Fatal("expired request approved")
	}

	// without a directory, "members" mode refuses; "workspace" mode lets any member decide
	s.Directory = nil
	r3 := ask(3)
	tok3 := s.slackActions(store.Approval{ID: r3.ID, Tenant: tenant, ExpiresAt: r3.ExpiresAt}, "T1")[0].Value
	before = slack.responseCount()
	send(click{user: "U_DEV", action: "deny", value: tok3})
	if r := slack.waitResponse(t, before+1); !strings.Contains(r, "CLERK_SECRET_KEY") {
		t.Fatalf("no directory: %s", r)
	}
	if code := call("PUT", "/api/v1/notifications/slack-app", "", map[string]any{"approvers": "workspace"}, &nv); code != 200 || nv.SlackApp.Approvers != "workspace" {
		t.Fatalf("approvers setting: %d %+v", code, nv.SlackApp)
	}
	before = slack.responseCount()
	send(click{user: "U_DEV", action: "deny", value: tok3})
	slack.waitResponse(t, before+1)
	if a := state(r3.ID); a.State != "denied" || a.DecidedBy != "slack:T1:U_DEV" {
		t.Fatalf("workspace mode: %s %s", a.State, a.DecidedBy)
	}

	// the sample message's buttons answer without deciding anything
	call("POST", "/api/v1/notifications/test", "", map[string]any{"sample": "approval"}, nil)
	sample := s.slackActions(store.Approval{ID: "apr_sample", Tenant: tenant, ExpiresAt: time.Now().Add(time.Hour)}, "T1")[0].Value
	before = slack.responseCount()
	send(click{user: "U_ADMIN", action: "approve", value: sample})
	if r := slack.waitResponse(t, before+1); !strings.Contains(r, "sample") {
		t.Fatalf("sample: %s", r)
	}

	// disconnecting: clicks are refused, the webhook (if any) takes over
	if code := call("DELETE", "/api/v1/notifications/slack-app", "", nil, &nv); code != 200 || nv.SlackApp.Connected {
		t.Fatalf("disconnect: %d", code)
	}
	if code := send(click{user: "U_ADMIN", action: "approve", value: value}); code != 401 {
		t.Fatalf("click after disconnect: %d", code)
	}
}
