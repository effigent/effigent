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
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/effigent/effigent/internal/shared/sign"
)

// TestBreakGlass: an admin creates a code (signed by the tenant key so an
// enrolled endpoint would verify it), it is listed active, and when the
// machine reports using it the code is marked used, a webhook fires and the
// use is audited.
func TestBreakGlass(t *testing.T) {
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
	tenant := fmt.Sprintf("org:bg-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, AllowInsecureWebhooks: true,
		WebhookPoll: 50 * time.Millisecond, HealthTick: time.Hour, ConsoleOrigin: "https://app.example"}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	var mu sync.Mutex
	var got []map[string]any
	recv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ev map[string]any
		_ = json.NewDecoder(r.Body).Decode(&ev)
		mu.Lock()
		got = append(got, ev)
		mu.Unlock()
	}))
	defer recv.Close()

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
	if _, err := st.CreateWebhook(ctx, tenant, "soc", recv.URL, []string{"break_glass.created", "break_glass.used"}, "test"); err != nil {
		t.Fatal(err)
	}
	waitFor := func(typ string, n int) {
		t.Helper()
		for i := 0; i < 60; i++ {
			mu.Lock()
			c := 0
			for _, g := range got {
				if g["type"] == typ {
					c++
				}
			}
			mu.Unlock()
			if c >= n {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("webhook %s not delivered", typ)
	}

	// Enroll a machine.
	var tok struct {
		Token struct{ Token string } `json:"token"`
	}
	call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
	var er EnrollResponse
	call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": "laptop", "os": "darwin"}}, &er)

	// Bad requests.
	if code := call("POST", "/api/v1/break-glass", "", map[string]any{"duration_minutes": 60}, nil); code != 400 {
		t.Fatalf("missing reason: %d", code)
	}
	if code := call("POST", "/api/v1/break-glass", "", map[string]any{"reason": "x", "duration_minutes": 9 * 60}, nil); code != 400 {
		t.Fatalf("too long: %d", code)
	}
	if code := call("POST", "/api/v1/break-glass", "", map[string]any{"reason": "x", "duration_minutes": 60, "endpoint_id": "ep_nope"}, nil); code != 404 {
		t.Fatalf("bad endpoint: %d", code)
	}

	// Create a machine-specific code.
	var created struct {
		ID, Code, EndpointID string
		Expiry               time.Time
	}
	if code := call("POST", "/api/v1/break-glass", "", map[string]any{"reason": "prod incident", "duration_minutes": 120, "endpoint_id": er.EndpointID}, &created); code != 200 {
		t.Fatalf("create: %d", code)
	}
	if created.Code == "" || created.ID == "" {
		t.Fatal("no code returned")
	}
	waitFor("break_glass.created", 1)

	// The code verifies against the tenant public key for this machine (what
	// the endpoint does), and not for another machine.
	pub := key.Public().(ed25519.PublicKey)
	g, err := sign.DecodeBreakGlass(pub, tenant, er.EndpointID, created.Code)
	if err != nil {
		t.Fatalf("endpoint would reject the code: %v", err)
	}
	if g.ID != created.ID || g.AllMachines {
		t.Fatalf("grant %+v", g)
	}
	if _, err := sign.DecodeBreakGlass(pub, tenant, "ep_other", created.Code); err != sign.ErrBadSignature {
		t.Fatalf("machine-specific code accepted elsewhere: %v", err)
	}

	// Listed active.
	var list struct {
		Codes []struct {
			ID, Status string
		}
	}
	call("GET", "/api/v1/break-glass", "", nil, &list)
	if len(list.Codes) != 1 || list.Codes[0].Status != "active" {
		t.Fatalf("list %+v", list)
	}

	// The machine reports using it.
	ev := map[string]any{"time": time.Now(), "type": "break_glass_start", "severity": "high", "rule": created.ID, "os_user": "alice"}
	if code := call("POST", "/ep/v1/events", er.Secret, map[string]any{"batch_id": "b1", "events": []any{ev}}, nil); code != 200 {
		t.Fatalf("ingest: %d", code)
	}
	waitFor("break_glass.used", 1)

	// Marked used.
	for i := 0; i < 40; i++ {
		call("GET", "/api/v1/break-glass", "", nil, &list)
		if len(list.Codes) == 1 && list.Codes[0].Status == "used" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if list.Codes[0].Status != "used" {
		t.Fatalf("code not marked used: %+v", list)
	}
	c, err := st.GetBreakGlass(ctx, tenant, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if c.UsedAt == nil || c.UsedBy != "alice" || c.UsedOn != er.EndpointID {
		t.Fatalf("use not recorded: %+v", c)
	}

	// Audited.
	entries, err := st.ListAudit(ctx, tenant, 50, "break_glass", "")
	if err != nil {
		t.Fatal(err)
	}
	var sawCreate, sawUse bool
	for _, e := range entries {
		switch e.Action {
		case "break_glass.create":
			sawCreate = true
		case "break_glass.used":
			sawUse = true
		}
	}
	if !sawCreate || !sawUse {
		t.Fatalf("audit: create=%v use=%v", sawCreate, sawUse)
	}

	// Revoke.
	if code := call("DELETE", "/api/v1/break-glass/"+created.ID, "", nil, nil); code != 200 {
		t.Fatalf("revoke: %d", code)
	}
}
