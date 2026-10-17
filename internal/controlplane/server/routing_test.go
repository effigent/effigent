package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

var testRouting = store.RoutingConfig{
	Groups: []store.ApproverGroup{
		{ID: "sec", Name: "Security", Members: []store.GroupMember{{UserID: "user_ciso", Email: "ciso@acme.io", Name: "Cleo CISO"}}},
		{ID: "ops", Name: "DevOps", Members: []store.GroupMember{{UserID: "user_dev", Email: "dev@acme.io", Name: "Dev One"}, {UserID: "user_ops", Email: "ops@acme.io"}}},
	},
	Routes: []store.ApprovalRoute{
		{ID: "r-aws", Name: "AWS", Patterns: []string{"aws ", "*amazonaws.com*"}, GroupID: "ops"},
		{ID: "r-curl", Name: "curl", Kinds: []string{"command"}, Patterns: []string{"curl*"}, GroupID: "sec"},
		{ID: "r-mcp", Name: "GitHub MCP on build boxes", Kinds: []string{"tool"}, Machines: []string{"build-1"}, GroupID: "ops"},
	},
	DefaultGroup: "sec",
}

func TestRouteFor(t *testing.T) {
	cases := []struct {
		a           store.Approval
		route, grp string
	}{
		{store.Approval{Rule: "command_approve", Summary: "Bash: aws s3 cp x s3://y"}, "r-aws", "ops"},
		{store.Approval{Rule: "domain_approve", Summary: "WebFetch: https://s3.amazonaws.com/b", Reason: "`s3.amazonaws.com` needs approval"}, "r-aws", "ops"},
		{store.Approval{Rule: "command_approve", Summary: "Bash: CURL -X POST https://pastebin.com"}, "r-curl", "sec"},
		{store.Approval{Rule: "domain_approve", Summary: "WebFetch: https://x.io/curl"}, "", "sec"}, // curl rule is for commands only: default
		{store.Approval{Rule: "tool_approve", Summary: "mcp__github__merge", Hostname: "BUILD-1"}, "r-mcp", "ops"},
		{store.Approval{Rule: "tool_approve", Summary: "mcp__github__merge", Hostname: "dana-mbp"}, "", "sec"},
		{store.Approval{Rule: "command_approve", Summary: "Bash: git push"}, "", "sec"},
	}
	for _, c := range cases {
		route, g := routeFor(testRouting, c.a)
		gotRoute := ""
		if route != nil {
			gotRoute = route.ID
		}
		if gotRoute != c.route || g == nil || g.ID != c.grp {
			t.Errorf("%q: route %q group %v, want %q %q", c.a.Summary, gotRoute, g, c.route, c.grp)
		}
	}
	// no rules, no default: workspace admins (no group)
	if _, g := routeFor(store.RoutingConfig{}, store.Approval{Summary: "Bash: aws s3 ls"}); g != nil {
		t.Fatalf("empty routing gave group %v", g)
	}
}

func TestCanDecide(t *testing.T) {
	routed := store.Approval{GroupID: "ops"}
	cases := []struct {
		name               string
		p                  Principal
		a                  store.Approval
		ok, override, memb bool
	}{
		{"group member (plain member role)", Principal{UserID: "user_dev", Role: "member", Via: "clerk"}, routed, true, false, true},
		{"member of another group", Principal{UserID: "user_ciso", Role: "member", Via: "clerk"}, routed, false, false, false},
		{"admin steps in", Principal{UserID: "user_boss", Role: "admin", Via: "clerk"}, routed, true, true, false},
		{"security admin steps in", Principal{UserID: "user_sa", Role: "security_admin", Via: "clerk"}, routed, true, true, false},
		{"API key with approvals scope", Principal{UserID: "apikey:1", Role: "api_key", Via: "api-key", Scopes: []string{"read", "approvals"}}, routed, true, false, false},
		{"API key without it", Principal{UserID: "apikey:2", Role: "api_key", Via: "api-key", Scopes: []string{"read"}}, routed, false, false, false},
		{"no group: admins as before", Principal{UserID: "user_boss", Role: "admin", Via: "clerk"}, store.Approval{}, true, false, false},
		{"no group: members can't", Principal{UserID: "user_dev", Role: "member", Via: "clerk"}, store.Approval{}, false, false, false},
		{"group deleted: admins", Principal{UserID: "user_dev", Role: "member", Via: "clerk"}, store.Approval{GroupID: "gone"}, false, false, false},
	}
	for _, c := range cases {
		ok, override, m := canDecide(c.p, c.a, testRouting)
		if ok != c.ok || override != c.override || (m != nil) != c.memb {
			t.Errorf("%s: ok %v override %v member %v", c.name, ok, override, m)
		}
	}
}

func TestCleanRouting(t *testing.T) {
	bad := []store.RoutingConfig{
		{Groups: []store.ApproverGroup{{Name: ""}}},
		{Groups: []store.ApproverGroup{{Name: "A"}, {Name: "a"}}},
		{Groups: []store.ApproverGroup{{ID: "g", Name: "A"}}, Routes: []store.ApprovalRoute{{Name: "x", GroupID: "nope"}}},
		{Groups: []store.ApproverGroup{{ID: "g", Name: "A"}}, Routes: []store.ApprovalRoute{{Name: "x", GroupID: "g", Kinds: []string{"email"}}}},
		{Groups: []store.ApproverGroup{{ID: "g", Name: "A"}}, DefaultGroup: "nope"},
	}
	for i, c := range bad {
		if _, err := cleanRouting(c); err == nil {
			t.Errorf("bad config %d accepted", i)
		}
	}
	c, err := cleanRouting(store.RoutingConfig{Groups: []store.ApproverGroup{{Name: " Sec ", Members: []store.GroupMember{{UserID: "u1", Email: "not an email"}, {UserID: "u1"}, {UserID: ""}}}}})
	if err != nil || c.Groups[0].ID == "" || c.Groups[0].Name != "Sec" || len(c.Groups[0].Members) != 1 || c.Groups[0].Members[0].Email != "" {
		t.Fatalf("clean: %+v %v", c, err)
	}
}

// smtpSink accepts any number of connections and records RCPT TO addresses.
type smtpSink struct {
	mu    sync.Mutex
	rcpts []string
}

func (s *smtpSink) start(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				say := func(x string) { c.Write([]byte(x + "\r\n")) }
				say("220 sink")
				inData := false
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if inData {
						if line == ".\r\n" {
							inData = false
							say("250 queued")
						}
						continue
					}
					f := strings.Fields(line)
					if len(f) == 0 {
						continue
					}
					switch strings.ToUpper(f[0]) {
					case "EHLO", "HELO":
						say("250-sink\r\n250 AUTH PLAIN")
					case "AUTH":
						say("235 ok")
					case "RCPT":
						addr := strings.Trim(strings.TrimPrefix(strings.ToUpper(line[:5])+line[5:], "RCPT TO:"), "<>\r\n ")
						if i := strings.Index(strings.ToLower(line), "to:"); i >= 0 {
							addr = strings.Trim(line[i+3:], "<>\r\n ")
						}
						s.mu.Lock()
						s.rcpts = append(s.rcpts, strings.ToLower(addr))
						s.mu.Unlock()
						say("250 ok")
					case "DATA":
						inData = true
						say("354 go")
					case "QUIT":
						say("221 bye")
						return
					default:
						say("250 ok")
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String()
}

func (s *smtpSink) take() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.rcpts
	s.rcpts = nil
	slices.Sort(out)
	return out
}

// TestApprovalRouting needs a throwaway Postgres database (see TestCentralPolicyEndToEnd).
func TestApprovalRouting(t *testing.T) {
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
	tenant := fmt.Sprintf("org:routing-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	sink := &smtpSink{}
	addr := sink.start(t)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, ConsoleOrigin: "https://app.example",
		Notify: &notify.Sender{SMTPURL: "smtp://u:p@" + addr, From: "Effigent <approvals@effigent.ai>"}}
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

	// the workspace's general list: used only when nothing is routed
	call("PUT", "/api/v1/notifications", "", map[string]any{"emails": []string{"everyone@acme.io"}}, nil)
	bad := testRouting
	bad.DefaultGroup = "nope"
	if code := call("PUT", "/api/v1/approval-routing", "", bad, nil); code != 400 {
		t.Fatalf("invalid routing accepted: %d", code)
	}
	var saved store.RoutingConfig
	if code := call("PUT", "/api/v1/approval-routing", "", testRouting, &saved); code != 200 || len(saved.Routes) != 3 || saved.UpdatedBy == "" {
		t.Fatalf("save routing: %d %+v", code, saved)
	}
	var tr map[string]any
	call("POST", "/api/v1/approval-routing/test", "", map[string]any{"summary": "Bash: curl https://x.io"}, &tr)
	if tr["group_name"] != "Security" || tr["route_name"] != "curl" {
		t.Fatalf("test curl: %v", tr)
	}
	call("POST", "/api/v1/approval-routing/test", "", map[string]any{"summary": "Bash: ls"}, &tr)
	if tr["group_name"] != "Security" || tr["default"] != true {
		t.Fatalf("test default: %v", tr)
	}
	// unsaved edits can be tried before saving
	call("POST", "/api/v1/approval-routing/test", "", map[string]any{"summary": "Bash: ls", "config": store.RoutingConfig{Groups: testRouting.Groups, DefaultGroup: "ops"}}, &tr)
	if tr["group_name"] != "DevOps" {
		t.Fatalf("test with draft config: %v", tr)
	}

	var tok struct {
		Token struct{ Token string } `json:"token"`
	}
	call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
	var er EnrollResponse
	call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": "dana-mbp"}}, &er)
	ask := func(n int, summary string) endpointApprovalResp {
		var r endpointApprovalResp
		call("POST", "/ep/v1/approvals", er.Secret, map[string]any{"fingerprint": "fp1:" + strings.Repeat(fmt.Sprintf("%02x", n), 32), "agent": "claude-code",
			"tool": "Bash", "summary": summary, "rule": "command_approve", "reason": "needs approval"}, &r)
		return r
	}

	// an AWS command goes to DevOps: only its members are emailed
	r1 := ask(1, "Bash: aws s3 rm s3://prod --recursive")
	if got := sink.take(); !slices.Equal(got, []string{"dev@acme.io", "ops@acme.io"}) {
		t.Fatalf("emailed %v, want DevOps only", got)
	}
	// the same call again reuses the request: not re-routed, not re-sent
	if r := ask(1, "Bash: aws s3 rm s3://prod --recursive"); r.ID != r1.ID || len(sink.take()) != 0 {
		t.Fatalf("retry re-sent: %+v", r)
	}
	type view struct {
		store.Approval
		GroupName        string `json:"group_name"`
		CanDecide        bool   `json:"can_decide"`
		DecideIsOverride bool   `json:"decide_is_override"`
	}
	var list []view
	call("GET", "/api/v1/approvals?state=pending", "", nil, &list)
	if len(list) != 1 || list[0].GroupName != "DevOps" || list[0].RouteID != "r-aws" || !list[0].CanDecide || !list[0].DecideIsOverride {
		t.Fatalf("list view: %+v", list)
	}
	// an admin steps in: decided, and recorded as an override
	var dec store.Approval
	if code := call("POST", "/api/v1/approvals/"+r1.ID+"/decision", "", map[string]any{"decision": "approve", "name": "Boss"}, &dec); code != 200 ||
		!strings.Contains(dec.DecidedByName, "(admin, for DevOps)") {
		t.Fatalf("admin override: %d %+v", code, dec)
	}
	var audit []store.AuditEntry
	call("GET", "/api/v1/audit?action=approval.approve", "", nil, &audit)
	var det map[string]any
	_ = json.Unmarshal(audit[0].Details, &det)
	if det["admin_override"] != true || det["group"] != "DevOps" {
		t.Fatalf("audit: %v", det)
	}

	// nothing matches and no default: the general list, as before routing
	noDefault := testRouting
	noDefault.DefaultGroup = ""
	call("PUT", "/api/v1/approval-routing", "", noDefault, nil)
	sink.take()
	r2 := ask(2, "Bash: git push origin main")
	if got := sink.take(); !slices.Equal(got, []string{"everyone@acme.io"}) {
		t.Fatalf("unrouted emailed %v", got)
	}
	call("GET", "/api/v1/approvals?state=pending", "", nil, &list)
	if len(list) != 1 || list[0].ID != r2.ID || list[0].GroupID != "" || list[0].DecideIsOverride {
		t.Fatalf("unrouted view: %+v", list)
	}

	// email buttons: a DevOps member's link decides; after they leave the group it doesn't
	r3 := ask(3, "Bash: terraform apply -target aws_s3_bucket.x")
	sink.take()
	a3, _ := st.GetApproval(ctx, tenant, r3.ID)
	if a3.GroupID != "ops" {
		t.Fatalf("r3 routed to %q", a3.GroupID)
	}
	link := func(email string) string {
		acts := s.approvalActions(a3, email, "email")
		u, _ := url.Parse(acts[0].URL)
		return srv.URL + u.Path
	}
	devLink, opsLink := link("dev@acme.io"), link("ops@acme.io")
	removed := noDefault
	removed.Groups = []store.ApproverGroup{testRouting.Groups[0], {ID: "ops", Name: "DevOps", Members: []store.GroupMember{{UserID: "user_dev", Email: "dev@acme.io", Name: "Dev One"}}}}
	call("PUT", "/api/v1/approval-routing", "", removed, nil)
	res, _ := http.PostForm(opsLink, url.Values{"decision": {"approve"}})
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 403 || !strings.Contains(string(body), "no longer in that group") {
		t.Fatalf("removed member's link: %d %s", res.StatusCode, body)
	}
	res, _ = http.PostForm(devLink, url.Values{"decision": {"deny"}, "note": {"use the pipeline"}})
	res.Body.Close()
	if a, _ := st.GetApproval(ctx, tenant, r3.ID); a.State != "denied" || a.DecidedByName != "Dev One <dev@acme.io> (via email)" {
		t.Fatalf("member's link: %s by %q", a.State, a.DecidedByName)
	}
}
