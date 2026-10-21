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
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/jackc/pgx/v5"
)

func TestHookProblems(t *testing.T) {
	ok := hookAgentState{Present: true, State: "installed", File: "/f"}
	gone := hookAgentState{Present: true, State: "missing", File: "/f"}
	absent := hookAgentState{Present: false, State: "missing", File: "/f"}
	cases := []struct {
		name string
		r    hookReport
		want []string
	}{
		{"hooks machine, installed", hookReport{Sensor: "hooks", Agents: map[string]hookAgentState{"claude": ok}}, nil},
		{"hooks machine, agent there, hook gone", hookReport{Sensor: "hooks", Agents: map[string]hookAgentState{"claude": gone}}, []string{"claude"}},
		{"hooks machine, no such agent", hookReport{Sensor: "hooks", Agents: map[string]hookAgentState{"codex": absent}}, nil},
		{"kernel machine never hooked", hookReport{Sensor: "tetragon", Agents: map[string]hookAgentState{"claude": gone}}, nil},
		{"kernel machine, hook removed", hookReport{Sensor: "tetragon", Agents: map[string]hookAgentState{"claude": gone}, Expected: []string{"claude"}}, []string{"claude"}},
		{"turned off by a user", hookReport{Sensor: "hooks", Agents: map[string]hookAgentState{"gemini": {Present: true, State: "installed", DisabledBy: []string{"dana"}}}}, []string{"gemini"}},
	}
	for _, c := range cases {
		got := c.r.problems()
		if len(got) != len(c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
			continue
		}
		for _, w := range c.want {
			if _, ok := got[w]; !ok {
				t.Errorf("%s: %s missing from %v", c.name, w, got)
			}
		}
	}
}

// TestEndpointHealth: hook reports are stored and a hook that goes missing is
// announced once (webhook + audit); a machine that went silent is reported
// offline once, as stopped when its last word was daemon_stop, and online
// when it's back; tenants can't set the threshold under 2 minutes.
func TestEndpointHealth(t *testing.T) {
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
	db, err := pgx.Connect(ctx, dbURL) // to make machines older than they are
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)

	tenant := fmt.Sprintf("org:health-%d", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, AllowInsecureWebhooks: true, WebhookPoll: 50 * time.Millisecond,
		HealthTick: time.Hour, ConsoleOrigin: "https://app.example"}
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
	if _, err := st.CreateWebhook(ctx, tenant, "soc", recv.URL, []string{"endpoint.hooks_missing", "endpoint.offline", "endpoint.online"}, "test"); err != nil {
		t.Fatal(err)
	}
	delivered := func(typ string) []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		var out []map[string]any
		for _, g := range got {
			if g["type"] == typ {
				out = append(out, g["data"].(map[string]any))
			}
		}
		return out
	}
	waitFor := func(typ string, n int) []map[string]any {
		t.Helper()
		for i := 0; i < 60; i++ {
			if d := delivered(typ); len(d) >= n {
				return d
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("no %d× %s delivered (got %v)", n, typ, delivered(typ))
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
	enroll := func(host string) EnrollResponse {
		var tok struct {
			Token struct{ Token string } `json:"token"`
		}
		call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
		var er EnrollResponse
		call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": host, "os": "darwin"}}, &er)
		return er
	}
	heartbeat := func(ep EnrollResponse, hooks any) {
		t.Helper()
		body := map[string]any{"policy_version": 0, "version": "v0.6.0"}
		if hooks != nil {
			body["hooks"] = hooks
		}
		if code := call("POST", "/ep/v1/heartbeat", ep.Secret, body, nil); code != 200 {
			t.Fatalf("heartbeat: %d", code)
		}
	}
	report := func(sensor string, agents map[string]any) map[string]any {
		return map[string]any{"sensor": sensor, "agents": agents}
	}
	installed := map[string]any{"present": true, "state": "installed", "file": "/Library/Application Support/ClaudeCode/managed-settings.json"}
	removed := map[string]any{"present": true, "state": "missing", "file": "/Library/Application Support/ClaudeCode/managed-settings.json"}
	noCodex := map[string]any{"present": false, "state": "missing", "file": "/etc/codex/requirements.toml"}
	endpoint := func(id string) store.Endpoint {
		t.Helper()
		e, err := st.GetEndpoint(ctx, tenant, id)
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	audits := func(action string) []store.AuditEntry {
		t.Helper()
		es, err := st.ListAudit(ctx, tenant, 100, action, "")
		if err != nil {
			t.Fatal(err)
		}
		return es
	}

	// ---- hooks ----
	mac, linux := enroll("dana-mbp"), enroll("build-1")
	heartbeat(mac, report("hooks", map[string]any{"claude": installed, "codex": noCodex}))
	if e := endpoint(mac.EndpointID); e.HooksReportedAt == nil || parseHookReport(e.Hooks) == nil || fmt.Sprint(parseHookReport(e.Hooks).Expected) != "[claude]" {
		t.Fatalf("hooks not stored: %s", e.Hooks)
	}
	heartbeat(mac, nil) // older builds and unchanged state send none: the report stays
	if e := endpoint(mac.EndpointID); e.Hooks == nil {
		t.Fatal("a heartbeat without hooks cleared the report")
	}
	heartbeat(mac, report("hooks", map[string]any{"claude": removed, "codex": noCodex}))
	d := waitFor("endpoint.hooks_missing", 1)
	agents := d[0]["agents"].([]any)
	if len(agents) != 1 || agents[0].(map[string]any)["agent"] != "claude" || d[0]["review_url"] == nil {
		t.Fatalf("hooks_missing %v", d[0])
	}
	heartbeat(mac, report("hooks", map[string]any{"claude": removed, "codex": noCodex})) // same state again: no second alert
	// a kernel-enforced machine that never had hooks is not an alarm
	heartbeat(linux, report("tetragon", map[string]any{"claude": removed}))
	time.Sleep(300 * time.Millisecond)
	if n := len(delivered("endpoint.hooks_missing")); n != 1 {
		t.Fatalf("%d hooks_missing deliveries, want 1", n)
	}
	if a := audits("endpoint.hooks_missing"); len(a) != 1 || a[0].ActorVia != "system" || a[0].Target != mac.EndpointID {
		t.Fatalf("hooks_missing audit %+v", a)
	}
	heartbeat(mac, report("hooks", map[string]any{"claude": installed, "codex": noCodex}))
	if a := audits("endpoint.hooks_restored"); len(a) != 1 {
		t.Fatalf("hooks_restored audit %+v", a)
	}
	// once seen in place, removing it alarms on a kernel machine too
	heartbeat(linux, report("tetragon", map[string]any{"claude": installed}))
	heartbeat(linux, report("tetragon", map[string]any{"claude": removed}))
	waitFor("endpoint.hooks_missing", 2)

	// ---- offline ----
	stopAt := time.Now().Add(-10 * time.Minute).UTC()
	if code := call("POST", "/ep/v1/events", mac.Secret, map[string]any{"events": []map[string]any{{"type": "daemon_stop", "time": stopAt,
		"severity": "high", "target": "SIGTERM", "rule": "launchd", "message": "effigentd is stopping"}}}, nil); code != 200 {
		t.Fatalf("events: %d", code)
	}
	if _, err := db.Exec(ctx, `update cp.endpoints set last_seen = $2 where id = $1`, mac.EndpointID, stopAt.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `update cp.endpoints set last_seen = now() - interval '20 minutes' where id = $1`, linux.EndpointID); err != nil {
		t.Fatal(err)
	}
	s.checkEndpointHealth(ctx)
	s.checkEndpointHealth(ctx) // once per silence
	off := waitFor("endpoint.offline", 2)
	time.Sleep(200 * time.Millisecond)
	if n := len(delivered("endpoint.offline")); n != 2 {
		t.Fatalf("%d offline deliveries, want 2", n)
	}
	by := map[string]map[string]any{}
	for _, o := range off {
		by[o["endpoint_id"].(string)] = o
	}
	if m := by[mac.EndpointID]; m["reason"] != "stopped" || m["stop"].(map[string]any)["signal"] != "SIGTERM" || m["stop"].(map[string]any)["via"] != "launchd" {
		t.Fatalf("mac offline %v", m)
	}
	if l := by[linux.EndpointID]; l["reason"] != "silent" || l["stop"] != nil {
		t.Fatalf("linux offline %v", l)
	}
	if e := endpoint(mac.EndpointID); e.OfflineAt == nil || e.StoppedAt == nil {
		t.Fatalf("mac not marked: %+v", e)
	}
	// an older daemon_stop replayed from the spool doesn't replace the newer one
	if code := call("POST", "/ep/v1/events", mac.Secret, map[string]any{"events": []map[string]any{{"type": "daemon_stop", "time": stopAt.Add(-time.Hour),
		"target": "SIGINT"}}}, nil); code != 200 {
		t.Fatalf("events: %d", code)
	}
	if e := endpoint(mac.EndpointID); !e.StoppedAt.Equal(stopAt) || !strings.Contains(string(e.Stop), "SIGTERM") {
		t.Fatalf("stop replaced: %v %s", e.StoppedAt, e.Stop)
	}
	heartbeat(mac, nil) // it's back (the events above also count)
	s.checkEndpointHealth(ctx)
	on := waitFor("endpoint.online", 1)
	if on[0]["endpoint_id"] != mac.EndpointID || on[0]["offline_since"] == nil {
		t.Fatalf("online %v", on[0])
	}
	if e := endpoint(mac.EndpointID); e.OfflineAt != nil {
		t.Fatal("still marked offline")
	}
	if _, ok := stoppedDeliberately(endpoint(mac.EndpointID)); ok {
		t.Fatal("a machine heard from after its stop still counts as stopped")
	}
	if a := audits("endpoint.offline"); len(a) != 2 {
		t.Fatalf("offline audit %+v", a)
	}
	if a := audits("endpoint.online"); len(a) != 1 || a[0].ActorVia != "system" {
		t.Fatalf("online audit %+v", a)
	}

	// ---- settings ----
	var h map[string]any
	if code := call("GET", "/api/v1/endpoint-health", "", nil, &h); code != 200 || h["offline_after_minutes"] != float64(5) || h["min_minutes"] != float64(2) {
		t.Fatalf("get %d %v", code, h)
	}
	if code := call("PUT", "/api/v1/endpoint-health", "", map[string]any{"offline_after_minutes": 1}, nil); code != 400 {
		t.Fatalf("1 minute accepted: %d", code)
	}
	if code := call("PUT", "/api/v1/endpoint-health", "", map[string]any{"offline_after_minutes": 30, "email_offline": false}, &h); code != 200 ||
		h["offline_after_minutes"] != float64(30) || h["email_offline"] != false || h["email_hooks"] != true {
		t.Fatalf("put %d %v", code, h)
	}
	// 20 minutes of silence is under this tenant's 30
	if _, err := db.Exec(ctx, `update cp.endpoints set last_seen = now() - interval '20 minutes' where id = $1`, mac.EndpointID); err != nil {
		t.Fatal(err)
	}
	s.checkEndpointHealth(ctx)
	if e := endpoint(mac.EndpointID); e.OfflineAt != nil {
		t.Fatal("marked offline under the tenant's threshold")
	}
	if a := audits("endpoint_health.update"); len(a) != 1 {
		t.Fatalf("settings audit %+v", a)
	}
}
