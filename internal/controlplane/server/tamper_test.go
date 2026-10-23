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

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/jackc/pgx/v5"
)

func TestTamperFromBatch(t *testing.T) {
	at := time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)
	ev := func(typ, sev string, off time.Duration, body string) store.Event {
		return store.Event{Time: at.Add(off), Type: typ, Severity: sev, Agent: "grok-bot", Body: json.RawMessage(body)}
	}
	got := tamperFromBatch([]store.Event{
		ev("policy", "high", 2*time.Second, `{"rule":"p-2","message":"failed to load kernel policy: second"}`),
		ev("policy", "high", time.Second, `{"rule":"p-1","message":"failed to load kernel policy: first"}`),
		ev("policy", "medium", 3*time.Second, `{"message":"domain_deny x resolves to no address"}`), // not a load failure
		ev("policy", "info", 4*time.Second, `{"message":"3 kernel policies loaded"}`),
		ev("daemon_unclean_restart", "high", 0, `{"shutdown":"no","message":"previous run ended"}`),
		ev("exec", "info", 0, `{}`),
	})
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	p, u := got[0], got[1] // in the order first seen
	if u.Kind != store.TamperUnclean || u.Shutdown != "no" || u.Count != 1 {
		t.Errorf("unclean %+v", u)
	}
	if p.Kind != store.TamperPolicyFailure || p.Count != 2 || p.Rule != "p-2" || !strings.Contains(p.Message, "second") {
		t.Errorf("policy %+v (want the newest, counted twice)", p)
	}
	if got := tamperFromBatch([]store.Event{ev("daemon_stop", "high", 0, `{"shutdown":"no"}`)}); len(got) != 0 {
		t.Errorf("daemon_stop is announced by the offline detector, not ingest: %+v", got)
	}
}

// TestTamperAlerts: with default settings a deliberate stop (the machine kept
// running, it didn't come back) is emailed once; a restart, a sleep, a
// silence, a shutdown stop and a stop effigentd couldn't classify aren't; a
// second stop within the hour isn't; an unclean restart on the same boot and a
// failed kernel policy load are emailed once each, a power loss isn't.
func TestTamperAlerts(t *testing.T) {
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

	tenant := fmt.Sprintf("org:tamper-%d", time.Now().UnixNano())
	rcpt := fmt.Sprintf("grok-bot-%d@example.com", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	sink := &smtpSink{}
	addr := sink.start(t)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, AllowInsecureWebhooks: true, WebhookPoll: 50 * time.Millisecond,
		HealthTick: time.Hour, ConsoleOrigin: "https://app.example",
		Notify: &notify.Sender{SMTPURL: "smtp://u:p@" + addr, From: "Effigent <alerts@effigent.ai>"}}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	if err := st.PutNotificationSettings(ctx, tenant, store.NotificationSettings{Emails: []string{rcpt}}); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var hooks []map[string]any
	recv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ev map[string]any
		_ = json.NewDecoder(r.Body).Decode(&ev)
		if ev["type"] == "endpoint.tamper" {
			mu.Lock()
			hooks = append(hooks, ev["data"].(map[string]any))
			mu.Unlock()
		}
	}))
	defer recv.Close()
	if _, err := st.CreateWebhook(ctx, tenant, "soc", recv.URL, []string{"endpoint.tamper"}, "test"); err != nil {
		t.Fatal(err)
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
		call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": host, "os": "linux"}}, &er)
		return er
	}
	post := func(ep EnrollResponse, batch string, evs ...map[string]any) {
		t.Helper()
		if code := call("POST", "/ep/v1/events", ep.Secret, map[string]any{"batch_id": batch, "events": evs}, nil); code != 200 {
			t.Fatalf("events: %d", code)
		}
	}
	stop := func(at time.Time, shutdown string) map[string]any {
		e := map[string]any{"type": "daemon_stop", "time": at, "severity": "high", "target": "SIGTERM", "rule": "systemd",
			"message": "effigentd is stopping (SIGTERM via systemd)"}
		if shutdown != "" {
			e["shutdown"] = shutdown
		}
		return e
	}
	// silent: nothing heard after at; the detector runs
	silentSince := func(ep EnrollResponse, at time.Time) {
		t.Helper()
		if _, err := db.Exec(ctx, `update cp.endpoints set last_seen = $2 where id = $1`, ep.EndpointID, at); err != nil {
			t.Fatal(err)
		}
		s.checkEndpointHealth(ctx)
		if e, _ := st.GetEndpoint(ctx, tenant, ep.EndpointID); e.OfflineAt == nil {
			t.Fatal("not marked offline")
		}
	}
	wake := func(ep EnrollResponse) {
		t.Helper()
		if code := call("POST", "/ep/v1/heartbeat", ep.Secret, map[string]any{"policy_version": 0, "version": "v0.9.0"}, nil); code != 200 {
			t.Fatalf("heartbeat: %d", code)
		}
		s.checkEndpointHealth(ctx)
	}
	emails := func() int {
		sink.mu.Lock()
		defer sink.mu.Unlock()
		n := 0
		for _, r := range sink.rcpts {
			if r == rcpt {
				n++
			}
		}
		return n
	}
	audits := func(action string) []store.AuditEntry {
		t.Helper()
		es, err := st.ListAudit(ctx, tenant, 100, action, "")
		if err != nil {
			t.Fatal(err)
		}
		return es // newest first
	}
	// waitAudits waits for an async announcement (ingest answers first)
	waitAudits := func(action string, n int) []store.AuditEntry {
		t.Helper()
		for range 100 {
			if a := audits(action); len(a) >= n {
				return a
			}
			time.Sleep(30 * time.Millisecond)
		}
		t.Fatalf("fewer than %d %s audit entries", n, action)
		return nil
	}
	wantEmails := func(n int, what string) {
		t.Helper()
		time.Sleep(150 * time.Millisecond) // nothing else in flight
		if got := emails(); got != n {
			t.Fatalf("%s: %d emails, want %d", what, got, n)
		}
	}

	var h map[string]any
	if code := call("GET", "/api/v1/endpoint-health", "", nil, &h); code != 200 || h["email_tamper"] != true || h["offline_alert_interval_minutes"] != float64(0) {
		t.Fatalf("defaults %d %v", code, h)
	}

	// ---- daemon stops ----
	box := enroll("grok-bot-linux")
	// a restart (or an upgrade): back right after the stop, so never offline
	post(box, "b-restart", stop(time.Now().Add(-30*time.Minute), "no"))
	wake(box)
	if e, _ := st.GetEndpoint(ctx, tenant, box.EndpointID); e.OfflineAt != nil {
		t.Fatal("a restart marked the machine offline")
	}
	wantEmails(0, "restart")

	// deliberate stop, machine kept running, didn't come back: one email
	stopAt := time.Now().Add(-10 * time.Minute).UTC()
	post(box, "b-stop-1", stop(stopAt, "no"))
	silentSince(box, stopAt.Add(time.Second))
	s.checkEndpointHealth(ctx) // once per silence
	wantEmails(1, "deliberate stop")
	if a := audits("endpoint.daemon_stopped"); len(a) != 1 || emailChannel(a[0]) != "sent" || a[0].ActorVia != "system" {
		t.Fatalf("stop audit %+v", a)
	}
	if a := audits("endpoint.offline"); len(a) != 1 || emailChannel(a[0]) != "see endpoint.daemon_stopped (sent)" {
		t.Fatalf("offline audit %+v", a)
	}

	// stopped again within the hour: audited, no second email
	wake(box)
	stopAt = time.Now().Add(-8 * time.Minute).UTC()
	post(box, "b-stop-2", stop(stopAt, "no"))
	silentSince(box, stopAt.Add(time.Second))
	wantEmails(1, "second stop within the cooldown")
	if a := audits("endpoint.daemon_stopped"); len(a) != 2 || emailChannel(a[0]) != "suppressed: alerted within the last hour" {
		t.Fatalf("second stop audit %+v", a)
	}

	// a stop during a shutdown, and one effigentd couldn't classify (macOS,
	// older builds): treated like a silence, so no email by default
	// (one machine each time: enrollment allows a burst of 5 per IP)
	sdBox := enroll("grok-bot-sd")
	for i, sd := range []string{"system", "unknown", ""} {
		at := time.Now().Add(time.Duration(i-30) * time.Minute).UTC()
		post(sdBox, fmt.Sprintf("b-sd-%d", i), stop(at, sd))
		silentSince(sdBox, at.Add(time.Second))
		wake(sdBox)
	}
	wantEmails(1, "shutdown / unknown stops")
	offl := audits("endpoint.offline")
	if len(offl) != 5 {
		t.Fatalf("%d offline audits", len(offl))
	}
	for _, a := range offl[:3] {
		var d struct{ Channels map[string]string }
		_ = json.Unmarshal(a.Details, &d)
		if !strings.HasPrefix(d.Channels["tamper"], "skipped: ") || d.Channels["email"] != "off: offline alerts set to never" {
			t.Fatalf("shutdown stop audit %s", a.Details)
		}
	}

	// sleep / silence (no daemon_stop): unchanged, no email by default
	lap := enroll("grok-bot-laptop")
	silentSince(lap, time.Now().Add(-20*time.Minute))
	wake(lap)
	silentSince(lap, time.Now().Add(-20*time.Minute))
	wantEmails(1, "sleep")

	// ---- unclean restarts ----
	unclean := func(shutdown string) map[string]any {
		return map[string]any{"type": "daemon_unclean_restart", "time": time.Now().UTC(), "severity": "high", "rule": "systemd",
			"shutdown": shutdown, "message": "effigentd's previous run ended without stopping cleanly"}
	}
	k := enroll("grok-bot-killed")
	post(k, "b-u1", unclean("no"))
	waitAudits("endpoint.unclean_restart", 1)
	wantEmails(2, "unclean restart on the same boot")
	post(k, "b-u1", unclean("no")) // the same batch replayed: dropped
	post(k, "b-u2", unclean("no")) // killed again within the hour
	waitAudits("endpoint.unclean_restart", 2)
	wantEmails(2, "second unclean restart within the cooldown")
	if a := audits("endpoint.unclean_restart"); len(a) != 2 || emailChannel(a[0]) != "suppressed: alerted within the last hour" {
		t.Fatalf("unclean audits %+v", a)
	}
	post(lap, "b-u3", unclean("system")) // power loss: the machine itself rebooted
	waitAudits("endpoint.unclean_restart", 3)
	wantEmails(2, "power loss")
	if a := audits("endpoint.unclean_restart"); !strings.HasPrefix(emailChannel(a[0]), "skipped: the machine itself restarted") {
		t.Fatalf("power loss audit %s", a[0].Details)
	}

	// ---- kernel policy load failures ----
	fail := func(rule string) map[string]any {
		return map[string]any{"type": "policy", "time": time.Now().UTC(), "severity": "high", "agent": "grok-bot", "rule": rule,
			"message": "failed to load kernel policy: operation not permitted"}
	}
	pf := enroll("grok-bot-nolsm")
	post(pf, "b-p1", fail("effigent-grok-bot-1-lsm"), fail("effigent-grok-bot-1-guard"),
		map[string]any{"type": "policy", "time": time.Now().UTC(), "severity": "info", "message": "2 kernel policies loaded"})
	a := waitAudits("endpoint.policy_load_failed", 1)
	wantEmails(3, "policy load failure")
	var d struct {
		Count    int               `json:"count"`
		Channels map[string]string `json:"channels"`
	}
	_ = json.Unmarshal(a[0].Details, &d)
	if d.Count != 2 || d.Channels["email"] != "sent" {
		t.Fatalf("policy audit %s", a[0].Details)
	}
	post(pf, "b-p2", fail("effigent-grok-bot-2-lsm")) // the next agent start: within the day
	waitAudits("endpoint.policy_load_failed", 2)
	wantEmails(3, "policy load failure within the cooldown")

	// webhooks: one per alert that went out
	for range 100 {
		mu.Lock()
		n := len(hooks)
		mu.Unlock()
		if n >= 3 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	kinds := map[string]int{}
	for _, h := range hooks {
		kinds[h["kind"].(string)]++
	}
	mu.Unlock()
	if kinds[store.TamperStopped] != 1 || kinds[store.TamperUnclean] != 1 || kinds[store.TamperPolicyFailure] != 1 || len(kinds) != 3 {
		t.Fatalf("endpoint.tamper webhooks %v", kinds)
	}

	// ---- turned off ----
	if code := call("PUT", "/api/v1/endpoint-health", "", map[string]any{"email_tamper": false}, &h); code != 200 || h["email_tamper"] != false {
		t.Fatalf("put %d %v", code, h)
	}
	post(box, "b-u4", unclean("no")) // box has no unclean restart alert yet
	if a := waitAudits("endpoint.unclean_restart", 4); emailChannel(a[0]) != "off" {
		t.Fatalf("email_tamper off audit %s", a[0].Details)
	}
	wantEmails(3, "tamper emails off")

	// the claim is exactly-once across concurrent callers
	var wg sync.WaitGroup
	won := 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := st.ClaimTamperAlert(ctx, lap.EndpointID, store.TamperUnclean, time.Hour)
			if err != nil {
				t.Error(err)
			}
			if ok {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if won != 1 {
		t.Fatalf("%d concurrent claims won, want 1", won)
	}
}
