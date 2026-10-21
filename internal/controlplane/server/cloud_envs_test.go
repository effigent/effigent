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
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/shared/cloudtoken"
	"github.com/effigent/effigent/internal/shared/sign"
	"github.com/jackc/pgx/v5"
)

// TestCloudEnvironments: a cloud environment is created from the console
// API with no enrollment; its token carries the server, endpoint, tenant,
// secret and signing key; the secret works on the endpoint protocol (signed
// policy, events, approvals); it is listed as kind cloud, never reported
// offline, and revoking it stops it.
func TestCloudEnvironments(t *testing.T) {
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
	db, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)

	tenant := fmt.Sprintf("org:cloud-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	pub, key, _ := ed25519.GenerateKey(nil)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, HealthTick: time.Hour, PublicBaseURL: "https://cp.example/"}
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
		if out != nil && res.StatusCode < 300 {
			_ = json.NewDecoder(res.Body).Decode(out)
		}
		return res.StatusCode
	}

	if c := call("POST", "/api/v1/cloud-environments", "", map[string]string{"name": "acme/api", "vendor": "devin"}, nil); c != 400 {
		t.Fatalf("unknown vendor: %d", c)
	}
	if c := call("POST", "/api/v1/cloud-environments", "", map[string]string{"vendor": "copilot"}, nil); c != 400 {
		t.Fatalf("no name: %d", c)
	}
	var made struct {
		Endpoint  store.Endpoint `json:"endpoint"`
		Token     string         `json:"token"`
		HookAgent string         `json:"hook_agent"`
	}
	if c := call("POST", "/api/v1/cloud-environments", "", map[string]string{"name": "acme/api", "vendor": "copilot"}, &made); c != 201 {
		t.Fatalf("create: %d", c)
	}
	if made.Endpoint.Kind != "cloud" || made.Endpoint.Vendor != "copilot" || made.Endpoint.Hostname != "acme/api" || made.HookAgent != "copilot" {
		t.Fatalf("made: %+v", made)
	}
	tok, err := cloudtoken.Decode(made.Token)
	if err != nil {
		t.Fatal(err)
	}
	if tok.Server != "https://cp.example" || tok.EndpointID != made.Endpoint.ID || tok.Tenant != tenant || tok.ServerPublicKey != sign.EncodePublic(pub) {
		t.Fatalf("token: %+v", tok)
	}

	// the endpoint protocol works with the token's secret
	if c := call("PUT", "/api/v1/policy", "", map[string]string{"body": string(policy.DefaultYAML), "comment": "v1"}, nil); c != 200 {
		t.Fatalf("publish: %d", c)
	}
	var doc sign.Document
	if c := call("GET", "/ep/v1/policy?have=0", tok.Secret, nil, &doc); c != 200 {
		t.Fatalf("policy: %d", c)
	}
	k, _ := sign.DecodePublic(tok.ServerPublicKey)
	if err := sign.Verify(k, tok.Tenant, doc); err != nil || doc.Version != 1 {
		t.Fatalf("signed policy: v%d %v", doc.Version, err)
	}
	ev := map[string]any{"batch_id": "b1", "events": []map[string]any{{"time": time.Now(), "type": "blocked", "severity": "high",
		"agent": "copilot", "target": "exec curl", "rule": "exec_deny"}}}
	if c := call("POST", "/ep/v1/events", tok.Secret, ev, nil); c != 200 {
		t.Fatalf("events: %d", c)
	}
	if c := call("POST", "/ep/v1/heartbeat", tok.Secret, map[string]any{"policy_version": 1, "version": "v0.7.0"}, nil); c != 200 {
		t.Fatalf("heartbeat: %d", c)
	}

	var eps []store.Endpoint
	call("GET", "/api/v1/endpoints", "", nil, &eps)
	if len(eps) != 1 || eps[0].Kind != "cloud" || eps[0].PolicyVersion != 1 || eps[0].LastSeen == nil {
		t.Fatalf("listed: %+v", eps)
	}

	// silent cloud environments are normal: never marked offline
	if _, err := db.Exec(ctx, `update cp.endpoints set last_seen = now() - interval '2 days' where id = $1`, tok.EndpointID); err != nil {
		t.Fatal(err)
	}
	off, err := st.MarkEndpointsOffline(ctx, time.Minute, 500)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range off {
		if e.ID == tok.EndpointID {
			t.Fatal("cloud environment marked offline")
		}
	}

	var entries []map[string]any
	call("GET", "/api/v1/audit?action=cloud_environment.create", "", nil, &entries)
	if len(entries) != 1 {
		t.Fatalf("audit: %v", entries)
	}

	if c := call("DELETE", "/api/v1/endpoints/"+tok.EndpointID, "", nil, nil); c != 200 {
		t.Fatalf("revoke: %d", c)
	}
	if c := call("GET", "/ep/v1/policy?have=0", tok.Secret, nil, nil); c != 401 {
		t.Fatalf("revoked environment still served: %d", c)
	}
}
