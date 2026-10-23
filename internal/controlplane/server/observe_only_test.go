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

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

func TestObserveOnlyOf(t *testing.T) {
	for in, want := range map[string]string{
		``:                                     "",
		`null`:                                 "",
		`{"sensor":"tetragon","bpf_lsm":true}`: "",
		`{"observe_only":"  "}`:                "",
		`{"observe_only":"BPF LSM off"}`:       "BPF LSM off",
		`not json`:                             "",
	} {
		if got := observeOnlyOf(json.RawMessage(in)); got != want {
			t.Errorf("observeOnlyOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestObserveOnlyAlerts: an observe-only machine's kernel policy failures raise
// no policy_load_failed; entering observe-only is audited exactly once (no
// email), repeated heartbeats add nothing, leaving and re-entering adds one;
// a capable machine's real failure still raises policy_load_failed.
func TestObserveOnlyAlerts(t *testing.T) {
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
	tenant := fmt.Sprintf("org:observe-%d", time.Now().UnixNano())
	rcpt := fmt.Sprintf("grok-bot-%d@example.com", time.Now().UnixNano())
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	sink := &smtpSink{}
	addr := sink.start(t)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, HealthTick: time.Hour, ConsoleOrigin: "https://app.example",
		Notify: &notify.Sender{SMTPURL: "smtp://u:p@" + addr, From: "Effigent <alerts@effigent.ai>"}}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	if err := st.PutNotificationSettings(ctx, tenant, store.NotificationSettings{Emails: []string{rcpt}}); err != nil {
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
	heartbeat := func(ep EnrollResponse, observeOnly string) {
		t.Helper()
		k := map[string]any{"sensor": "tetragon", "bpf_lsm": observeOnly == "", "tetragon_connected": true, "release": "5.15.0-100-generic"}
		if observeOnly != "" {
			k["observe_only"] = observeOnly
		}
		if code := call("POST", "/ep/v1/heartbeat", ep.Secret, map[string]any{"policy_version": 0, "version": "v0.9.0", "kernel": k}, nil); code != 200 {
			t.Fatalf("heartbeat: %d", code)
		}
	}
	fail := func(ep EnrollResponse, batch string) {
		t.Helper()
		ev := map[string]any{"type": "policy", "time": time.Now().UTC(), "severity": "high", "agent": "grok-bot",
			"rule": "eff-grok-bot-1-g1-lsm", "message": "failed to load kernel policy: operation not permitted"}
		if code := call("POST", "/ep/v1/events", ep.Secret, map[string]any{"batch_id": batch, "events": []any{ev}}, nil); code != 200 {
			t.Fatalf("events: %d", code)
		}
	}
	audits := func(action string) []store.AuditEntry {
		t.Helper()
		es, err := st.ListAudit(ctx, tenant, 100, action, "")
		if err != nil {
			t.Fatal(err)
		}
		return es
	}
	settle := func() { time.Sleep(200 * time.Millisecond) } // the ingest announcement is async
	emails := func() int {
		sink.mu.Lock()
		defer sink.mu.Unlock()
		return len(sink.rcpts)
	}

	box := enroll("grok-bot-oldkernel")
	// first heartbeat already observe-only: one entry, no email
	heartbeat(box, "BPF LSM off")
	if a := audits("endpoint.observe_only"); len(a) != 1 || a[0].ActorVia != "system" {
		t.Fatalf("entering observe-only: %+v", a)
	} else {
		var d struct{ Reason, Release string }
		_ = json.Unmarshal(a[0].Details, &d)
		if d.Reason != "BPF LSM off" || d.Release != "5.15.0-100-generic" {
			t.Errorf("details %s", a[0].Details)
		}
	}
	// repeated heartbeats and a changed reason: nothing more
	heartbeat(box, "BPF LSM off")
	heartbeat(box, "BPF LSM off")
	heartbeat(box, "no BTF; BPF LSM off")
	if n := len(audits("endpoint.observe_only")); n != 1 {
		t.Fatalf("%d observe-only entries after repeated heartbeats, want 1", n)
	}
	// repeated policy failures (an older effigentd still sends them high): no alert
	fail(box, "b-1")
	fail(box, "b-2")
	fail(box, "b-3")
	settle()
	if a := audits("endpoint.policy_load_failed"); len(a) != 0 {
		t.Fatalf("policy_load_failed on an observe-only machine: %+v", a)
	}
	if n := emails(); n != 0 {
		t.Fatalf("%d emails for an observe-only machine", n)
	}
	// leaves observe-only (kernel upgrade), then comes back: one more entry
	heartbeat(box, "")
	if n := len(audits("endpoint.observe_only")); n != 1 {
		t.Fatalf("leaving observe-only added an entry (%d)", n)
	}
	heartbeat(box, "kernel 5.4.0 older than 5.12")
	heartbeat(box, "kernel 5.4.0 older than 5.12")
	if n := len(audits("endpoint.observe_only")); n != 2 {
		t.Fatalf("%d observe-only entries after re-entering, want 2", n)
	}
	if n := emails(); n != 0 {
		t.Fatalf("%d emails for entering observe-only", n)
	}

	// a capable machine: its real failure is still an alert (emailed by default)
	capable := enroll("grok-bot-capable")
	heartbeat(capable, "")
	fail(capable, "c-1")
	for range 100 {
		if len(audits("endpoint.policy_load_failed")) > 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	a := audits("endpoint.policy_load_failed")
	if len(a) != 1 || a[0].Target != capable.EndpointID || emailChannel(a[0]) != "sent" {
		t.Fatalf("capable machine's failure: %+v", a)
	}
	if n := len(audits("endpoint.observe_only")); n != 2 {
		t.Fatalf("a capable machine was audited observe-only (%d)", n)
	}

	// Inventory and the posture report count the observe-only machine
	var inv struct {
		Machines    int `json:"machines"`
		ObserveOnly int `json:"observe_only_machines"`
	}
	if code := call("GET", "/api/v1/inventory?days=7", "", nil, &inv); code != 200 || inv.Machines != 2 || inv.ObserveOnly != 1 {
		t.Fatalf("inventory %d %+v", code, inv)
	}
	var rep struct {
		Machines struct {
			ObserveOnly int                  `json:"observe_only"`
			List        []observeOnlyMachine `json:"observe_only_machines"`
		} `json:"machines"`
	}
	if code := call("GET", "/api/v1/report?days=7", "", nil, &rep); code != 200 || rep.Machines.ObserveOnly != 1 || len(rep.Machines.List) != 1 ||
		rep.Machines.List[0].Hostname != "grok-bot-oldkernel" || rep.Machines.List[0].Reason != "kernel 5.4.0 older than 5.12" {
		t.Fatalf("report %d %+v", code, rep.Machines)
	}
}
