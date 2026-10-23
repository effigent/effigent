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
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
)

func TestProposalDecider(t *testing.T) {
	prop := store.Proposal{Author: "user_ann", AuthorOwner: ""}
	byKey := store.Proposal{Author: "apikey:k1", AuthorVia: "api-key", AuthorOwner: "user_ann"}
	for _, c := range []struct {
		name string
		p    Principal
		prop store.Proposal
		ok   bool
	}{
		{"another admin", Principal{UserID: "user_bob", Role: "admin", Via: "clerk"}, prop, true},
		{"a security admin", Principal{UserID: "user_sec", Role: "security_admin", Via: "clerk"}, prop, true},
		{"the author", Principal{UserID: "user_ann", Role: "admin", Via: "clerk"}, prop, false},
		{"a read-only member", Principal{UserID: "user_m", Role: "member", Via: "clerk"}, prop, false},
		{"an API key", Principal{UserID: "apikey:k2", Role: "api_key", Via: "api-key", Scopes: []string{"policy"}}, prop, false},
		{"the person who made the author's key", Principal{UserID: "user_ann", Role: "admin", Via: "clerk"}, byKey, false},
		{"someone else, for a key's proposal", Principal{UserID: "user_bob", Role: "admin", Via: "clerk"}, byKey, true},
		{"the admin token", Principal{UserID: "admin", Role: "admin", Via: "admin-token"}, prop, false},
		{"an admin signed in through OIDC", Principal{UserID: "oidc|bob", Role: "admin", Via: "oidc"}, prop, true},
	} {
		if got := proposalDecider(c.p, c.prop) == ""; got != c.ok {
			t.Errorf("%s: %v, want %v", c.name, got, c.ok)
		}
	}
}

// TestPolicyProposals: with change approval on, policy edits, exceptions and
// owner changes wait for a second admin, and are applied as the direct call.
func TestPolicyProposals(t *testing.T) {
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
	tenant := fmt.Sprintf("org:proposals-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

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
	// signed-in console admins (Clerk), called on the handlers directly
	type answer struct {
		Proposal store.Proposal  `json:"proposal"`
		Version  int64           `json:"version"`
		Endpoint *store.Endpoint `json:"endpoint"`
		Error    string          `json:"error"`
	}
	as := func(user string, h func(http.ResponseWriter, *http.Request, Principal), method, id string, body any) (int, answer) {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, "/x", bytes.NewReader(b))
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		h(rec, req, Principal{UserID: user, Tenant: tenant, Role: "admin", Via: "clerk"})
		var out answer
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	latest := func() store.PolicyVersion {
		pv, _ := st.LatestPolicy(ctx, tenant)
		return pv
	}
	approve := map[string]any{"decision": "approve"}

	// off (the default): published at once
	if code := call("PUT", "/api/v1/policy", "", map[string]any{"body": exceptionBase, "comment": "base"}, nil); code != 200 || latest().Version != 1 {
		t.Fatalf("direct publish: %d", code)
	}
	if code, _ := as("user_ann", s.putPolicySettings, "PUT", "", map[string]any{"policy_change_approval": true}); code != 200 {
		t.Fatalf("turn on: %d", code)
	}

	// an API key proposes (keys may propose, never approve)
	var k store.APIKey
	call("POST", "/api/v1/api-keys", "", map[string]any{"name": "ci", "scopes": []string{"policy"}}, &k)
	edited := strings.Replace(exceptionBase, "pastebin.com", "pastebin.com, transfer.sh", 1)
	var a answer
	if code := call("PUT", "/api/v1/policy", k.Key, map[string]any{"body": edited, "comment": "block transfer.sh"}, &a); code != 202 ||
		a.Proposal.State != "pending" || a.Proposal.BaseVersion != 1 || latest().Version != 1 {
		t.Fatalf("key's proposal: %d %+v (latest v%d)", code, a, latest().Version)
	}
	keyProp := a.Proposal
	if code := call("PUT", "/api/v1/policy", k.Key, map[string]any{"body": "defaults: {mode: nonsense}\n"}, nil); code != 400 {
		t.Fatalf("an invalid policy is refused, not proposed: %d", code)
	}
	if code := call("POST", "/api/v1/policy/proposals/"+keyProp.ID+"/decision", k.Key, approve, nil); code != 403 {
		t.Fatalf("a key approved: %d", code)
	}
	// the admin token created the key: it can't approve the key's proposal
	if code := call("POST", "/api/v1/policy/proposals/"+keyProp.ID+"/decision", "", approve, nil); code != 403 {
		t.Fatalf("the key's creator approved: %d", code)
	}
	var list []proposalView
	call("GET", "/api/v1/policy/proposals?state=pending", "", nil, &list)
	if len(list) != 1 || list[0].Base == nil || list[0].Base.Version != 1 || list[0].Stale || list[0].CanDecide {
		t.Fatalf("list: %+v", list)
	}

	// Ann proposes too; she can't approve her own
	code, annProp := as("user_ann", s.putPolicy, "PUT", "", map[string]any{"body": exceptionBase, "comment": "undo"})
	if code != 202 {
		t.Fatalf("ann's proposal: %d", code)
	}
	if code, _ := as("user_ann", s.decideProposal, "POST", annProp.Proposal.ID, approve); code != 403 {
		t.Fatalf("self-approval: %d", code)
	}
	// the admin token is no second admin: it can neither approve nor reject Ann's
	for _, d := range []string{"approve", "reject"} {
		if code := call("POST", "/api/v1/policy/proposals/"+annProp.Proposal.ID+"/decision", "", map[string]any{"decision": d}, nil); code != 403 {
			t.Fatalf("the admin token's %s: %d", d, code)
		}
	}
	var audit []store.AuditEntry
	call("GET", "/api/v1/audit?action=policy.self_approval_refused", "", nil, &audit)
	if len(audit) != 2 { // the key's creator, then Ann
		t.Fatalf("self-approval refusal audited %d times", len(audit))
	}

	// Bob approves the key's: published as v2, exactly as proposed
	if code, a := as("user_bob", s.decideProposal, "POST", keyProp.ID, approve); code != 200 || a.Version != 2 || a.Proposal.State != "approved" || a.Proposal.Version != 2 {
		t.Fatalf("approve: %d %+v", code, a)
	}
	if pv := latest(); pv.Body != edited || !strings.Contains(pv.Comment, "approved by user_bob") || pv.CreatedBy != "user_bob" {
		t.Fatalf("v2: %+v", pv)
	}
	// Ann's was made on v1: stale now, superseded on approval
	call("GET", "/api/v1/policy/proposals?state=pending", "", nil, &list)
	if len(list) != 1 || !list[0].Stale {
		t.Fatalf("stale: %+v", list)
	}
	if code, a := as("user_bob", s.decideProposal, "POST", annProp.Proposal.ID, approve); code != 409 || a.Proposal.State != "superseded" || latest().Version != 2 {
		t.Fatalf("stale approval: %d %+v", code, a)
	}
	if code, _ := as("user_bob", s.decideProposal, "POST", keyProp.ID, approve); code != 409 {
		t.Fatalf("approved twice: %d", code)
	}

	// an exception: proposed on v2, a policy edit lands first, still applies on top
	code, exc := as("user_ann", s.createException, "POST", "", map[string]any{"endpoints": []string{"dana-mbp"}, "list": "exec_deny", "value": "curl", "reason": "debugging"})
	if code != 202 || exc.Proposal.Kind != "exception.create" {
		t.Fatalf("exception proposal: %d %+v", code, exc)
	}
	code, pol := as("user_ann", s.putPolicy, "PUT", "", map[string]any{"body": edited, "comment": "same again"})
	if code != 202 {
		t.Fatal(code)
	}
	as("user_bob", s.decideProposal, "POST", pol.Proposal.ID, approve) // v3
	if code, a := as("user_bob", s.decideProposal, "POST", exc.Proposal.ID, approve); code != 200 || a.Version != 4 {
		t.Fatalf("exception approval: %d %+v", code, a)
	}
	var excs []exceptionView
	call("GET", "/api/v1/exceptions", "", nil, &excs)
	if len(excs) != 1 || excs[0].Value != "curl" || excs[0].CreatedBy != "user_ann" {
		t.Fatalf("exceptions: %+v", excs)
	}

	// a machine's owner waits too: not saved until approved
	var tok struct {
		Token struct{ Token string } `json:"token"`
	}
	call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
	var er EnrollResponse
	call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": "dana-mbp"}}, &er)
	code, own := as("user_ann", s.setEndpointOwner, "PATCH", er.EndpointID, map[string]any{"owner": "dana@acme.io", "teams": []string{"payments"}})
	if code != 202 || own.Endpoint == nil || own.Endpoint.Owner != "" {
		t.Fatalf("owner proposal: %d %+v", code, own)
	}
	if e, _ := st.GetEndpoint(ctx, tenant, er.EndpointID); e.Owner != "" {
		t.Fatalf("owner saved before approval: %q", e.Owner)
	}
	if code, _ := as("user_bob", s.decideProposal, "POST", own.Proposal.ID, approve); code != 200 {
		t.Fatalf("owner approval: %d", code)
	}
	if e, _ := st.GetEndpoint(ctx, tenant, er.EndpointID); e.Owner != "dana@acme.io" || latest().Version != 5 {
		t.Fatalf("owner after approval: %q (v%d)", e.Owner, latest().Version)
	}

	// withdraw (author only) and reject
	_, w1 := as("user_ann", s.deleteException, "DELETE", excs[0].ID, nil)
	if code, _ := as("user_bob", s.withdrawProposal, "DELETE", w1.Proposal.ID, nil); code != 403 {
		t.Fatalf("withdrawn by another: %d", code)
	}
	if code, a := as("user_ann", s.withdrawProposal, "DELETE", w1.Proposal.ID, nil); code != 200 || a.Proposal.State != "withdrawn" {
		t.Fatalf("withdraw: %d %+v", code, a)
	}
	_, r1 := as("user_ann", s.deleteException, "DELETE", excs[0].ID, nil)
	if code, a := as("user_bob", s.decideProposal, "POST", r1.Proposal.ID, map[string]any{"decision": "reject", "note": "still needed"}); code != 200 || a.Proposal.State != "rejected" {
		t.Fatalf("reject: %d %+v", code, a)
	}
	if latest().Version != 5 {
		t.Fatalf("withdrawn/rejected changes published: v%d", latest().Version)
	}

	// turning it off is a change too
	code, off := as("user_ann", s.putPolicySettings, "PUT", "", map[string]any{"policy_change_approval": false})
	if code != 202 {
		t.Fatalf("turn off: %d", code)
	}
	if ps, _ := st.GetPolicySettings(ctx, tenant); !ps.ChangeApproval {
		t.Fatal("turned off without approval")
	}
	if code, _ := as("user_bob", s.decideProposal, "POST", off.Proposal.ID, approve); code != 200 {
		t.Fatalf("approve turning off: %d", code)
	}
	if code := call("PUT", "/api/v1/policy", "", map[string]any{"body": exceptionBase}, nil); code != 200 || latest().Version != 6 {
		t.Fatalf("direct publish after turning off: %d", code)
	}
	for _, act := range []string{"policy.propose", "policy.approve", "policy.reject", "policy.withdraw", "policy.supersede", "policy.settings.update"} {
		call("GET", "/api/v1/audit?action="+act, "", nil, &audit)
		if len(audit) == 0 {
			t.Errorf("no %s in the audit trail", act)
		}
	}
}
