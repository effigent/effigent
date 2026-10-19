package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
)

type received struct {
	Type, Sig, Body string
	Data            map[string]any
}

func TestIntegrations(t *testing.T) {
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
	tenant := fmt.Sprintf("org:integrations-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	srv := httptest.NewServer((&Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, ConsoleOrigin: "https://app.example",
		AllowInsecureWebhooks: true, WebhookPoll: 100 * time.Millisecond}).Handler())
	defer srv.Close()

	// the receiver (a Windmill route, say)
	var mu sync.Mutex
	var got []received
	fail := 0 // answer 400 to this many requests first
	recv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var ev struct {
			Type string         `json:"type"`
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(b, &ev)
		mu.Lock()
		defer mu.Unlock()
		if fail > 0 {
			fail--
			http.Error(w, "nope", 400)
			return
		}
		got = append(got, received{Type: r.Header.Get("X-Effigent-Event"), Sig: r.Header.Get("X-Effigent-Signature"), Body: string(b), Data: ev.Data})
	}))
	defer recv.Close()
	waitFor := func(typ string, n int) []received {
		t.Helper()
		for i := 0; i < 50; i++ {
			mu.Lock()
			var hits []received
			for _, g := range got {
				if g.Type == typ {
					hits = append(hits, g)
				}
			}
			mu.Unlock()
			if len(hits) >= n {
				return hits
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("no %d× %s delivered", n, typ)
		return nil
	}

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

	// ---- webhook ----
	var hook webhookView
	if code := call("POST", "/api/v1/webhooks", "", map[string]any{"name": "windmill", "url": recv.URL + "/api/r/effigent?token=wm_secret",
		"events": []string{"approval.requested", "approval.decided", "action.blocked", "endpoint.enrolled", "policy.published"}}, &hook); code != 201 {
		t.Fatalf("create webhook: %d", code)
	}
	if !strings.HasPrefix(hook.Secret, "whsec_") {
		t.Fatalf("secret not returned at creation: %+v", hook)
	}
	var list []map[string]any
	call("GET", "/api/v1/webhooks", "", nil, &list)
	raw, _ := json.Marshal(list)
	if len(list) != 1 || strings.Contains(string(raw), "wm_secret") || strings.Contains(string(raw), hook.Secret) {
		t.Fatalf("list must not reveal the URL's token or the secret: %s", raw)
	}
	if code := call("POST", "/api/v1/webhooks", "", map[string]any{"url": recv.URL, "events": []string{"everything"}}, nil); code != 400 {
		t.Fatalf("unknown event accepted: %d", code)
	}

	// ---- API key ----
	var k store.APIKey
	if code := call("POST", "/api/v1/api-keys", "", map[string]any{"name": "windmill", "scopes": []string{"approvals"}}, &k); code != 201 {
		t.Fatalf("create key: %d", code)
	}
	if !strings.HasPrefix(k.Key, "efk_") || len(k.Scopes) != 2 {
		t.Fatalf("key %+v (read is added to approvals)", k)
	}
	if code := call("GET", "/api/v1/endpoints", k.Key, nil, nil); code != 200 {
		t.Fatalf("key read: %d", code)
	}
	if code := call("PUT", "/api/v1/policy", k.Key, map[string]any{"body": "defaults: {mode: monitor}\n"}, nil); code != 403 {
		t.Fatalf("key without policy scope published: %d", code)
	}
	if code := call("POST", "/api/v1/api-keys", k.Key, map[string]any{"name": "x", "scopes": []string{"read"}}, nil); code != 403 {
		t.Fatalf("a key minted a key: %d", code)
	}
	if code := call("POST", "/api/v1/webhooks", k.Key, map[string]any{"url": recv.URL}, nil); code != 403 {
		t.Fatalf("a key made a webhook: %d", code)
	}

	// enrollment -> endpoint.enrolled
	var tok struct {
		Token struct{ Token string } `json:"token"`
	}
	call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
	var er EnrollResponse
	call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": "dana-mbp", "os": "darwin"}}, &er)
	if e := waitFor("endpoint.enrolled", 1); e[0].Data["hostname"] != "dana-mbp" {
		t.Fatalf("enrolled: %+v", e[0].Data)
	}

	// approval.requested, signed
	var ar endpointApprovalResp
	call("POST", "/ep/v1/approvals", er.Secret, map[string]any{"fingerprint": "fp1:" + strings.Repeat("ab", 32), "agent": "claude-code",
		"tool": "Bash", "summary": "Bash: git push --force", "rule": "command_approve", "reason": "needs approval"}, &ar)
	req := waitFor("approval.requested", 1)[0]
	ts, v1, _ := strings.Cut(strings.TrimPrefix(req.Sig, "t="), ",v1=")
	mac := hmac.New(sha256.New, []byte(hook.Secret))
	mac.Write([]byte(ts + "." + req.Body))
	if hex.EncodeToString(mac.Sum(nil)) != v1 {
		t.Fatalf("bad signature %q", req.Sig)
	}
	if req.Data["review_url"] != "https://app.example/approvals?id="+ar.ID {
		t.Fatalf("review_url: %v", req.Data["review_url"])
	}

	// an automation re-reads the request, then decides it with the API key
	var a store.Approval
	if code := call("GET", "/api/v1/approvals/"+ar.ID, k.Key, nil, &a); code != 200 || a.State != "pending" {
		t.Fatalf("get approval: %d %+v", code, a)
	}
	if code := call("POST", "/api/v1/approvals/"+ar.ID+"/decision", k.Key, map[string]any{"decision": "approve", "name": "Dana (Slack)"}, nil); code != 200 {
		t.Fatalf("key decision: %d", code)
	}
	dec := waitFor("approval.decided", 1)[0]
	if ap, _ := dec.Data["approval"].(map[string]any); ap["state"] != "approved" || ap["decided_by_name"] != "Dana (Slack)" || ap["decided_by"] != "apikey:"+k.ID {
		t.Fatalf("decided: %+v", dec.Data)
	}

	// action.blocked: capped at webhookCap per minute, the rest counted
	var evs []map[string]any
	for i := 0; i < webhookCap+5; i++ {
		evs = append(evs, map[string]any{"type": "blocked", "agent": "claude-code", "target": fmt.Sprintf("exec curl #%d", i)})
	}
	call("POST", "/ep/v1/events", er.Secret, map[string]any{"events": evs}, nil)
	waitFor("action.blocked", webhookCap)
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	n := 0
	for _, g := range got {
		if g.Type == "action.blocked" {
			n++
		}
	}
	mu.Unlock()
	call("GET", "/api/v1/webhooks", "", nil, &list)
	if n != webhookCap || list[0]["dropped"].(float64) != 5 {
		t.Fatalf("cap: delivered %d, dropped %v", n, list[0]["dropped"])
	}

	// a 4xx answer is final: the delivery is marked failed, not retried
	mu.Lock()
	fail = 1
	mu.Unlock()
	if code := call("PUT", "/api/v1/policy", "", map[string]any{"body": "defaults:\n  mode: monitor\n", "comment": "x"}, nil); code != 200 {
		t.Fatalf("publish: %d", code)
	}
	var ds []store.Delivery
	for i := 0; i < 30; i++ {
		call("GET", "/api/v1/webhooks/"+hook.ID+"/deliveries?limit=5", "", nil, &ds)
		if len(ds) > 0 && ds[0].EventType == "policy.published" && ds[0].State != "pending" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if ds[0].State != "failed" || ds[0].LastStatus == nil || *ds[0].LastStatus != 400 {
		t.Fatalf("delivery after a 400: %+v", ds[0])
	}

	// test button
	var tr map[string]any
	call("POST", "/api/v1/webhooks/"+hook.ID+"/test", "", nil, &tr)
	if tr["ok"] != true {
		t.Fatalf("test: %v", tr)
	}
	waitFor("test", 1)

	// revoked keys stop working
	call("DELETE", "/api/v1/api-keys/"+k.ID, "", nil, nil)
	if code := call("GET", "/api/v1/endpoints", k.Key, nil, nil); code != 401 {
		t.Fatalf("revoked key: %d", code)
	}
}

func TestWebhookTargets(t *testing.T) {
	s := &Server{}
	for _, u := range []string{"http://hooks.example.com/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://u:p@example.com/", "ftp://x.io"} {
		if s.checkWebhookURL(u) == nil {
			t.Fatalf("accepted %s", u)
		}
	}
	if err := s.checkWebhookURL("https://app.windmill.dev/api/w/acme/jobs/run/p/f/sec/effigent?token=x"); err != nil {
		t.Fatal(err)
	}
	// a public-looking name that resolves inside is refused when dialing
	_, err := s.sendWebhook(context.Background(), "https://localhost:1/x", "s", "test", "evt", "{}")
	if err == nil || !strings.Contains(err.Error(), "internal address") {
		t.Fatalf("localhost dial: %v", err)
	}
	for ip, pub := range map[string]bool{"8.8.8.8": true, "10.1.2.3": false, "100.64.1.1": false, "fd00::1": false, "::1": false, "2606:4700::1111": true} {
		if publicIP(net.ParseIP(ip)) != pub {
			t.Fatalf("publicIP(%s) != %v", ip, pub)
		}
	}
}
