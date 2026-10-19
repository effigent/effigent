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
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/compile"
	"github.com/effigent/effigent/internal/controlplane/store"
	ep "github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/shared/sign"
)

const exceptionBase = `
defaults:
  mode: denylist
  exec_deny: [/usr/bin/curl, /usr/bin/nc]
  domain_deny: [pastebin.com]
  command_approve: ["git push*"]
agents:
  - name: claude-code
    binary_names: [claude]
  - name: codex
    binary_names: [codex]
    exec_deny: [/usr/bin/nc]
`

func TestExceptionsAPI(t *testing.T) {
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
	tenant := fmt.Sprintf("org:exceptions-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	call := func(method, path, bearer string, body any, out any) (int, string) {
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
		raw, _ := io.ReadAll(res.Body)
		if out != nil && res.StatusCode < 300 {
			_ = json.Unmarshal(raw, out)
		}
		return res.StatusCode, string(raw)
	}
	enroll := func(host string) string {
		var tok struct {
			Token struct{ Token string } `json:"token"`
		}
		call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
		var er EnrollResponse
		call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": host}}, &er)
		return er.Secret
	}
	// what one machine enforces now (always the newest version)
	enforced := func(secret string) (*ep.Policy, sign.Document) {
		t.Helper()
		var d sign.Document
		if code, body := call("GET", "/ep/v1/policy?have=0", secret, nil, &d); code != 200 {
			t.Fatalf("policy fetch: %d %s", code, body)
		}
		pol, err := ep.Parse([]byte(d.Body))
		if err != nil {
			t.Fatalf("endpoint would refuse: %v\n%s", err, d.Body)
		}
		return pol, d
	}
	hasCurl := func(p *ep.Policy, agent string) bool {
		return slices.Contains(p.RuleFor(agent).ExecDeny, "/usr/bin/curl")
	}

	if code, body := call("PUT", "/api/v1/policy", "", map[string]any{"body": exceptionBase, "comment": "base"}, nil); code != 200 {
		t.Fatalf("publish: %d %s", code, body)
	}
	dana, omer := enroll("dana-mbp"), enroll("omer-mbp")

	var opts struct {
		Options []struct{ List, Value string } `json:"options"`
	}
	call("GET", "/api/v1/exceptions/options", "", nil, &opts)
	if !slices.ContainsFunc(opts.Options, func(o struct{ List, Value string }) bool { return o.List == "exec_deny" && o.Value == "/usr/bin/curl" }) {
		t.Fatalf("options: %+v", opts)
	}

	// Dana may run curl, in Claude Code only
	var made struct {
		Exception compile.Exception `json:"exception"`
		Version   int64             `json:"version"`
	}
	if code, body := call("POST", "/api/v1/exceptions", "", map[string]any{"endpoints": []string{"dana-mbp"}, "agents": []string{"claude-code"},
		"list": "exec_deny", "value": "curl", "reason": "API debugging this sprint", "expires_hours": 24}, &made); code != 201 {
		t.Fatalf("create: %d %s", code, body)
	}
	p, d := enforced(dana)
	if hasCurl(p, "claude-code") || !slices.Contains(p.RuleFor("claude-code").ExecDeny, "/usr/bin/nc") || d.Endpoint == "" {
		t.Fatalf("dana claude-code: %v (endpoint %q)", p.RuleFor("claude-code").ExecDeny, d.Endpoint)
	}
	if !hasCurl(p, "") {
		t.Fatal("the defaults must keep curl (exception was for claude-code only)")
	}
	if p, _ := enforced(omer); !hasCurl(p, "claude-code") {
		t.Fatal("omer got dana's exception")
	}

	// refused: it would empty codex's own exec_deny [nc]
	if code, body := call("POST", "/api/v1/exceptions", "", map[string]any{"endpoints": []string{"dana-mbp"}, "agents": []string{"codex"},
		"list": "exec_deny", "value": "nc"}, nil); code != 400 || !strings.Contains(body, "empty") {
		t.Fatalf("refusal: %d %s", code, body)
	}
	if code, _ := call("POST", "/api/v1/exceptions", "", map[string]any{"list": "exec_deny", "value": "curl"}, nil); code != 400 {
		t.Fatal("exception for nobody accepted")
	}

	// a normal YAML publish keeps the exceptions
	edited := strings.Replace(exceptionBase, "[pastebin.com]", "[pastebin.com, transfer.sh]", 1)
	if code, body := call("PUT", "/api/v1/policy", "", map[string]any{"body": edited, "comment": "add transfer.sh"}, nil); code != 200 {
		t.Fatalf("publish: %d %s", code, body)
	}
	var list []exceptionView
	call("GET", "/api/v1/exceptions", "", nil, &list)
	if len(list) != 1 || !list[0].Active || !slices.Equal(list[0].Machines, []string{"dana-mbp"}) {
		t.Fatalf("list: %+v", list)
	}
	if p, _ := enforced(dana); hasCurl(p, "claude-code") || !slices.Contains(p.RuleFor("claude-code").DomainDeny, "transfer.sh") {
		t.Fatalf("after edit: %+v", p.RuleFor("claude-code"))
	}

	// removing it gives Dana the company policy back
	if code, body := call("DELETE", "/api/v1/exceptions/"+made.Exception.ID, "", nil, nil); code != 200 {
		t.Fatalf("delete: %d %s", code, body)
	}
	if p, _ := enforced(dana); !hasCurl(p, "claude-code") {
		t.Fatal("exception still applied after delete")
	}

	// expiry: an exception whose time is up is republished away
	pv, _ := st.LatestPolicy(ctx, tenant)
	past := time.Now().Add(-time.Minute)
	src := source{Exceptions: []compile.Exception{{ID: "exc_old", Endpoints: []string{"dana-mbp"}, List: "domain_deny", Value: "pastebin.com",
		ExpiresAt: &past, CreatedAt: past.Add(-time.Hour)}}}
	if _, err := st.PutPolicy(ctx, tenant, pv.Body, encodeSource(src), "seed", "test", past.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	s.expireExceptions(ctx)
	call("GET", "/api/v1/exceptions", "", nil, &list)
	latest, _ := st.LatestPolicy(ctx, tenant)
	if len(list) != 0 || !strings.Contains(latest.Comment, "exc_old") {
		t.Fatalf("after expiry: %+v (latest %q)", list, latest.Comment)
	}

	// audit
	var audit []store.AuditEntry
	call("GET", "/api/v1/audit?limit=100", "", nil, &audit)
	seen := map[string]int{}
	for _, e := range audit {
		seen[e.Action]++
	}
	if seen["exception.create"] != 1 || seen["exception.delete"] != 1 || seen["exception.expire"] != 1 {
		t.Fatalf("audit: %v", seen)
	}
}
