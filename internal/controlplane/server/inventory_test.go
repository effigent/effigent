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

// TestInventoryReportBaselines: one ingest fills the inventory rollups
// (agents, MCP servers, enforcement); the inventory page reads them with
// coverage and unmanaged people; first-seen signals stay quiet while an
// agent is new on a machine, then fire once per new value (webhook, capped);
// the posture report counts the period; a due report email is claimed once.
func TestInventoryReportBaselines(t *testing.T) {
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

	tenant := fmt.Sprintf("org:inv-%d", time.Now().UnixNano())
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
	if _, err := st.CreateWebhook(ctx, tenant, "soc", recv.URL, []string{"anomaly.first_seen"}, "test"); err != nil {
		t.Fatal(err)
	}
	delivered := func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		var out []map[string]any
		for _, g := range got {
			if g["type"] == "anomaly.first_seen" {
				out = append(out, g["data"].(map[string]any))
			}
		}
		return out
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
	enroll := func(host, os string) EnrollResponse {
		var tok struct {
			Token struct{ Token string } `json:"token"`
		}
		call("POST", "/api/v1/enrollment-tokens", "", map[string]any{}, &tok)
		var er EnrollResponse
		call("POST", "/ep/v1/enroll", "-", map[string]any{"token": tok.Token.Token, "info": map[string]string{"hostname": host, "os": os}}, &er)
		return er
	}
	post := func(ep EnrollResponse, evs ...map[string]any) {
		t.Helper()
		if code := call("POST", "/ep/v1/events", ep.Secret, map[string]any{"events": evs}, nil); code != 200 {
			t.Fatalf("events: %d", code)
		}
	}
	now := time.Now().UTC().Add(-time.Minute)
	at := func(d time.Duration) time.Time { return now.Add(d) }

	mac, linux := enroll("dana-mbp", "darwin"), enroll("build-1", "linux")
	if code := call("PATCH", "/api/v1/endpoints/"+mac.EndpointID, "", map[string]any{"owner": "dana@acme.io"}, nil); code != 200 {
		t.Fatalf("owner: %d", code)
	}
	installed := map[string]any{"present": true, "state": "installed", "file": "/Library/Application Support/ClaudeCode/managed-settings.json"}
	if code := call("POST", "/ep/v1/heartbeat", mac.Secret, map[string]any{"policy_version": 0, "version": "v0.6.0",
		"hooks": map[string]any{"sensor": "hooks", "agents": map[string]any{"claude": installed}}}, nil); code != 200 {
		t.Fatalf("heartbeat: %d", code)
	}

	// ---- batch 1: learning (the agents are new on these machines) ----
	post(mac,
		map[string]any{"type": "agent_start", "time": at(0), "agent": "claude-code", "kind": "agent", "target": "claude", "mode": "denylist"},
		map[string]any{"type": "exec", "time": at(time.Second), "agent": "claude-code", "kind": "mcp", "target": "mcp__github__create_issue: fix", "os_user": "dana"},
		map[string]any{"type": "exec", "time": at(2 * time.Second), "agent": "claude-code", "kind": "tool", "target": "Bash: git status", "os_user": "dana"},
		map[string]any{"type": "blocked", "time": at(3 * time.Second), "agent": "claude-code", "kind": "tool", "target": "Bash: git push -f origin main",
			"rule": "actions_deny", "message": "blocked by policy (force_push main)", "actions": []map[string]any{{"kind": "force_push", "target": "main"}}},
		map[string]any{"type": "would_block", "time": at(4 * time.Second), "agent": "claude-code", "kind": "mcp", "target": "mcp__linear__search",
			"rule": "actions_deny", "message": "(mcp_unlisted linear)", "actions": []map[string]any{{"kind": "mcp_unlisted", "target": "linear"}}},
		map[string]any{"type": "agent_start", "time": at(5 * time.Second), "agent": "claude-cowork", "kind": "agent", "target": "Claude VM", "mode": "unmanaged"},
	)
	proc := map[string]any{"pid": 42, "binary": "/usr/bin/curl"}
	post(linux,
		map[string]any{"type": "exec", "time": at(0), "agent": "aider", "kind": "process", "target": "/usr/bin/curl", "process": proc},
		map[string]any{"type": "connect", "time": at(time.Second), "agent": "aider", "target": "93.184.216.34:443", "process": proc},
		map[string]any{"type": "blocked", "time": at(2 * time.Second), "agent": "aider", "target": "exec /usr/bin/nc", "rule": "effigent-aider-42-g1-lsm", "process": proc},
		map[string]any{"type": "exec", "time": at(3 * time.Second), "agent": "mcp-filesystem", "kind": "process", "target": "/usr/bin/node", "via": "mcp:filesystem", "process": proc},
	)
	var an struct {
		Anomalies  []store.Anomaly `json:"anomalies"`
		NextBefore string          `json:"next_before"`
		Baselines  []map[string]any
	}
	if code := call("GET", "/api/v1/anomalies", "", nil, &an); code != 200 || len(an.Anomalies) != 0 {
		t.Fatalf("anomalies during warm-up: %d %+v", code, an.Anomalies)
	}

	// ---- inventory ----
	var csvRes map[string]any
	if code := call("POST", "/api/v1/pricing-leaks/import", "", map[string]any{"vendor": "cursor", "kind": "seats",
		"csv": "Name,Email,Role\nDana Katz,dana@acme.io,Member\nOmer,omer@acme.io,Member\n"}, &csvRes); code != 200 {
		t.Fatalf("csv import: %d", code)
	}
	var inv struct {
		Machines   int `json:"machines"`
		Agents     []agentView
		MCPServers []mcpServerView `json:"mcp_servers"`
		Unmanaged  []struct {
			Person, Reason string
		} `json:"unmanaged_people"`
	}
	if code := call("GET", "/api/v1/inventory", "", nil, &inv); code != 200 {
		t.Fatalf("inventory: %d", code)
	}
	status := map[string]string{}
	for _, a := range inv.Agents {
		status[a.Hostname+"/"+a.Agent] = a.Status + " " + strings.Join(a.By, ",")
	}
	want := map[string]string{"dana-mbp/claude-code": "enforced hooks", "dana-mbp/claude-cowork": "unmanaged ", "build-1/aider": "enforced kernel"}
	for k, v := range want {
		if status[k] != v {
			t.Errorf("agent %s: %q, want %q (all %v)", k, status[k], v, status)
		}
	}
	mcp := map[string]mcpServerView{}
	for _, m := range inv.MCPServers {
		mcp[m.Server] = m
	}
	if g := mcp["github"]; strings.Join(g.Tools, ",") != "create_issue" || g.Machines != 1 || g.Allowlist != "no_allowlist" || len(g.People) != 1 || g.People[0] != "dana@acme.io" {
		t.Errorf("github: %+v", g)
	}
	if l := mcp["linear"]; l.Unlisted != 1 {
		t.Errorf("linear: %+v", l)
	}
	if f := mcp["filesystem"]; !f.Orphan || strings.Join(f.Sources, ",") != "kernel" || len(f.Tools) != 0 {
		t.Errorf("filesystem: %+v", f)
	}
	if len(inv.Unmanaged) != 1 || inv.Unmanaged[0].Person != "omer@acme.io" || inv.Unmanaged[0].Reason != "no_machine" {
		t.Errorf("unmanaged people: %+v", inv.Unmanaged)
	}

	// ---- batch 2: past the warm-up, new values signal once ----
	if _, err := db.Exec(ctx, `update cp.agent_inventory set first_at = first_at - interval '10 days' where tenant_ref = $1`, tenant); err != nil {
		t.Fatal(err)
	}
	post(mac,
		map[string]any{"type": "exec", "time": at(10 * time.Second), "agent": "claude-code", "kind": "tool", "target": "Bash: git log"},                         // known
		map[string]any{"type": "exec", "time": at(11 * time.Second), "agent": "claude-code", "kind": "tool", "target": "Bash: curl -s https://paste.example/x"}, // new binary + host
		map[string]any{"type": "exec", "time": at(12 * time.Second), "agent": "claude-code", "kind": "tool", "target": "Bash: curl https://paste.example/y"},    // same values again
	)
	// a value last seen more than 30 days ago is new again
	if _, err := db.Exec(ctx, `update cp.baseline_values set last_at = now() - interval '40 days' where tenant_ref = $1 and value = '/usr/bin/curl'`, tenant); err != nil {
		t.Fatal(err)
	}
	post(linux, map[string]any{"type": "exec", "time": at(13 * time.Second), "agent": "aider", "kind": "process", "target": "/usr/bin/curl", "process": proc})

	if code := call("GET", "/api/v1/anomalies", "", nil, &an); code != 200 {
		t.Fatalf("anomalies: %d", code)
	}
	vals := map[string]bool{}
	for _, a := range an.Anomalies {
		vals[a.Agent+" "+a.Kind+" "+a.Value] = true
	}
	for _, k := range []string{"claude-code binary curl", "claude-code host paste.example", "aider binary /usr/bin/curl"} {
		if !vals[k] {
			t.Errorf("missing anomaly %q in %v", k, vals)
		}
	}
	if len(an.Anomalies) != 3 {
		t.Errorf("%d anomalies, want 3: %v", len(an.Anomalies), vals)
	}
	var hosts struct {
		Anomalies []store.Anomaly `json:"anomalies"`
	}
	call("GET", "/api/v1/anomalies?kind=host&endpoint="+mac.EndpointID, "", nil, &hosts)
	if len(hosts.Anomalies) != 1 || hosts.Anomalies[0].Value != "paste.example" {
		t.Errorf("filtered: %+v", hosts.Anomalies)
	}
	var page struct {
		Anomalies  []store.Anomaly `json:"anomalies"`
		NextBefore string          `json:"next_before"`
	}
	call("GET", "/api/v1/anomalies?limit=2", "", nil, &page)
	if len(page.Anomalies) != 2 || page.NextBefore == "" {
		t.Fatalf("page 1: %+v", page)
	}
	var page2 struct {
		Anomalies []store.Anomaly `json:"anomalies"`
	}
	call("GET", "/api/v1/anomalies?limit=2&before="+page.NextBefore, "", nil, &page2)
	if len(page2.Anomalies) != 1 {
		t.Fatalf("page 2: %+v", page2)
	}
	if code := call("GET", "/api/v1/anomalies?before=nope", "", nil, nil); code != 400 {
		t.Errorf("bad cursor: %d", code)
	}
	for i := 0; i < 60 && len(delivered()) < 3; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if d := delivered(); len(d) != 3 || d[0]["review_url"] == nil || d[0]["hostname"] == nil {
		t.Fatalf("webhooks: %v", d)
	}

	// ---- posture report ----
	var rep postureReport
	if code := call("GET", "/api/v1/report?days=7", "", nil, &rep); code != 200 {
		t.Fatalf("report: %d", code)
	}
	if rep.Machines.Enrolled != 2 || rep.Machines.HooksReporting != 1 || rep.Machines.HooksHealthy != 1 {
		t.Errorf("machines: %+v", rep.Machines)
	}
	if rep.Enforcement.Blocked != 2 || rep.Enforcement.WouldBlock != 1 {
		t.Errorf("enforcement: %+v", rep.Enforcement)
	}
	kinds := map[string]int64{}
	for _, k := range rep.Enforcement.ByKind {
		kinds[k.Kind] = k.Blocked + k.WouldBlock
	}
	if kinds["action:force_push"] != 1 || kinds["kernel_exec"] != 1 || kinds["action:mcp_unlisted"] != 1 {
		t.Errorf("by kind: %+v", rep.Enforcement.ByKind)
	}
	if rep.Anomalies.Total != 3 || rep.Spend == nil {
		t.Errorf("anomalies %+v spend %+v", rep.Anomalies, rep.Spend)
	}
	byPerson := map[string]bool{}
	for _, p := range rep.Agents.ByPerson {
		byPerson[p.Key] = true
	}
	if !byPerson["dana@acme.io"] || rep.Agents.Unmanaged != 1 { // Cowork
		t.Errorf("agents: %+v", rep.Agents)
	}
	if code := call("GET", "/api/v1/report?days=12", "", nil, nil); code != 400 {
		t.Errorf("days=12: %d", code)
	}

	// ---- schedule: validated, audited, claimed once ----
	if code := call("PUT", "/api/v1/report/schedule", "", map[string]any{"enabled": true, "cadence": "daily"}, nil); code != 400 {
		t.Errorf("cadence daily: %d", code)
	}
	if code := call("PUT", "/api/v1/report/schedule", "", map[string]any{"enabled": true, "cadence": "weekly", "emails": []string{"not an email"}}, nil); code != 400 {
		t.Errorf("bad email: %d", code)
	}
	var sched struct {
		Schedule store.ReportSchedule `json:"schedule"`
	}
	if code := call("PUT", "/api/v1/report/schedule", "", map[string]any{"enabled": true, "cadence": "weekly", "emails": []string{"CISO@acme.io", "ciso@acme.io"}}, &sched); code != 200 {
		t.Fatalf("schedule: %d", code)
	}
	if sc := sched.Schedule; !sc.Enabled || len(sc.Emails) != 1 || sc.NextAt == nil || sc.NextAt.UTC().Weekday() != time.Monday || sc.NextAt.UTC().Hour() != 8 || !sc.NextAt.After(time.Now()) {
		t.Fatalf("schedule saved: %+v", sc)
	}
	if es, _ := st.ListAudit(ctx, tenant, 10, "report.schedule.update", ""); len(es) != 1 {
		t.Errorf("schedule audit: %+v", es)
	}
	if _, err := db.Exec(ctx, `update cp.report_schedules set next_at = now() - interval '1 minute' where tenant_ref = $1`, tenant); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var claimed int
	var cmu sync.Mutex
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			due, err := st.ClaimDueReports(ctx, 100)
			if err != nil {
				t.Error(err)
			}
			cmu.Lock()
			defer cmu.Unlock()
			for _, d := range due {
				if d.Tenant == tenant {
					claimed++
				}
			}
		}()
	}
	wg.Wait()
	if claimed != 1 {
		t.Fatalf("claimed %d times, want once", claimed)
	}
	sc, _ := st.GetReportSchedule(ctx, tenant)
	if sc.NextAt == nil || !sc.NextAt.After(time.Now()) || sc.LastSentAt == nil {
		t.Fatalf("after claim: %+v", sc)
	}
	// no email configured on this control plane: the send says so
	if res := s.mailReport(ctx, tenant, 7, sc.Emails); !strings.HasPrefix(res["email"], "off") {
		t.Errorf("mail result %v", res)
	}
	if m := reportMessage(rep, s.ConsoleOrigin); m.Link != "https://app.example/report?days=7" || len(m.Fields) < 8 {
		t.Errorf("message %+v", m)
	}
}
