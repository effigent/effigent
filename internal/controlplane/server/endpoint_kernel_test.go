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
)

// The kernel layer effigentd reports with its heartbeat is stored on the
// endpoint and listed by GET /api/v1/endpoints; older builds leave it null.
func TestEndpointKernelStatus(t *testing.T) {
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
	tenant := fmt.Sprintf("org:kernel-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, HealthTick: time.Hour}
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
	var tok struct {
		Token struct{ Token string } `json:"token"`
	}
	call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
	var ep EnrollResponse
	call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": "grok-bot", "os": "linux"}}, &ep)
	if ep.Secret == "" {
		t.Fatal("not enrolled")
	}
	kernel := func() (json.RawMessage, *time.Time) {
		t.Helper()
		var list []struct {
			ID               string          `json:"id"`
			Kernel           json.RawMessage `json:"kernel"`
			KernelReportedAt *time.Time      `json:"kernel_reported_at"`
		}
		if code := call("GET", "/api/v1/endpoints", "", nil, &list); code != 200 {
			t.Fatalf("list: %d", code)
		}
		for _, e := range list {
			if e.ID == ep.EndpointID {
				return e.Kernel, e.KernelReportedAt
			}
		}
		t.Fatal("endpoint not listed")
		return nil, nil
	}

	// an older build: no kernel field
	if code := call("POST", "/ep/v1/heartbeat", ep.Secret, map[string]any{"policy_version": 0, "version": "v0.8.0"}, nil); code != 200 {
		t.Fatalf("heartbeat: %d", code)
	}
	if k, at := kernel(); string(k) != "null" && len(k) != 0 || at != nil {
		t.Fatalf("kernel before any report: %s %v", k, at)
	}

	// observe-only: BPF LSM off; unknown fields aren't stored
	if code := call("POST", "/ep/v1/heartbeat", ep.Secret, map[string]any{"policy_version": 0, "version": "v0.9.0",
		"kernel": map[string]any{"sensor": "tetragon", "bpf_lsm": false, "tetragon_connected": true, "extra": "x"}}, nil); code != 200 {
		t.Fatalf("heartbeat: %d", code)
	}
	k, at := kernel()
	var got map[string]any
	_ = json.Unmarshal(k, &got)
	if got["sensor"] != "tetragon" || got["bpf_lsm"] != false || got["tetragon_connected"] != true || got["extra"] != nil || at == nil {
		t.Fatalf("kernel: %s %v", k, at)
	}

	// a later heartbeat replaces it
	if code := call("POST", "/ep/v1/heartbeat", ep.Secret, map[string]any{"policy_version": 0, "version": "v0.9.0",
		"kernel": map[string]any{"sensor": "tetragon", "bpf_lsm": true, "tetragon_connected": false}}, nil); code != 200 {
		t.Fatalf("heartbeat: %d", code)
	}
	k, _ = kernel()
	got = nil
	_ = json.Unmarshal(k, &got)
	if got["bpf_lsm"] != true || got["tetragon_connected"] != false {
		t.Fatalf("kernel: %s", k)
	}
}
