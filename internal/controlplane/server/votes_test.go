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
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
)

func TestVoteRefusal(t *testing.T) {
	dana := store.Requester{UserIDs: []string{"user_dana"}, Emails: []string{"dana@acme.io"}, Label: "dana@acme.io"}
	ann := approver{Voter: "user_ann", UserID: "user_ann", Emails: []string{"ann@acme.io"}, Person: true}
	danaConsole := approver{Voter: "user_dana", UserID: "user_dana", Person: true}
	danaEmail := approver{Voter: "link:email:dana@acme.io", Emails: []string{"dana@acme.io"}, Person: true} // the link only knows the address
	key := approver{Voter: "apikey:k1", Via: "api-key"}
	adminToken := approver{Voter: "admin", Via: "admin-token"}
	idOnly := approver{Voter: "user_ann", UserID: "user_ann", Person: true}                               // no directory, in no group
	emailOnly := approver{Voter: "link:email:ann@acme.io", Emails: []string{"ann@acme.io"}, Person: true} // a link, ann not in any group
	one := store.Approval{ApprovalsRequired: 1, ExcludeRequester: true}
	two := store.Approval{ApprovalsRequired: 2, ExcludeRequester: true}
	voted := two
	voted.Votes = []store.Vote{{Voter: "link:email:ann@acme.io", UserID: "user_ann", Decision: "approve"}}
	ticket := one
	ticket.RequireTicket = true
	selfOK := one
	selfOK.ExcludeRequester = false
	for _, c := range []struct {
		name    string
		a       store.Approval
		who     approver
		approve bool
		ticket  string
		want    string
	}{
		{"another person approves", one, ann, true, "", ""},
		{"the requester, by user id", one, danaConsole, true, "", refuseSelf},
		{"the requester, by email (an admin too: roles don't matter)", one, danaEmail, true, "", refuseSelf},
		{"the requester may deny", one, danaConsole, false, "", ""},
		{"requester allowed by the rule", selfOK, danaConsole, true, "", ""},
		{"an API key never approves", one, key, true, "", refuseNotPerson},
		{"the admin token never approves", one, adminToken, true, "", refuseNotPerson},
		{"not even where the requester may approve", selfOK, key, true, "", refuseNotPerson},
		{"an API key can't be one of two people", two, key, true, "", refuseNotPerson},
		{"an API key may still deny", one, key, false, "", ""},
		{"the admin token may still deny", two, adminToken, false, "", ""},
		{"same person through another channel", voted, ann, true, "", refuseVoted},
		{"same person can't deny after approving", voted, ann, false, "", refuseVoted},
		{"ticket missing", ticket, ann, true, "", refuseTicket},
		{"ticket given", ticket, ann, true, "SEC-1", ""},
		{"no ticket needed to deny", ticket, ann, false, "", ""},
	} {
		if got, _ := voteRefusal(c.a, dana, c.who, c.approve, c.ticket); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}

	// Who asked must be known, and comparable with the voter, before a
	// request that keeps its requester out can be approved.
	nobody := store.Requester{UserIDs: []string{}, Emails: []string{}, Label: "dana on build-7"}
	byEmail := store.Requester{Emails: []string{"dana@acme.io"}, Label: "dana@acme.io"}
	byID := store.Requester{UserIDs: []string{"user_dana"}, Label: "user_dana"}
	unknown := one
	unknown.Hostname, unknown.OSUser = "build-7", "dana"
	for _, c := range []struct {
		name string
		a    store.Approval
		q    store.Requester
		who  approver
		want string
	}{
		{"nobody known to have asked", unknown, nobody, ann, refuseUnknown},
		{"an admin override doesn't help either", unknown, nobody, approver{Voter: "user_boss", UserID: "user_boss", Emails: []string{"boss@acme.io"}, Person: true}, refuseUnknown},
		{"unknown, but the rule lets requesters approve", selfOK, nobody, ann, ""},
		{"unknown requester: deny still works", unknown, nobody, ann, ""}, // approve=false below
		{"requester by email, voter without one", one, byEmail, idOnly, refuseUnverified},
		{"requester by email, voter with another email", one, byEmail, emailOnly, ""},
		{"requester by user id, voter by email only", one, byID, emailOnly, refuseUnverified},
		{"requester by user id, voter another user", one, byID, idOnly, ""},
		{"requester by user id and voter is them", one, byID, danaConsole, refuseSelf},
		{"requester by email, rule lets requesters approve", selfOK, byEmail, idOnly, ""},
	} {
		approve := c.name != "unknown requester: deny still works"
		got, msg := voteRefusal(c.a, c.q, c.who, approve, "")
		if got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
		if got == refuseUnknown && (!strings.Contains(msg, "OS user dana on build-7") || !strings.Contains(msg, "People")) {
			t.Errorf("%s: message doesn't say why or what to do: %s", c.name, msg)
		}
	}
	if _, msg := voteRefusal(one, dana, key, true, ""); !strings.Contains(msg, "console") || !strings.Contains(msg, "deny") {
		t.Errorf("not_a_person message: %s", msg)
	}
}

func TestRequesterOf(t *testing.T) {
	people := []store.PersonRow{
		{Email: "dana@acme.io", Identities: []store.PersonIdentity{{Kind: spend.KindOSUser, Value: "dana@dana-mbp"}, {Kind: spend.KindEmail, Value: "dana@gmail.com"}}},
		{Email: "sam@acme.io", Identities: []store.PersonIdentity{{Kind: spend.KindHost, Value: "build-7"}}},
		{Email: "lee@acme.io", Identities: []store.PersonIdentity{{Kind: spend.KindGitEmail, Value: "lee@users.noreply.github.com"}}},
	}
	q := requesterOf("", "Dana-MBP", "dana", nil, people)
	if q.Label != "dana@acme.io" || !slices.Equal(q.Emails, []string{"dana@acme.io", "dana@gmail.com"}) {
		t.Fatalf("os user: %+v", q)
	}
	if !q.Matches("", []string{"Dana@Gmail.com"}) || q.Matches("user_x", []string{"ann@acme.io"}) {
		t.Fatal("matches")
	}
	if q := requesterOf("", "build-7", "ci", nil, people); q.Label != "sam@acme.io" {
		t.Fatalf("host: %+v", q)
	}
	if q := requesterOf("", "x", "lee", []string{"Lee@users.noreply.github.com"}, people); q.Label != "lee@acme.io" || !slices.Contains(q.Emails, "lee@users.noreply.github.com") {
		t.Fatalf("git email: %+v", q)
	}
	if q := requesterOf("user_owner", "x", "root", nil, people); !slices.Equal(q.UserIDs, []string{"user_owner"}) || q.Label != "user_owner" || !q.Matches("user_owner", nil) {
		t.Fatalf("owner id: %+v", q)
	}
	if q := requesterOf("Ann@Acme.io", "x", "", nil, people); !q.Matches("", []string{"ann@acme.io"}) {
		t.Fatalf("owner email: %+v", q)
	}
	if q := requesterOf("", "lonely", "bob", nil, people); len(q.Emails) != 0 || q.Label != "bob on lonely" || q.Matches("", []string{"bob@acme.io"}) {
		t.Fatalf("unmapped: %+v", q)
	}
}

func TestSamePerson(t *testing.T) {
	a := store.Vote{Voter: "link:email:ann@acme.io", UserID: "user_ann", Emails: []string{"ann@acme.io"}}
	for _, c := range []struct {
		o    store.Vote
		want bool
	}{
		{store.Vote{Voter: "user_ann", UserID: "user_ann"}, true},
		{store.Vote{Voter: "slack:T1:U1", Emails: []string{"ANN@acme.io"}}, true},
		{store.Vote{Voter: "user_bob", UserID: "user_bob", Emails: []string{"bob@acme.io"}}, false},
		{store.Vote{Voter: "apikey:k1"}, false},
	} {
		if got := a.SamePerson(c.o); got != c.want {
			t.Errorf("%+v: %v", c.o, got)
		}
	}
}

func TestQuorumWarnings(t *testing.T) {
	yes, no := true, false
	g := &store.ApproverGroup{ID: "sec", Name: "Security", Members: []store.GroupMember{{UserID: "u1", Email: "a@x.io"}, {UserID: "u2", Email: "b@x.io"}}}
	two := store.ApprovalRules{ApprovalsRequired: 2, ExcludeRequester: &yes}
	if w := quorumWarning(g, store.Requester{Emails: []string{"z@x.io"}}, two); w != "" {
		t.Fatalf("outsider requester: %q", w)
	}
	if w := quorumWarning(g, store.Requester{Emails: []string{"a@x.io"}}, two); !strings.Contains(w, "1 member(s)") || !strings.Contains(w, "requester is excluded") {
		t.Fatalf("member requester: %q", w)
	}
	if w := quorumWarning(g, store.Requester{Emails: []string{"a@x.io"}}, store.ApprovalRules{ApprovalsRequired: 2, ExcludeRequester: &no}); w != "" {
		t.Fatalf("requester allowed: %q", w)
	}
	if quorumWarning(nil, store.Requester{}, two) != "" || eligible(nil, store.Requester{}, true) != -1 {
		t.Fatal("no group: admins decide, nothing to warn")
	}
	c := store.RoutingConfig{Groups: []store.ApproverGroup{*g, {ID: "solo", Name: "Solo", Members: []store.GroupMember{{UserID: "u3"}}}},
		Routes:       []store.ApprovalRoute{{ID: "r1", Name: "prod", GroupID: "solo", ApprovalRules: store.ApprovalRules{ApprovalsRequired: 2}}},
		DefaultGroup: "sec", DefaultRules: two}
	if w := routingWarnings(c); len(w) != 2 || !strings.Contains(w[0], `rule "prod": Solo has 1 member(s)`) || !strings.Contains(w[1], "exactly 2 members") {
		t.Fatalf("routing warnings: %q", w)
	}
}

func TestCleanRules(t *testing.T) {
	c, err := cleanRouting(store.RoutingConfig{Groups: testRouting.Groups, Routes: []store.ApprovalRoute{{Name: "x", GroupID: "sec"}}, DefaultGroup: "sec"})
	if err != nil {
		t.Fatal(err)
	}
	r := c.Routes[0].ApprovalRules
	if r.ApprovalsRequired != 1 || r.ExcludeRequester == nil || !*r.ExcludeRequester || c.DefaultRules.ExcludeRequester == nil || !*c.DefaultRules.ExcludeRequester {
		t.Fatalf("defaults not written out: %+v %+v", r, c.DefaultRules)
	}
	if _, err := cleanRouting(store.RoutingConfig{Groups: testRouting.Groups, Routes: []store.ApprovalRoute{{Name: "x", GroupID: "sec", ApprovalRules: store.ApprovalRules{ApprovalsRequired: 3}}}}); err == nil {
		t.Fatal("3 approvers accepted")
	}
}

func TestTickets(t *testing.T) {
	for in, want := range map[string]string{"sec-123": "SEC-123", " OPS_2-9 ": "OPS_2-9", "https://jira.acme.io/browse/SEC-1": "https://jira.acme.io/browse/SEC-1", "": ""} {
		if got, err := cleanTicket(in); err != nil || got != want {
			t.Errorf("cleanTicket(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"see slack", "javascript:alert(1)", "SEC 12", "ftp://x/y"} {
		if _, err := cleanTicket(bad); err == nil {
			t.Errorf("cleanTicket(%q) accepted", bad)
		}
	}
	if _, err := cleanTicketTemplate("http://jira/browse/{key}"); err == nil {
		t.Error("http template accepted")
	}
	if _, err := cleanTicketTemplate("https://acme.atlassian.net/browse/"); err == nil {
		t.Error("template without {key} accepted")
	}
	tmpl := "https://acme.atlassian.net/browse/{key}"
	if u := ticketURL(tmpl, "SEC-7"); u != "https://acme.atlassian.net/browse/SEC-7" {
		t.Fatal(u)
	}
	if ticketURL("", "SEC-7") != "" || ticketURL(tmpl, "https://x.io/t/1") != "https://x.io/t/1" {
		t.Fatal("ticketURL")
	}
}

// TestTwoPersonApproval walks the whole flow against Postgres: requester
// resolved from the people mapping, two approvers through two channels, the
// endpoint seeing "approved" only at quorum, deny wins, admin override as one
// vote, and the ticket rule.
func TestTwoPersonApproval(t *testing.T) {
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
	tenant := fmt.Sprintf("org:votes-%d", time.Now().UnixNano())
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
		if out != nil {
			_ = json.NewDecoder(res.Body).Decode(out)
		}
		return res.StatusCode
	}
	// a signed-in console user (Clerk), called on the handler directly
	type refusal struct {
		store.Approval
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	console := func(user, role, id string, body map[string]any) (int, refusal) {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/api/v1/approvals/"+id+"/decision", bytes.NewReader(b))
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		s.decideApproval(rec, req, Principal{UserID: user, Tenant: tenant, Role: role, Via: "clerk"})
		var out refusal
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	call("PUT", "/api/v1/notifications", "", map[string]any{"emails": []string{"everyone@acme.io"}, "ticket_url_template": "https://acme.atlassian.net/browse/{key}"}, nil)
	yes := true
	routing := store.RoutingConfig{
		Groups: []store.ApproverGroup{{ID: "sec", Name: "Security", Members: []store.GroupMember{
			{UserID: "user_ann", Email: "ann@acme.io", Name: "Ann"}, {UserID: "user_bob", Email: "bob@acme.io", Name: "Bob"},
			{UserID: "user_dana", Email: "dana@acme.io", Name: "Dana"}}}},
		Routes: []store.ApprovalRoute{
			{ID: "r-push", Name: "pushes", Patterns: []string{"git push"}, GroupID: "sec", ApprovalRules: store.ApprovalRules{ApprovalsRequired: 2}},
			{ID: "r-tf", Name: "terraform", Patterns: []string{"terraform"}, GroupID: "sec", ApprovalRules: store.ApprovalRules{RequireTicket: true, ExcludeRequester: &yes}},
		},
		DefaultGroup: "sec",
	}
	var view routingView
	if code := call("PUT", "/api/v1/approval-routing", "", routing, &view); code != 200 || view.Routes[0].ApprovalsRequired != 2 || !*view.Routes[0].ExcludeRequester || len(view.Warnings) != 0 {
		t.Fatalf("save routing: %d %+v", code, view)
	}

	var tok struct {
		Token struct{ Token string } `json:"token"`
	}
	call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
	var er EnrollResponse
	call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": "dana-mbp"}}, &er)
	// dana's OS user on her laptop is mapped to her work email (People)
	if _, err := st.PutPerson(ctx, tenant, "dana@acme.io", "Dana", []store.PersonIdentity{{Kind: spend.KindOSUser, Value: "dana@dana-mbp", Source: "manual"}}, "test"); err != nil {
		t.Fatal(err)
	}

	var tr map[string]any
	call("POST", "/api/v1/approval-routing/test", "", map[string]any{"summary": "Bash: git push origin main", "hostname": "dana-mbp", "os_user": "dana"}, &tr)
	if tr["approvals_required"] != float64(2) || tr["exclude_requester"] != true || tr["eligible_approvers"] != float64(2) || tr["warning"] != "" ||
		fmt.Sprint(tr["excluded_members"]) != "[dana@acme.io]" {
		t.Fatalf("routing test: %v", tr)
	}

	ask := func(n int, summary string) endpointApprovalResp {
		var r endpointApprovalResp
		call("POST", "/ep/v1/approvals", er.Secret, map[string]any{"fingerprint": "fp1:" + strings.Repeat(fmt.Sprintf("%02x", n), 32), "agent": "claude-code",
			"tool": "Bash", "summary": summary, "rule": "command_approve", "reason": "needs approval", "os_user": "dana"}, &r)
		return r
	}
	linkFor := func(a store.Approval, email string) string {
		acts := s.approvalActions(a, email, "email")
		u, _ := url.Parse(acts[0].URL)
		return srv.URL + u.Path
	}
	post := func(link, decision string) (int, string) {
		res, err := http.PostForm(link, url.Values{"decision": {decision}})
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}

	// 1. two approvals needed; the requester can't be one of them
	r1 := ask(1, "Bash: git push origin main")
	a1, _ := st.GetApproval(ctx, tenant, r1.ID)
	if a1.ApprovalsRequired != 2 || !a1.ExcludeRequester || a1.Requester.Label != "dana@acme.io" || r1.ApprovalsRequired != 2 {
		t.Fatalf("filed: %+v / %+v", a1, r1)
	}
	sink.take()
	if code, body := post(linkFor(a1, "dana@acme.io"), "approve"); code != 403 || !strings.Contains(body, "You are the requester") {
		t.Fatalf("requester's email link: %d %s", code, body)
	}
	if code, out := console("user_dana", "admin", r1.ID, map[string]any{"decision": "approve"}); code != 403 || out.Code != refuseSelf {
		t.Fatalf("requester in the console (an admin): %d %+v", code, out)
	}
	var audit []store.AuditEntry
	call("GET", "/api/v1/audit?action=approval.self_approval_refused", "", nil, &audit)
	if len(audit) != 2 {
		t.Fatalf("self-approval refusals audited: %d", len(audit))
	}
	// the admin token isn't a person: it can't be one of two
	var ref refusal
	if code := call("POST", "/api/v1/approvals/"+r1.ID+"/decision", "", map[string]any{"decision": "approve"}, &ref); code != 403 || ref.Code != refuseNotPerson {
		t.Fatalf("admin token on a two-person request: %d %+v", code, ref)
	}
	// Ann approves by email: recorded, still pending, the agent keeps waiting
	if code, body := post(linkFor(a1, "ann@acme.io"), "approve"); code != 200 || !strings.Contains(body, "1 of 2 approvals (Ann") {
		t.Fatalf("first approval: %d %s", code, body)
	}
	if r := ask(1, "Bash: git push origin main"); r.State != "pending" || r.Approvals != 1 || r.ApprovalsRequired != 2 || len(r.ApprovedBy) != 1 {
		t.Fatalf("agent after one approval: %+v", r)
	}
	// Ann again from the console: same person
	if code, out := console("user_ann", "member", r1.ID, map[string]any{"decision": "approve"}); code != 409 || out.Code != refuseVoted {
		t.Fatalf("second vote by Ann: %d %+v", code, out)
	}
	// Bob makes two
	code, out := console("user_bob", "member", r1.ID, map[string]any{"decision": "approve", "note": "ok"})
	if code != 200 || out.State != "approved" || len(out.Votes) != 2 || !strings.Contains(out.DecidedByName, "Ann") || !strings.Contains(out.DecidedByName, "Bob") {
		t.Fatalf("quorum: %d %+v", code, out)
	}
	if r := ask(1, "Bash: git push origin main"); r.State != "approved" {
		t.Fatalf("agent at quorum: %+v", r)
	}
	call("GET", "/api/v1/audit?action=approval.approve", "", nil, &audit)
	if len(audit) != 2 {
		t.Fatalf("votes audited: %d", len(audit))
	}

	// 2. any deny denies, the requester's too
	r2 := ask(2, "Bash: git push --force origin main")
	a2, _ := st.GetApproval(ctx, tenant, r2.ID)
	post(linkFor(a2, "ann@acme.io"), "approve")
	if code, out := console("user_dana", "member", r2.ID, map[string]any{"decision": "deny"}); code != 200 || out.State != "denied" {
		t.Fatalf("requester's deny: %d %+v", code, out)
	}
	if r := ask(2, "Bash: git push --force origin main"); r.State != "denied" {
		t.Fatalf("agent after deny: %+v", r)
	}
	if code, body := post(linkFor(a2, "bob@acme.io"), "approve"); code != 200 || !strings.Contains(body, "Already decided") {
		t.Fatalf("vote after the decision: %d %s", code, body)
	}

	// 3. an admin outside the group steps in: one vote, not a bypass. The
	// requester is known by email, so an admin whose email nobody knows
	// (in no group, not in the directory) can't be told apart from them.
	r3 := ask(3, "Bash: git push origin dev")
	if code, out := console("user_ghost", "admin", r3.ID, map[string]any{"decision": "approve"}); code != 403 || out.Code != refuseUnverified ||
		!strings.Contains(out.Error, "only by email") {
		t.Fatalf("admin without a known email: %d %+v", code, out)
	}
	s.Directory = userEmailDirectory{"user_boss": {"Boss@Acme.io"}}
	defer func() { s.Directory = nil }()
	if code, out := console("user_boss", "admin", r3.ID, map[string]any{"decision": "approve", "name": "Boss"}); code != 200 || out.State != "pending" || !out.Votes[0].AdminOverride {
		t.Fatalf("admin's vote: %d %+v", code, out)
	}
	if code, out := console("user_ann", "member", r3.ID, map[string]any{"decision": "approve"}); code != 200 || out.State != "approved" {
		t.Fatalf("member completes it: %d %+v", code, out)
	}

	// 4. a ticket is required to approve: never from an email button
	r4 := ask(4, "Bash: terraform apply")
	a4, _ := st.GetApproval(ctx, tenant, r4.ID)
	if !a4.RequireTicket || len(s.approvalActions(a4, "ann@acme.io", "email")) != 1 {
		t.Fatalf("ticket route: %+v", a4)
	}
	res, _ := http.Get(linkFor(store.Approval{ID: a4.ID, Tenant: tenant, ExpiresAt: a4.ExpiresAt}, "ann@acme.io") + "?d=approve")
	page, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if strings.Contains(string(page), `value="approve"`) || !strings.Contains(string(page), "ticket reference") {
		t.Fatalf("ticket page offers Approve: %s", page)
	}
	if code, out := console("user_ann", "member", r4.ID, map[string]any{"decision": "approve"}); code != 400 || out.Code != refuseTicket {
		t.Fatalf("approve without ticket: %d %+v", code, out)
	}
	if code, out := console("user_ann", "member", r4.ID, map[string]any{"decision": "approve", "ticket": "not a ticket"}); code != 400 || out.Code != "bad_ticket" {
		t.Fatalf("bad ticket: %d %+v", code, out)
	}
	if code, out := console("user_ann", "member", r4.ID, map[string]any{"decision": "approve", "ticket": "sec-42"}); code != 200 || out.State != "approved" ||
		out.Votes[0].Ticket != "SEC-42" || out.Votes[0].TicketURL != "https://acme.atlassian.net/browse/SEC-42" {
		t.Fatalf("approve with ticket: %d %+v", code, out)
	}
	var got store.Approval
	call("GET", "/api/v1/approvals/"+r4.ID, "", nil, &got)
	if len(got.Votes) != 1 || got.Votes[0].TicketURL == "" {
		t.Fatalf("get approval: %+v", got.Votes)
	}

	// 5. the default rules exclude the requester too (configs saved before the setting)
	r5 := ask(5, "Bash: ls")
	if code, out := console("user_dana", "member", r5.ID, map[string]any{"decision": "approve"}); code != 403 || out.Code != refuseSelf {
		t.Fatalf("requester on the default route: %d %+v", code, out)
	}
	type listView struct {
		store.Approval
		CanApprove     bool   `json:"can_approve"`
		ApproveRefusal string `json:"approve_refusal"`
	}
	var list []listView
	call("GET", "/api/v1/approvals?state=pending", "", nil, &list)
	if len(list) != 1 || list[0].ID != r5.ID || list[0].CanApprove || list[0].ApproveRefusal != refuseNotPerson { // the admin token may only deny
		t.Fatalf("list: %+v", list)
	}
	if code, out := console("user_ann", "member", r5.ID, map[string]any{"decision": "approve"}); code != 200 || out.State != "approved" {
		t.Fatalf("another member: %d %+v", code, out)
	}
}

// consoleDecision decides an approval as a signed-in console user (Clerk),
// on the handler directly: the admin token and API keys can't approve.
func consoleDecision(s *Server, tenant, user, role, id string, body map[string]any) (int, []byte) {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/v1/approvals/"+id+"/decision", bytes.NewReader(b))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	s.decideApproval(rec, req, Principal{UserID: user, Tenant: tenant, Role: role, Via: "clerk"})
	return rec.Code, rec.Body.Bytes()
}

// userEmailDirectory knows console users' verified emails (like Clerk with
// CLERK_SECRET_KEY, or the self-hosted StoreDirectory).
type userEmailDirectory map[string][]string

func (d userEmailDirectory) MemberRole(context.Context, string, string) (string, error) {
	return "", nil
}
func (d userEmailDirectory) UserEmails(_ context.Context, _, userID string) ([]string, error) {
	return d[userID], nil
}
