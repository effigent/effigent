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
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// slackRecorder stands in for hooks.slack.com.
type slackRecorder struct {
	mu    sync.Mutex
	posts []string
}

func (s *slackRecorder) RoundTrip(r *http.Request) (*http.Response, error) {
	b, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.posts = append(s.posts, r.URL.String()+" "+string(b))
	s.mu.Unlock()
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("ok")), Header: http.Header{}}, nil
}

func (s *slackRecorder) count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.posts) }

// TestApprovalFlow needs a throwaway Postgres database (see TestCentralPolicyEndToEnd).
func TestApprovalFlow(t *testing.T) {
	url := testDatabaseURL(t)
	ctx := context.Background()
	st, err := store.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	tenant := fmt.Sprintf("org:approvals-%d-%d", os.Getpid(), time.Now().UnixNano())
	auth, err := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	if err != nil {
		t.Fatal(err)
	}
	_, key, _ := ed25519.GenerateKey(nil)
	slack := &slackRecorder{}
	srv := httptest.NewServer((&Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, ConsoleOrigin: "https://app.example", SlackEnabled: true,
		Notify: &notify.Sender{HTTP: &http.Client{Transport: slack}}}).Handler())
	defer srv.Close()

	call := func(method, path, bearer string, body any, out any) int {
		t.Helper()
		b, _ := json.Marshal(body)
		if body == nil {
			b = nil
		}
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader(b))
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
			if err := json.NewDecoder(res.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return res.StatusCode
	}
	enroll := func(host string) string {
		var tok struct {
			Token struct{ Token string } `json:"token"`
		}
		call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
		var er EnrollResponse
		if code := call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": host}}, &er); code != 200 {
			t.Fatalf("enroll: %d", code)
		}
		return er.Secret
	}
	laptop, other := enroll("dana-mbp"), enroll("ci-box")

	// ---- notification settings ----
	if code := call("PUT", "/api/v1/notifications", "", map[string]any{"slack_webhook": "http://169.254.169.254/latest"}, nil); code != 400 {
		t.Fatalf("non-Slack webhook accepted: %d", code)
	}
	if code := call("PUT", "/api/v1/notifications", "", map[string]any{"emails": []string{"not an email"}}, nil); code != 400 {
		t.Fatalf("bad email accepted: %d", code)
	}
	var nv notificationView
	if code := call("PUT", "/api/v1/notifications", "", map[string]any{"slack_webhook": "https://hooks.slack.com/services/T0/B0/secretXYZ1"}, &nv); code != 200 {
		t.Fatalf("put notifications: %d", code)
	}
	raw, _ := json.Marshal(nv)
	if !nv.SlackWebhookSet || nv.SlackWebhookHint != "…XYZ1" || strings.Contains(string(raw), "secretXYZ1") {
		t.Fatalf("webhook must be set and never returned: %s", raw)
	}

	fp := func(n int) string { return "fp1:" + fmt.Sprintf("%064x", n) }
	ask := func(secret string, n, wait int) endpointApprovalResp {
		t.Helper()
		var r endpointApprovalResp
		if code := call("POST", "/ep/v1/approvals", secret, map[string]any{"fingerprint": fp(n), "agent": "claude-code",
			"session_id": "s1", "tool": "Bash", "summary": "Bash: git push --force origin main", "rule": "command_approve",
			"reason": "`git push --force origin main` needs approval", "os_user": "dana", "wait_seconds": wait}, &r); code != 200 {
			t.Fatalf("approval request: %d", code)
		}
		return r
	}
	decide := func(id, decision, note string) int {
		t.Helper()
		return call("POST", "/api/v1/approvals/"+id+"/decision", "", map[string]any{"decision": decision, "note": note, "name": "Sam Sec"}, nil)
	}

	// ---- first request: pending, Slack notified once ----
	r1 := ask(laptop, 1, 0)
	if r1.State != "pending" || !r1.Created || len(r1.Notified) != 1 || slack.count() != 1 {
		t.Fatalf("first request: %+v, slack posts %d", r1, slack.count())
	}
	if p := slack.posts[0]; !strings.Contains(p, "git push --force origin main") || !strings.Contains(p, "https://app.example/approvals?id="+r1.ID) ||
		!strings.Contains(p, "dana on dana-mbp") {
		t.Fatalf("slack message: %s", p)
	}
	// retry of the same call: same request, no new notification
	if r := ask(laptop, 1, 0); r.ID != r1.ID || r.Created || slack.count() != 1 {
		t.Fatalf("retry: %+v, slack posts %d", r, slack.count())
	}
	// another machine with the same fingerprint gets its own request
	if r := ask(other, 1, 0); r.ID == r1.ID || !r.Created {
		t.Fatalf("other machine: %+v", r)
	}

	var pending []store.Approval
	call("GET", "/api/v1/approvals?state=pending", "", nil, &pending)
	if len(pending) != 2 {
		t.Fatalf("pending: %d", len(pending))
	}

	// ---- approve: the next call consumes it, the one after asks again ----
	if code := decide(r1.ID, "approve", "ok for the release"); code != 200 {
		t.Fatalf("approve: %d", code)
	}
	if code := decide(r1.ID, "deny", ""); code != 409 {
		t.Fatalf("second decision: %d", code)
	}
	if r := ask(laptop, 1, 0); r.State != "approved" || r.ID != r1.ID || r.DecidedByName != "Sam Sec" || r.Note != "ok for the release" {
		t.Fatalf("after approval: %+v", r)
	}
	if r := ask(laptop, 1, 0); r.State != "pending" || !r.Created || r.ID == r1.ID {
		t.Fatalf("approval must be single-use: %+v", r)
	}

	// ---- long poll: the endpoint waits, the approver decides meanwhile ----
	done := make(chan endpointApprovalResp)
	go func() { done <- ask(laptop, 2, 10) }()
	var id string
	for i := 0; i < 50 && id == ""; i++ {
		time.Sleep(100 * time.Millisecond)
		var ps []store.Approval
		call("GET", "/api/v1/approvals?state=pending", "", nil, &ps)
		for _, p := range ps {
			if p.Fingerprint == fp(2) {
				id = p.ID
			}
		}
	}
	start := time.Now()
	if code := decide(id, "approve", ""); code != 200 {
		t.Fatalf("approve while waiting: %d", code)
	}
	if r := <-done; r.State != "approved" || time.Since(start) > 3*time.Second {
		t.Fatalf("long poll: %+v after %s", r, time.Since(start))
	}

	// ---- the same call twice at once: one request, both answered ----
	var wg sync.WaitGroup
	res := make([]endpointApprovalResp, 8)
	for i := range res {
		wg.Add(1)
		go func(i int) { defer wg.Done(); res[i] = ask(laptop, 9, 0) }(i)
	}
	wg.Wait()
	for _, r := range res {
		if r.ID != res[0].ID || r.State != "pending" {
			t.Fatalf("concurrent requests: %+v vs %+v", r, res[0])
		}
	}

	// ---- deny: retries are refused without asking again ----
	r3 := ask(laptop, 3, 0)
	posts := slack.count()
	if code := decide(r3.ID, "deny", "not on a Friday"); code != 200 {
		t.Fatalf("deny: %d", code)
	}
	if r := ask(laptop, 3, 0); r.State != "denied" || r.ID != r3.ID || r.Note != "not on a Friday" || slack.count() != posts {
		t.Fatalf("after deny: %+v", r)
	}

	// ---- an endpoint can't use the console API; a viewer-less admin token can't approve for another tenant ----
	if code := call("GET", "/api/v1/approvals", laptop, nil, nil); code != 401 {
		t.Fatalf("endpoint secret on console API: %d", code)
	}

	// ---- audit trail ----
	var audit []store.AuditEntry
	call("GET", "/api/v1/audit?limit=100", "", nil, &audit)
	seen := map[string]int{}
	for _, e := range audit {
		seen[e.Action]++
	}
	if seen["approval.request"] < 5 || seen["approval.approve"] != 2 || seen["approval.deny"] != 1 || seen["notifications.update"] != 1 {
		t.Fatalf("audit: %v", seen)
	}
}
