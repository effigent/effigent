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
	"slices"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// TestPricingLeaksRollupAndAlerts: the rollup job records the report's
// history, Spend over time reads it, and a runaway cost is announced once
// per episode (webhook + audit), not again while it lasts, again after it
// went away and came back, and never while alerts are off.
func TestPricingLeaksRollupAndAlerts(t *testing.T) {
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
	tenant := fmt.Sprintf("org:rollup-%d", time.Now().UnixNano())
	today := spend.Day(time.Now().UTC())

	received := make(chan string, 10)
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		received <- string(raw)
	}))
	defer hook.Close()

	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	_, key, _ := ed25519.GenerateKey(nil)
	s := &Server{Store: st, Key: key, Auth: auth, Logf: t.Logf, AllowInsecureWebhooks: true, WebhookPoll: 50 * time.Millisecond,
		ConsoleOrigin: "https://app.example"}
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

	wh, err := st.CreateWebhook(ctx, tenant, "finance", hook.URL, []string{spendAlertEvent}, "test")
	if err != nil {
		t.Fatal(err)
	}
	// a webhook made without an event list gets the defaults: no runaway cost alerts
	var plain webhookView
	if code, raw := call("POST", "/webhooks", map[string]any{"name": "approvals", "url": hook.URL}, &plain); code != 201 ||
		slices.Contains(plain.Events, spendAlertEvent) {
		t.Fatalf("default webhook: %d %s", code, raw)
	}
	if err := st.PutNotificationSettings(ctx, tenant, store.NotificationSettings{Emails: []string{"ops@acme.io"}}); err != nil {
		t.Fatal(err)
	}
	// Anthropic usage: three people at $5 a day; a's agent starts looping today
	importUsage := func() {
		t.Helper()
		var rows []spend.UsageDay
		for d := 0; d <= 7; d++ {
			for _, who := range []string{"a@acme.io", "b@acme.io", "c@acme.io"} {
				cost := int64(500)
				if d == 0 && who == "a@acme.io" {
					cost = 10_000
				}
				rows = append(rows, spend.UsageDay{Vendor: spend.Anthropic, Day: today.AddDate(0, 0, -d), Identity: who, CostCents: cost, Requests: 10})
			}
		}
		if err := st.ImportSpendCSV(ctx, tenant, spend.Anthropic, spend.CSVResult{Usage: rows}); err != nil {
			t.Fatal(err)
		}
	}
	isDue := func() bool {
		t.Helper()
		due, err := st.DueSpendRollups(ctx, time.Hour, 10_000)
		if err != nil {
			t.Fatal(err)
		}
		return slices.Contains(due, tenant)
	}
	rollup := func() {
		t.Helper()
		if err := s.rollupSpend(ctx, tenant); err != nil {
			t.Fatal(err)
		}
	}
	deliveries := func() int {
		t.Helper()
		ds, err := st.ListDeliveries(ctx, tenant, wh.ID, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range ds {
			if d.EventType != spendAlertEvent {
				t.Errorf("delivery %+v", d)
			}
		}
		return len(ds)
	}
	const leakID = "runaway_cost:anthropic:a@acme.io"
	type alertsPage struct {
		Alerts      []store.SpendLeak `json:"alerts"`
		RunawayCost bool              `json:"runaway_cost"`
	}
	alerts := func() alertsPage {
		t.Helper()
		var a alertsPage
		if code, raw := call("GET", "/pricing-leaks/alerts", nil, &a); code != 200 {
			t.Fatalf("alerts %d %s", code, raw)
		}
		return a
	}

	importUsage()
	if !isDue() {
		t.Fatal("an import must make the tenant's rollup due")
	}
	rollup()
	if isDue() {
		t.Error("rolled up: not due until the data changes or an hour passes")
	}
	if n := deliveries(); n != 1 {
		t.Fatalf("runaway alert: %d webhook deliveries, want 1", n)
	}
	if ds, err := st.ListDeliveries(ctx, tenant, plain.ID, 100); err != nil || len(ds) != 0 {
		t.Fatalf("a webhook not subscribed to %s got it: %+v %v", spendAlertEvent, ds, err)
	}
	select {
	case body := <-received:
		var ev struct {
			Type string `json:"type"`
			Data struct {
				Leak      store.SpendLeak `json:"leak"`
				ReviewURL string          `json:"review_url"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &ev); err != nil || ev.Type != spendAlertEvent || ev.Data.Leak.ID != leakID ||
			ev.Data.ReviewURL != "https://app.example/pricing-leaks?leak=runaway_cost%3Aanthropic%3Aa%40acme.io" {
			t.Errorf("webhook body %s", body)
		}
	case <-time.After(5 * time.Second):
		t.Error("the webhook was never delivered")
	}
	a := alerts()
	if !a.RunawayCost || len(a.Alerts) != 1 || a.Alerts[0].ID != leakID || a.Alerts[0].NotifiedAt == nil || a.Alerts[0].ResolvedAt != nil ||
		a.Alerts[0].NotifyResult["email"] != "off: this control plane doesn't send email" {
		t.Fatalf("alerts %+v", a)
	}

	// still there an hour later: not announced again
	rollup()
	if n := deliveries(); n != 1 {
		t.Errorf("announced twice: %d deliveries", n)
	}

	// history and Spend over time
	var m struct {
		Days     int                    `json:"days"`
		Usage    []spend.UsagePoint     `json:"usage"`
		Activity []spend.ActivityPoint  `json:"activity"`
		Report   []store.SpendReportDay `json:"report"`
		Leaks    []store.SpendLeakDay   `json:"leaks"`
	}
	if code, raw := call("GET", "/pricing-leaks/metrics?days=30", nil, &m); code != 200 {
		t.Fatalf("metrics %d %s", code, raw)
	}
	if m.Days != 30 || len(m.Usage) != 8 || m.Usage[7].CostCents != 11_000 || m.Usage[7].People != 3 || m.Usage[0].CostCents != 1500 {
		t.Errorf("usage %+v", m.Usage)
	}
	if len(m.Report) != 1 || m.Report[0].Vendor != spend.Anthropic || !m.Report[0].Day.Equal(today) || m.Report[0].UsageCents != 3*7*500+11_000 {
		t.Errorf("report history %+v", m.Report)
	}
	if len(m.Leaks) != 1 || m.Leaks[0].Type != spend.RunawayCost || m.Leaks[0].Leaks != 1 || m.Leaks[0].SavingsCents <= 0 {
		t.Errorf("leak history %+v", m.Leaks)
	}
	if code, _ := call("GET", "/pricing-leaks/metrics?days=3", nil, nil); code != 400 {
		t.Errorf("days=3: %d", code)
	}
	var page struct {
		FirstSeen map[string]time.Time `json:"first_seen"`
	}
	if code, _ := call("GET", "/pricing-leaks", nil, &page); code != 200 || page.FirstSeen[leakID].IsZero() {
		t.Errorf("first_seen %+v", page.FirstSeen)
	}

	// it goes away (resolved), comes back: a new episode, announced again
	if err := st.ClearSpendCSV(ctx, tenant, spend.Anthropic); err != nil {
		t.Fatal(err)
	}
	rollup()
	if a := alerts(); len(a.Alerts) != 1 || a.Alerts[0].ResolvedAt == nil {
		t.Fatalf("want the leak resolved: %+v", a.Alerts)
	}
	importUsage()
	rollup()
	if n := deliveries(); n != 2 {
		t.Errorf("came back: %d deliveries, want 2", n)
	}

	// alert settings: validation, prices kept when only alerts change, off = marked but not sent
	if code, _ := call("PUT", "/pricing-leaks/settings", map[string]any{"alerts": map[string]any{"emails": []string{"not an email"}}}, nil); code != 400 {
		t.Errorf("bad email: %d", code)
	}
	if code, _ := call("PUT", "/pricing-leaks/settings", map[string]any{"prices": map[string]any{"seat": map[string]int64{"cursor": 3000}}}, nil); code != 200 {
		t.Fatal("prices")
	}
	var set store.SpendSettings
	if code, raw := call("PUT", "/pricing-leaks/settings", map[string]any{"alerts": map[string]any{"runaway_cost": false, "emails": []string{"finance@acme.io"}}}, &set); code != 200 ||
		set.Prices.Seat["cursor"] != 3000 || set.Alerts.RunawayOn() || len(set.Alerts.Emails) != 1 {
		t.Fatalf("alerts off: %d %s", code, raw)
	}
	if err := st.ClearSpendCSV(ctx, tenant, spend.Anthropic); err != nil {
		t.Fatal(err)
	}
	rollup()
	importUsage()
	rollup()
	if n := deliveries(); n != 2 {
		t.Errorf("alerts off: %d deliveries, want 2", n)
	}
	if a := alerts(); a.RunawayCost || a.Alerts[0].NotifyResult["alerts"] != "off" || a.Alerts[0].NotifiedAt == nil {
		t.Errorf("alerts off: %+v", a)
	}

	entries, err := st.ListAudit(ctx, tenant, 100, "pricing_leaks.alert", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 || entries[0].ActorVia != "system" || entries[0].Target != leakID {
		t.Errorf("audit %+v", entries)
	}
}
