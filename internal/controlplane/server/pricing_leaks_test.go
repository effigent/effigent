package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// -effigent.db is EFFIGENT_TEST_DATABASE_URL for runners that can't set
// environment variables: go test ./internal/controlplane/server/ -run PricingLeaks -args -effigent.db=postgres://…
var testDBFlag = flag.String("effigent.db", "", "test database URL (default $EFFIGENT_TEST_DATABASE_URL)")

func TestCleanSpendSettings(t *testing.T) {
	bad := []store.SpendSettings{
		{Prices: spend.Prices{Seat: map[string]int64{"windsurf": 1500}}},
		{Prices: spend.Prices{Seat: map[string]int64{"cursor": -1}}},
		{Prices: spend.Prices{Personal: map[string]int64{"cursor": 2_000_000}}},
	}
	for i, c := range bad {
		if _, err := cleanSpendSettings(c); err == nil {
			t.Errorf("bad settings %d accepted", i)
		}
	}
	c, err := cleanSpendSettings(store.SpendSettings{
		Prices: spend.Prices{Seat: map[string]int64{"Copilot/Enterprise": 3900, "anthropic": 15000}, Personal: map[string]int64{"google": 2000}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.Prices.Seat["copilot/enterprise"] != 3900 || c.Prices.Personal["google"] != 2000 {
		t.Fatalf("prices %+v", c.Prices)
	}
}

// TestPricingLeaksEndToEnd needs a throwaway Postgres database (see TestCentralPolicyEndToEnd).
func TestPricingLeaksEndToEnd(t *testing.T) {
	dbURL := os.Getenv("EFFIGENT_TEST_DATABASE_URL")
	if dbURL == "" {
		dbURL = *testDBFlag
	}
	if dbURL == "" {
		t.Skip("EFFIGENT_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	st, err := store.Open(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	tenant := fmt.Sprintf("org:spend-%d", time.Now().UnixNano())
	now := time.Now().UTC()

	// fake vendors
	const cursorKey, ghToken = "cursor_admin_key_7f3a", "ghp_copilot_token_99zz"
	cursor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, _, _ := r.BasicAuth(); u != cursorKey {
			http.Error(w, `{"error":"bad key"}`, 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/teams/members":
			fmt.Fprint(w, `{"teamMembers":[{"email":"dana@acme.io","name":"Dana","role":"member"},{"email":"omer@acme.io","name":"Omer","role":"member"},{"email":"idle@acme.io","name":"Idle","role":"member"}]}`)
		case "/teams/daily-usage-data":
			fmt.Fprintf(w, `{"data":[{"email":"omer@acme.io","date":%d,"isActive":true,"agentRequests":12}],"pagination":{"hasNextPage":false}}`, now.Add(-time.Hour).UnixMilli())
		case "/teams/filtered-usage-events":
			fmt.Fprint(w, `{"usageEvents":[],"pagination":{"hasNextPage":false}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer cursor.Close()
	copilot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+ghToken {
			http.Error(w, `{"message":"Bad credentials"}`, 401)
			return
		}
		switch r.URL.Path {
		case "/orgs/acme/copilot/billing":
			fmt.Fprint(w, `{"plan_type":"business","seat_breakdown":{"total":1}}`)
		case "/orgs/acme/copilot/billing/seats":
			fmt.Fprintf(w, `{"total_seats":1,"seats":[{"created_at":"2025-01-01T00:00:00Z","last_activity_at":%q,"plan_type":"business","assignee":{"login":"Dana-K"}}]}`,
				now.AddDate(0, 0, -50).Format(time.RFC3339))
		default:
			http.NotFound(w, r)
		}
	}))
	defer copilot.Close()

	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	sk, _ := SecretsKeyFrom(strings.Repeat("k", 40))
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, SecretsKey: sk,
		SpendBaseURLs: map[string]string{spend.Cursor: cursor.URL, spend.Copilot: copilot.URL}, SpendSyncEvery: 1000 * time.Hour}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	call := func(method, path string, body any, out any) (int, string) {
		t.Helper()
		var rd io.Reader = http.NoBody
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, srv.URL+"/api/v1"+path, rd)
		req.Header.Set("Authorization", "Bearer t0ken")
		req.Header.Set("X-Effigent-Tenant", tenant)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		if out != nil && res.StatusCode < 300 {
			if err := json.Unmarshal(raw, out); err != nil {
				t.Fatal(err)
			}
		}
		return res.StatusCode, string(raw)
	}
	type page struct {
		Report     spend.Report    `json:"report"`
		Connectors []connectorView `json:"connectors"`
		Settings   store.SpendSettings
	}
	get := func() (page, string) {
		var p page
		code, raw := call("GET", "/pricing-leaks", nil, &p)
		if code != 200 {
			t.Fatalf("GET %d %s", code, raw)
		}
		return p, raw
	}
	conn := func(p page, v string) connectorView {
		for _, c := range p.Connectors {
			if c.Vendor == v {
				return c
			}
		}
		t.Fatalf("no connector %s", v)
		return connectorView{}
	}
	waitSynced := func(v string) connectorView {
		t.Helper()
		for i := 0; i < 100; i++ {
			p, _ := get()
			if c := conn(p, v); c.SyncStatus != "running" && c.SyncStatus != "" {
				return c
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("%s sync never finished", v)
		return connectorView{}
	}

	p, _ := get()
	if len(p.Connectors) != 4 || conn(p, spend.Cursor).Configured || len(p.Report.Leaks) != 0 {
		t.Fatalf("empty workspace: %+v", p)
	}

	// effigentd: Dana's laptop runs Claude Code daily and Cursor never; Omer's runs Cursor; build-7 runs codex
	enroll := func(host, owner string) string {
		tok, err := st.CreateEnrollmentToken(ctx, tenant, "", "test", time.Hour, 1)
		if err != nil {
			t.Fatal(err)
		}
		id, _, _, err := st.Enroll(ctx, tok.Token, store.EndpointInfo{Hostname: host})
		if err != nil {
			t.Fatal(err)
		}
		if err := st.Heartbeat(ctx, id, 0, ""); err != nil {
			t.Fatal(err)
		}
		if owner != "" {
			if _, err := st.SetEndpointOwner(ctx, tenant, id, owner, nil); err != nil {
				t.Fatal(err)
			}
		}
		return id
	}
	events := func(ep, agent string, days int, who map[string]any) {
		var evs []store.Event
		for d := 0; d < days; d++ {
			b := map[string]any{"type": "exec", "agent": agent}
			for k, v := range who {
				b[k] = v
			}
			body, _ := json.Marshal(b)
			evs = append(evs, store.Event{Time: now.AddDate(0, 0, -d), Type: "exec", Severity: "info", Agent: agent, Body: body},
				store.Event{Time: now.AddDate(0, 0, -d), Type: "file_open", Severity: "info", Agent: agent, Body: body})
		}
		if _, _, err := st.IngestBatch(ctx, tenant, ep, fmt.Sprintf("b-%s-%s", agent, ep), evs); err != nil {
			t.Fatal(err)
		}
		// a replayed batch is stored once, and so counted once
		if _, dup, err := st.IngestBatch(ctx, tenant, ep, fmt.Sprintf("b-%s-%s", agent, ep), evs); err != nil || !dup {
			t.Fatalf("replay: dup=%v err=%v", dup, err)
		}
	}
	dana := enroll("dana-mbp", "")
	omer := enroll("omer-mbp", "omer@acme.io")
	build := enroll("build-7", "")
	events(dana, "claude-code", 12, map[string]any{"os_user": "dana", "git_email": "Dana@Acme.io", "model": "claude-opus-5-5"})
	events(omer, "cursor-agent", 6, nil)
	events(build, "codex", 2, map[string]any{"os_user": "ci"})
	sightings, err := st.Sightings(ctx, tenant, now.AddDate(0, 0, -29))
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range sightings {
		if x.Hostname == "dana-mbp" && (x.OSUser != "dana" || x.GitEmail != "dana@acme.io" || x.Events != 24) {
			t.Errorf("rollup: %+v", x)
		}
	}
	if len(sightings) != 3 {
		t.Errorf("sightings %+v", sightings)
	}

	// connectors: validation, key never returned
	if code, raw := call("PUT", "/pricing-leaks/connectors/cursor", map[string]any{}, nil); code != 400 {
		t.Fatalf("no key: %d %s", code, raw)
	}
	if code, _ := call("PUT", "/pricing-leaks/connectors/windsurf", map[string]any{"key": "x"}, nil); code != 404 {
		t.Fatalf("unknown vendor: %d", code)
	}
	var put map[string]any
	if code, raw := call("PUT", "/pricing-leaks/connectors/cursor", map[string]any{"key": cursorKey}, &put); code != 200 || strings.Contains(raw, cursorKey) || put["key_hint"] != "7f3a" {
		t.Fatalf("put cursor: %d %s", code, raw)
	}
	if c := waitSynced(spend.Cursor); c.SyncStatus != "ok" || c.LastCounts["seats"] != 3 || !c.Configured || c.KeyHint != "7f3a" {
		t.Fatalf("cursor sync: %+v", c)
	}
	if stored, _ := st.GetSpendConnector(ctx, tenant, spend.Cursor); !strings.HasPrefix(stored.SecretEnc, "v1:") || strings.Contains(stored.SecretEnc, cursorKey) {
		t.Fatalf("key not sealed: %q", stored.SecretEnc)
	}
	if code, _ := call("PUT", "/pricing-leaks/connectors/copilot", map[string]any{"key": ghToken}, nil); code != 400 {
		t.Fatalf("copilot without an org: %d", code)
	}
	if code, raw := call("PUT", "/pricing-leaks/connectors/copilot", map[string]any{"key": "ghp_wrong_token_0000", "org": "acme"}, nil); code != 200 {
		t.Fatalf("put copilot: %d %s", code, raw)
	}
	if c := waitSynced(spend.Copilot); c.SyncStatus != "error" || !strings.Contains(c.LastError, "401") {
		t.Fatalf("a bad token must fail the sync: %+v", c)
	}
	if code, _ := call("PUT", "/pricing-leaks/connectors/copilot", map[string]any{"key": ghToken}, nil); code != 200 { // org kept
		t.Fatalf("copilot new key, same org: %d", code)
	}
	if c := waitSynced(spend.Copilot); c.SyncStatus != "ok" || c.Settings["org"] != "acme" {
		t.Fatalf("copilot sync: %+v", c)
	}

	// CSV: OpenAI usage for Omer only (so build-7's codex is off the company plan)
	csv := "Date,Email,Cost\n" + now.Format("2006-01-02") + ",omer@acme.io,$3.10\n"
	var imp map[string]any
	if code, raw := call("POST", "/pricing-leaks/import", map[string]any{"vendor": "openai", "kind": "usage", "csv": csv}, &imp); code != 200 || imp["usage_rows"].(float64) != 1 {
		t.Fatalf("import: %d %s", code, raw)
	}
	if code, _ := call("POST", "/pricing-leaks/import", map[string]any{"vendor": "openai", "kind": "usage", "csv": "Name\nx\n"}, nil); code != 400 {
		t.Fatalf("bad csv: %d", code)
	}

	// the poller schedules the next poll after a good one, and backs off after a failure
	if c, _ := st.GetSpendConnector(ctx, tenant, spend.Copilot); c.NextPollAt == nil || c.NextPollAt.Before(now.Add(999*time.Hour)) || c.Failures != 0 {
		t.Errorf("copilot next poll %v failures %d", c.NextPollAt, c.Failures)
	}
	if code, _ := call("PUT", "/pricing-leaks/settings", map[string]any{"prices": map[string]any{"seat": map[string]int64{"cursor": 3500}}}, nil); code != 200 {
		t.Fatal("settings")
	}

	// People: suggestions from what effigentd and the vendors saw
	type peoplePage struct {
		People      []store.PersonRow  `json:"people"`
		Suggestions []spend.Suggestion `json:"suggestions"`
		Sightings   []spend.Sighting   `json:"sightings"`
		Unattrib    []string           `json:"unattributed"`
	}
	getPeople := func() peoplePage {
		t.Helper()
		var pp peoplePage
		if code, raw := call("GET", "/people", nil, &pp); code != 200 {
			t.Fatalf("GET /people %d %s", code, raw)
		}
		return pp
	}
	sug := func(pp peoplePage, kind, value string) *spend.Suggestion {
		for i, x := range pp.Suggestions {
			if x.Kind == kind && x.Value == value {
				return &pp.Suggestions[i]
			}
		}
		return nil
	}
	pp := getPeople()
	if x := sug(pp, "os_user", "dana"); x == nil || x.Email != "dana@acme.io" {
		t.Errorf("want os_user:dana -> dana@acme.io suggested: %+v", pp.Suggestions)
	}
	if x := sug(pp, "person", "idle@acme.io"); x == nil || x.Name != "Idle" {
		t.Errorf("want the Cursor seat idle@acme.io suggested as a person: %+v", pp.Suggestions)
	}
	if len(pp.Unattrib) != 1 || pp.Unattrib[0] != "build-7" {
		t.Errorf("people unattributed %v", pp.Unattrib)
	}
	// Dana: her GitHub login by hand, her OS user from the suggestion
	if code, raw := call("PUT", "/people/Dana@acme.io", map[string]any{"name": "Dana Katz", "identities": []map[string]string{{"kind": "github", "value": "Dana-K"}}}, nil); code != 200 {
		t.Fatalf("put person: %d %s", code, raw)
	}
	if code, raw := call("POST", "/people/identities", map[string]any{"kind": "os_user", "value": "dana", "email": "dana@acme.io", "source": "suggestion"}, nil); code != 200 {
		t.Fatalf("accept: %d %s", code, raw)
	}
	if code, _ := call("PUT", "/people/omer@acme.io", map[string]any{"identities": []map[string]string{{"kind": "os_user", "value": "dana"}}}, nil); code != 409 {
		t.Errorf("an identity of someone else: %d, want 409", code)
	}
	if code, _ := call("PUT", "/people/omer@acme.io", map[string]any{"identities": []map[string]string{{"kind": "shoe_size", "value": "44"}}}, nil); code != 400 {
		t.Errorf("unknown kind: %d", code)
	}
	if code, _ := call("POST", "/people/identities", map[string]any{"kind": "person", "email": "temp@acme.io", "name": "Temp"}, nil); code != 200 {
		t.Error("add person")
	}
	if code, _ := call("DELETE", "/people/temp@acme.io", nil, nil); code != 200 {
		t.Error("delete person")
	}
	if code, _ := call("DELETE", "/people/identities?kind=github&value=nobody", nil, nil); code != 404 {
		t.Error("delete unknown identity")
	}
	pp = getPeople()
	if sug(pp, "os_user", "dana") != nil {
		t.Errorf("accepted suggestion still listed")
	}
	if len(pp.People) != 1 || pp.People[0].Name != "Dana Katz" || len(pp.People[0].Identities) != 2 || pp.People[0].Identities[0].Kind != "os_user" {
		t.Errorf("people %+v", pp.People)
	}
	for _, x := range pp.Sightings {
		if x.Hostname == "dana-mbp" && (x.Person != "dana@acme.io" || x.Via != spend.ViaOSUser) {
			t.Errorf("dana's sighting %+v", x)
		}
	}

	p, raw := get()
	if strings.Contains(raw, cursorKey) || strings.Contains(raw, ghToken) {
		t.Fatal("a key leaked into GET /pricing-leaks")
	}
	for _, l := range p.Report.Leaks {
		t.Logf("%s %s %s save %d risk %d: %s", l.Type, l.Vendor, l.Person, l.MonthlySavingsCents, l.AtRiskCents, strings.Join(l.Evidence, " | "))
	}
	has := func(typ, vendor, person string, save int64) {
		t.Helper()
		for _, l := range p.Report.Leaks {
			if l.Type == typ && l.Vendor == vendor && l.Person == person {
				if l.MonthlySavingsCents != save {
					t.Errorf("%s %s %s saves %d, want %d", typ, vendor, person, l.MonthlySavingsCents, save)
				}
				return
			}
		}
		t.Errorf("missing %s %s %s", typ, vendor, person)
	}
	has(spend.UnusedSeat, spend.Cursor, "dana@acme.io", 3500)  // effigentd: Claude Code daily, never Cursor (tenant price)
	has(spend.UnusedSeat, spend.Cursor, "idle@acme.io", 3500)  // Cursor: no activity
	has(spend.UnusedSeat, spend.Copilot, "dana@acme.io", 1900) // last activity 50 days ago
	has(spend.ShadowSpend, spend.OpenAI, "host:build-7", 0)    // codex, not on the OpenAI account
	if conn(p, spend.OpenAI).CSVDays != 1 {
		t.Errorf("csv counts: %+v", conn(p, spend.OpenAI))
	}
	var cs page
	if code, raw := call("GET", "/pricing-leaks/connectors", nil, &cs); code != 200 || conn(cs, spend.Cursor).KeyHint != "7f3a" || conn(cs, spend.OpenAI).CSVDays != 1 || strings.Contains(raw, cursorKey) {
		t.Errorf("connectors: %d %s", code, raw)
	}
	if len(p.Report.Unattributed) != 1 || p.Report.Unattributed[0] != "build-7" {
		t.Errorf("unattributed %v", p.Report.Unattributed)
	}
	for _, l := range p.Report.Leaks {
		if l.Person == "dana@acme.io" && l.Attribution != spend.ViaOSUser {
			t.Errorf("dana's leak attributed by %q, want os_user: %+v", l.Attribution, l)
		}
	}

	// sync now: only configured vendors; a vendor whose poll lock is held
	// (another instance polling it) isn't polled twice
	release, ok, err := st.SpendPollLock(ctx, tenant, spend.Cursor)
	if err != nil || !ok {
		t.Fatalf("lock: %v %v", ok, err)
	}
	var sync struct {
		Started        []string `json:"started"`
		AlreadyRunning []string `json:"already_running"`
	}
	if code, raw := call("POST", "/pricing-leaks/sync", map[string]any{}, &sync); code != 202 || len(sync.Started) != 1 || len(sync.AlreadyRunning) != 1 || sync.AlreadyRunning[0] != spend.Cursor {
		t.Fatalf("sync: %d %s", code, raw)
	}
	release()
	waitSynced(spend.Copilot)
	// the scheduled poll: not due (next poll in 1000h) -> nothing happens; due -> it runs
	s.pollSpend(ctx, tenant, spend.Cursor)
	if c, _ := st.GetSpendConnector(ctx, tenant, spend.Cursor); c.SyncStartedAt != nil && c.SyncStartedAt.After(now.Add(time.Minute)) {
		t.Errorf("a poll that wasn't due ran")
	}
	due, err := st.DueSpendPolls(ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range due {
		if c.Tenant == tenant {
			t.Errorf("not due yet: %+v", c)
		}
	}
	if store.SpendRetryAfter(1, 24*time.Hour) != 15*time.Minute || store.SpendRetryAfter(3, 24*time.Hour) != time.Hour || store.SpendRetryAfter(20, 24*time.Hour) != 24*time.Hour {
		t.Error("retry backoff")
	}

	// disconnecting drops the synced data, CSV imports stay until cleared
	if code, _ := call("DELETE", "/pricing-leaks/connectors/cursor", nil, nil); code != 200 {
		t.Fatal("delete cursor")
	}
	if code, _ := call("DELETE", "/pricing-leaks/import/openai", nil, nil); code != 200 {
		t.Fatal("clear csv")
	}
	p, _ = get()
	for _, l := range p.Report.Leaks {
		if l.Vendor == spend.Cursor || l.Vendor == spend.OpenAI {
			t.Errorf("leak after disconnecting: %+v", l)
		}
	}
	entries, err := st.ListAudit(ctx, tenant, 100, "pricing_leaks.", "")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		seen[e.Action] = true
		if strings.Contains(string(mustJSON(e.Details)), cursorKey) {
			t.Fatal("a key leaked into the audit trail")
		}
	}
	people, err := st.ListAudit(ctx, tenant, 100, "people.", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range append(entries, people...) {
		seen[e.Action] = true
	}
	for _, a := range []string{"pricing_leaks.connector.update", "pricing_leaks.connector.delete", "pricing_leaks.import", "pricing_leaks.settings.update", "pricing_leaks.sync",
		"people.create", "people.identity.add", "people.delete"} {
		if !seen[a] {
			t.Errorf("no audit entry %s", a)
		}
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
