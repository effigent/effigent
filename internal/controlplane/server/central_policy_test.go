package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/controlplane/store"
	ep "github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/shared/sign"
)

// TestCentralPolicyEndToEnd needs a throwaway Postgres database:
//
//	EFFIGENT_TEST_DATABASE_URL=postgres://effigent:effigent@localhost:5433/effigent_test go test ./internal/controlplane/server/
func TestCentralPolicyEndToEnd(t *testing.T) {
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
	tenant := fmt.Sprintf("org:test-%d", os.Getpid())
	auth, err := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	if err != nil {
		t.Fatal(err)
	}
	pub, key, _ := ed25519.GenerateKey(nil)
	srv := httptest.NewServer((&Server{Store: st, Key: key, Auth: auth, Logf: t.Logf}).Handler())
	defer srv.Close()

	call := func(method, path, bearer string, body any, out any) int {
		t.Helper()
		var rd *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		} else {
			rd = bytes.NewReader(nil)
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
		if out != nil && res.StatusCode < 300 && res.StatusCode != http.StatusNoContent {
			if err := json.NewDecoder(res.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return res.StatusCode
	}

	enroll := func(host, owner string, teams []string) EnrollResponse {
		var tok struct {
			Token struct{ Token string } `json:"token"`
		}
		call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
		var er EnrollResponse
		if code := call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": host}}, &er); code != 200 {
			t.Fatalf("enroll %s: %d", host, code)
		}
		if code := call("PATCH", "/api/v1/endpoints/"+er.EndpointID, "", map[string]any{"owner": owner, "teams": teams}, nil); code != 200 {
			t.Fatalf("set owner %s: %d", host, code)
		}
		return er
	}
	pay := enroll("pay-laptop", "dana@acme.io", []string{"payments"})
	web := enroll("web-laptop", "omer@acme.io", []string{"web"})

	// Publish: block curl for the payments team, plus clauses the kernel can't enforce.
	policies := []map[string]any{{
		"id": "payments", "name": "Payments guardrails", "enabled": true, "priority": 10, "default": "allow",
		"rules": []map[string]any{
			{"id": "no-curl", "priority": 1, "decision": "deny", "who": map[string]any{"teams": []string{"payments"}},
				"what": map[string]any{"binaries": []string{"curl"}}},
			{"id": "no-force-push", "priority": 2, "decision": "require_approval",
				"approval": map[string]any{"teams": []string{"security"}},
				"what":     map[string]any{"binaries": []string{"git"}, "commands": []string{"git push --force*"}}},
			{"id": "no-pastebin", "priority": 3, "decision": "deny", "what": map[string]any{"hosts": []string{"pastebin.com"}}},
		},
	}}
	var pub1 struct {
		Version int64         `json:"version"`
		Report  publishReport `json:"report"`
	}
	if code := call("PUT", "/api/v1/policy", "", map[string]any{"body": string(ep.DefaultYAML), "comment": "central", "policies": policies}, &pub1); code != 200 {
		t.Fatalf("publish: %d", code)
	}
	reasons := map[string]string{}
	for _, u := range pub1.Report.Unsupported {
		reasons[u.RuleID+"/"+u.Field] = u.Reason
	}
	if reasons["no-force-push/what.commands"] == "" || reasons["no-pastebin/what.hosts"] == "" {
		t.Fatalf("unsupported clauses missing from publish response: %+v", pub1.Report.Unsupported)
	}

	fetch := func(e EnrollResponse) (*ep.Policy, sign.Document) {
		t.Helper()
		var d sign.Document
		if code := call("GET", "/ep/v1/policy?have=0", e.Secret, nil, &d); code != 200 {
			t.Fatalf("fetch: %d", code)
		}
		if err := sign.Verify(pub, tenant, d); err != nil {
			t.Fatal(err)
		}
		p, err := ep.Parse([]byte(d.Body))
		if err != nil {
			t.Fatal(err)
		}
		return p, d
	}
	payPolicy, payDoc := fetch(pay)
	webPolicy, _ := fetch(web)
	if payDoc.Endpoint != pay.EndpointID || payDoc.Version != pub1.Version {
		t.Fatalf("doc not bound to endpoint/version: %+v", payDoc)
	}
	for _, agent := range []string{"", "claude-code", "codex"} {
		if !slices.Contains(payPolicy.RuleFor(agent).ExecDeny, "/usr/bin/curl") {
			t.Fatalf("payments machine, %q: curl not blocked", agent)
		}
		if slices.Contains(webPolicy.RuleFor(agent).ExecDeny, "/usr/local/bin/curl") {
			t.Fatalf("web machine, %q: curl blocked", agent)
		}
		if slices.Contains(payPolicy.RuleFor(agent).ExecDeny, "/usr/bin/git") {
			t.Fatalf("argument-level rule blocked git entirely")
		}
	}

	// Editing the base YAML alone keeps the central policies.
	var pub2 struct {
		Version int64 `json:"version"`
	}
	call("PUT", "/api/v1/policy", "", map[string]any{"body": string(ep.DefaultYAML), "comment": "base edit"}, &pub2)
	if p, _ := fetch(pay); !slices.Contains(p.RuleFor("codex").ExecDeny, "/usr/bin/curl") {
		t.Fatal("base-only publish dropped the central policies")
	}

	// Moving the web machine to payments republishes; it now blocks curl.
	var moved struct {
		Version int64 `json:"version"`
	}
	call("PATCH", "/api/v1/endpoints/"+web.EndpointID, "", map[string]any{"owner": "omer@acme.io", "teams": []string{"payments"}}, &moved)
	if moved.Version <= pub2.Version {
		t.Fatalf("owner change did not bump the version: %d <= %d", moved.Version, pub2.Version)
	}
	if p, _ := fetch(web); !slices.Contains(p.RuleFor("codex").ExecDeny, "/usr/bin/curl") {
		t.Fatal("reassigned machine did not pick up the payments rule")
	}

	// Preview for the console.
	var preview struct {
		Compiled bool   `json:"compiled"`
		Body     string `json:"body"`
	}
	call("GET", "/api/v1/endpoints/"+pay.EndpointID+"/policy", "", nil, &preview)
	if !preview.Compiled || !strings.Contains(preview.Body, "/usr/bin/curl") {
		t.Fatalf("preview: %+v", preview)
	}

	// Clearing the central policies goes back to one body for everyone.
	call("PUT", "/api/v1/policy", "", map[string]any{"body": string(ep.DefaultYAML), "policies": []any{}}, nil)
	if _, d := fetch(pay); d.Endpoint != "" || d.Body != string(ep.DefaultYAML) {
		t.Fatalf("cleared policies still compiled: endpoint=%q", d.Endpoint)
	}
}
