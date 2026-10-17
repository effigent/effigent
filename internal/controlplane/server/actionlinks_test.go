package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

func TestApprovalLinks(t *testing.T) {
	dbURL := os.Getenv("EFFIGENT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("EFFIGENT_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	st, err := store.Open(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	tenant := fmt.Sprintf("org:links-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	slack := &slackRecorder{}
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, Notify: &notify.Sender{HTTP: &http.Client{Transport: slack}}}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	s.PublicBaseURL, s.ConsoleOrigin = srv.URL, "https://app.example"

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
	page := func(method, u string, form url.Values) (int, string) {
		t.Helper()
		var res *http.Response
		if method == "POST" {
			res, err = http.PostForm(u, form)
		} else {
			res, err = http.Get(u)
		}
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}

	call("PUT", "/api/v1/notifications", "", map[string]any{"slack_webhook": "https://hooks.slack.com/services/T/B/x"}, nil)
	var tok struct {
		Token struct{ Token string } `json:"token"`
	}
	call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
	var er EnrollResponse
	call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": "dana-mbp"}}, &er)
	ask := func() endpointApprovalResp {
		var r endpointApprovalResp
		call("POST", "/ep/v1/approvals", er.Secret, map[string]any{"fingerprint": "fp1:" + strings.Repeat("cd", 32), "agent": "claude-code",
			"tool": "Bash", "summary": "Bash: git push --force origin main", "rule": "command_approve", "reason": "needs approval"}, &r)
		return r
	}
	r1 := ask()
	if slack.count() != 1 {
		t.Fatalf("slack posts: %d", slack.count())
	}
	// a webhook message has no buttons that decide: nobody could tell who clicked
	if strings.Contains(slack.posts[0], "/a/") || !strings.Contains(slack.posts[0], "Review in Effigent") {
		t.Fatalf("webhook message must not carry decide links: %s", slack.posts[0])
	}
	// links that webhook messages used to carry are refused
	oldSlack := s.signLink(linkClaims{Approval: r1.ID, Tenant: tenant, Recipient: "slack", Channel: "slack", Expires: time.Now().Add(time.Hour).Unix()})
	if code, body := page("POST", srv.URL+"/a/"+oldSlack, url.Values{"decision": {"approve"}}); code != 403 || !strings.Contains(body, "Decide in Effigent") {
		t.Fatalf("old Slack link: %d %s", code, body)
	}
	var pending store.Approval
	call("GET", "/api/v1/approvals/"+r1.ID, "", nil, &pending)
	pending.Tenant = tenant // not in the API view
	acts := s.approvalActions(pending, "dana@example.io", "email")
	links := regexp.MustCompile(`^(http[^"]+/a/[^"?]+)\?d=(approve|deny)$`).FindStringSubmatch(acts[0].URL)
	if len(acts) != 2 || links == nil || links[2] != "approve" {
		t.Fatalf("email buttons: %+v", acts)
	}
	link := links[1]

	// opening the link only shows the confirmation page
	if code, body := page("GET", link+"?d=deny", nil); code != 200 || !strings.Contains(body, "Approve once") || !strings.Contains(body, "git push --force origin main") {
		t.Fatalf("GET page: %d %s", code, body)
	}
	var a store.Approval
	call("GET", "/api/v1/approvals/"+r1.ID, "", nil, &a)
	if a.State != "pending" {
		t.Fatalf("GET must not decide: %s", a.State)
	}
	// a tampered link is refused
	if code, _ := page("GET", link[:len(link)-3]+"AAA", nil); code != 403 {
		t.Fatalf("tampered link: %d", code)
	}
	// deny with a note: the agent's next ask sees it
	if code, body := page("POST", link, url.Values{"decision": {"deny"}, "note": {"use a PR"}}); code != 200 || !strings.Contains(body, "Denied") {
		t.Fatalf("POST deny: %d %s", code, body)
	}
	if r := ask(); r.State != "denied" || r.Note != "use a PR" || r.DecidedByName != "dana@example.io (via email)" {
		t.Fatalf("after link deny: %+v", r)
	}
	if code, body := page("POST", link, url.Values{"decision": {"approve"}}); code != 200 || !strings.Contains(body, "Already decided") {
		t.Fatalf("second decision: %d %s", code, body)
	}
	// an expired link is refused
	old := s.signLink(linkClaims{Approval: r1.ID, Tenant: tenant, Recipient: "x@y.io", Channel: "email", Expires: time.Now().Add(-time.Minute).Unix()})
	if code, body := page("GET", srv.URL+"/a/"+old, nil); code != 403 || !strings.Contains(body, "expired") {
		t.Fatalf("expired link: %d %s", code, body)
	}
}
