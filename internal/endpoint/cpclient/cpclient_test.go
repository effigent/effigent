package cpclient

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/shared/sign"
)

// A policy compiled for one machine must not be accepted by another machine
// of the same tenant (e.g. swapped into its offline cache).
func TestRefusesPolicyCompiledForAnotherEndpoint(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(nil)
	for _, tc := range []struct {
		endpoint string
		ok       bool
	}{{"ep-other", false}, {"ep-me", true}, {"", true}} {
		dir := t.TempDir()
		doc := sign.Sign(key, sign.Document{Tenant: "org:t", Endpoint: tc.endpoint, Version: 3, IssuedAt: time.Now(), Body: "defaults: {}"})
		b, _ := json.Marshal(doc)
		if err := os.WriteFile(policyPath(dir), b, 0o600); err != nil {
			t.Fatal(err)
		}
		applied := false
		c := &Client{Dir: dir, State: &State{EndpointID: "ep-me", Tenant: "org:t", ServerPublicKey: sign.EncodePublic(pub)},
			Apply: func(context.Context, []byte) error { applied = true; return nil }}
		err := c.LoadCached(context.Background())
		if tc.ok != (err == nil) || applied != tc.ok {
			t.Fatalf("endpoint %q: err=%v applied=%v", tc.endpoint, err, applied)
		}
		if !tc.ok && !strings.Contains(err.Error(), "compiled for endpoint ep-other") {
			t.Fatalf("unexpected error: %v", err)
		}
	}
}

// fakeEnroll is a control plane whose /ep/v1/enroll answers status (200 with
// credentials) and records each request's info.hostname.
func fakeEnroll(t *testing.T, status ...int) (url string, hosts *[]string) {
	hosts = new([]string)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Token string            `json:"token"`
			Info  map[string]string `json:"info"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		*hosts = append(*hosts, req.Info["hostname"])
		code := http.StatusOK
		if n := len(*hosts) - 1; n < len(status) {
			code = status[n]
		}
		if code != http.StatusOK {
			http.Error(w, "nope", code)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"endpoint_id": "ep-1", "secret": "eps_x", "tenant": "org:t", "server_public_key": "k"})
	}))
	t.Cleanup(srv.Close)
	return srv.URL, hosts
}

func TestEnsureEnrolledEnrollsOnceUnderTheMachineName(t *testing.T) {
	t.Setenv("EFFIGENT_HOSTNAME", "node-a")
	url, hosts := fakeEnroll(t)
	dir := t.TempDir()
	st, enrolled, err := EnsureEnrolled(context.Background(), url, "eft_x", dir, "v1", t.Logf)
	if err != nil || !enrolled || st.EndpointID != "ep-1" || st.Server != url {
		t.Fatalf("first start: st=%+v enrolled=%v err=%v", st, enrolled, err)
	}
	// A restart with the same state dir reuses the credentials: no second enrollment.
	st, enrolled, err = EnsureEnrolled(context.Background(), url, "eft_x", dir, "v1", t.Logf)
	if err != nil || enrolled || st.EndpointID != "ep-1" {
		t.Fatalf("restart: st=%+v enrolled=%v err=%v", st, enrolled, err)
	}
	if len(*hosts) != 1 || (*hosts)[0] != "node-a" {
		t.Fatalf("enroll requests: %v, want one as node-a", *hosts)
	}
}

func TestEnsureEnrolledWithoutTokenOrState(t *testing.T) {
	st, enrolled, err := EnsureEnrolled(context.Background(), "http://127.0.0.1:1", "", t.TempDir(), "v1", t.Logf)
	if st != nil || enrolled || err != nil {
		t.Fatalf("st=%+v enrolled=%v err=%v", st, enrolled, err)
	}
}

func TestEnsureEnrolledRetriesServerErrorsNotRefusals(t *testing.T) {
	url, hosts := fakeEnroll(t, http.StatusServiceUnavailable)
	if _, enrolled, err := EnsureEnrolled(context.Background(), url, "eft_x", t.TempDir(), "v1", t.Logf); err != nil || !enrolled {
		t.Fatalf("after a 503: enrolled=%v err=%v", enrolled, err)
	}
	if len(*hosts) != 2 {
		t.Fatalf("%d requests, want 2", len(*hosts))
	}
	url, hosts = fakeEnroll(t, http.StatusUnauthorized)
	dir := t.TempDir()
	if _, _, err := EnsureEnrolled(context.Background(), url, "eft_used", dir, "v1", t.Logf); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("refused token: err=%v", err)
	}
	if len(*hosts) != 1 {
		t.Fatalf("refused token retried: %d requests", len(*hosts))
	}
	if _, err := os.Stat(statePath(dir)); !os.IsNotExist(err) {
		t.Fatalf("refused enrollment left state behind: %v", err)
	}
}

func TestMachineName(t *testing.T) {
	t.Setenv("EFFIGENT_HOSTNAME", " node-b ")
	if got := MachineName(); got != "node-b" {
		t.Fatalf("MachineName() = %q", got)
	}
	t.Setenv("EFFIGENT_HOSTNAME", "")
	if h, _ := os.Hostname(); MachineName() != h {
		t.Fatalf("MachineName() = %q, want the OS hostname %q", MachineName(), h)
	}
}
