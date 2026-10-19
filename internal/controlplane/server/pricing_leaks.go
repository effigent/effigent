package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// Pricing Leaks: what the workspace pays AI coding tool vendors, joined with
// what effigentd sees, to flag unused seats, duplicate tools, shadow spend
// and runaway cost (internal/controlplane/spend). Vendor admin keys are
// sealed like Slack credentials (secrets.go) and never returned: the console
// sees "configured" and the key's last 4 characters. Syncs run on demand
// and nightly (runSpendSyncs); CSV exports are the fallback without a key.

const (
	spendWindowDays   = 30
	spendSyncTimeout  = 10 * time.Minute
	spendSyncDefault  = 24 * time.Hour
	spendMaxCSVBytes  = 20 << 20
	spendMaxPeople    = 5000
	spendMaxAliases   = 50
	spendMaxPriceCent = 1_000_000 // $10,000 a seat per month
)

func spendField(vendor string) string { return "spend_" + vendor + "_key" }

// connectorView is a connector as the console sees it (never the key).
type connectorView struct {
	Vendor     string            `json:"vendor"`
	Label      string            `json:"label"`
	Configured bool              `json:"configured"`
	KeyHint    string            `json:"key_hint,omitempty"`
	Settings   map[string]string `json:"settings"`
	SyncStatus string            `json:"sync_status"`
	LastSyncAt *time.Time        `json:"last_sync_at,omitempty"`
	LastError  string            `json:"last_error,omitempty"`
	LastCounts map[string]int    `json:"last_counts,omitempty"`
	UpdatedBy  string            `json:"updated_by,omitempty"`
	CSVSeats   int               `json:"csv_seats"`
	CSVDays    int               `json:"csv_usage_rows"`
}

func (s *Server) pricingLeaks(w http.ResponseWriter, r *http.Request, p Principal) {
	ctx := r.Context()
	now := time.Now().UTC()
	since := spend.Day(now).AddDate(0, 0, -(spendWindowDays - 1))
	conns, err := s.Store.ListSpendConnectors(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	set, err := s.Store.GetSpendSettings(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	seats, usage, err := s.Store.SpendData(ctx, p.Tenant, since)
	if err != nil {
		s.fail(w, err)
		return
	}
	machines, obs, err := s.Store.SpendObservations(ctx, p.Tenant, since)
	if err != nil {
		s.fail(w, err)
		return
	}
	views := map[string]*connectorView{}
	for _, v := range spend.Vendors {
		views[v] = &connectorView{Vendor: v, Label: spend.VendorLabel[v], Settings: map[string]string{}}
	}
	connected := map[string]bool{}
	for _, c := range conns {
		cv := views[c.Vendor]
		if cv == nil {
			continue
		}
		cv.Configured, cv.KeyHint, cv.Settings, cv.SyncStatus = c.Configured(), c.SecretHint, c.Settings, c.SyncStatus
		cv.LastSyncAt, cv.LastError, cv.LastCounts, cv.UpdatedBy = c.LastSyncAt, c.LastError, c.LastCounts, c.UpdatedBy
		if c.Configured() && c.LastSyncAt != nil {
			connected[c.Vendor] = true
		}
	}
	for _, x := range seats {
		if x.Source == "csv" && views[x.Vendor] != nil {
			views[x.Vendor].CSVSeats++
			connected[x.Vendor] = true
		}
	}
	for _, u := range usage {
		if u.Source == "csv" && views[u.Vendor] != nil {
			views[u.Vendor].CSVDays++
			connected[u.Vendor] = true
		}
	}
	list := make([]connectorView, 0, len(spend.Vendors))
	for _, v := range spend.Vendors {
		list = append(list, *views[v])
	}
	rep := spend.Analyze(spend.Input{Now: now, WindowDays: spendWindowDays, Seats: seats, Usage: usage, Machines: machines, Obs: obs,
		People: set.People, Prices: spend.DefaultPrices.Merge(set.Prices), Connected: keys(connected)})
	writeJSON(w, http.StatusOK, map[string]any{
		"report": rep, "connectors": list, "settings": set, "default_prices": spend.DefaultPrices,
		"secrets_available": len(s.SecretsKey) == 32,
	})
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func spendVendor(w http.ResponseWriter, r *http.Request) (string, bool) {
	v := r.PathValue("vendor")
	if !spend.IsVendor(v) {
		writeErr(w, http.StatusNotFound, "unknown vendor (cursor, anthropic, copilot, openai)")
		return "", false
	}
	return v, true
}

// putSpendConnector saves a vendor's admin key (omit it to keep the stored
// one) and settings, then starts a sync.
func (s *Server) putSpendConnector(w http.ResponseWriter, r *http.Request, p Principal) {
	vendor, ok := spendVendor(w, r)
	if !ok {
		return
	}
	var req struct {
		Key string `json:"key"`
		Org string `json:"org"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "body must be {\"key\": \"…\", \"org\": \"…\"}")
		return
	}
	if len(s.SecretsKey) != 32 {
		writeErr(w, http.StatusServiceUnavailable, errNoSecretsKeySpend.Error())
		return
	}
	key := strings.TrimSpace(req.Key)
	prev, err := s.Store.GetSpendConnector(r.Context(), p.Tenant, vendor)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, err)
		return
	}
	switch {
	case key == "" && !prev.Configured():
		writeErr(w, http.StatusBadRequest, "paste the admin API key")
		return
	case len(key) > 500 || strings.ContainsAny(key, " \t\r\n"):
		writeErr(w, http.StatusBadRequest, "that doesn't look like an API key")
		return
	case key != "" && len(key) < 12:
		writeErr(w, http.StatusBadRequest, "that key is too short")
		return
	}
	settings := map[string]string{}
	if vendor == spend.Copilot {
		org := strings.TrimSpace(req.Org)
		if org == "" {
			org = prev.Settings["org"]
		}
		if !spend.ValidGitHubOrg(org) {
			writeErr(w, http.StatusBadRequest, "set the GitHub organisation (its login, e.g. acme)")
			return
		}
		settings["org"] = org
	}
	sealed, hint := "", ""
	if key != "" {
		if sealed, err = s.seal(p.Tenant, spendField(vendor), key); err != nil {
			s.fail(w, err)
			return
		}
		hint = key[len(key)-4:]
	}
	c, err := s.Store.PutSpendConnector(r.Context(), p.Tenant, vendor, sealed, hint, settings, p.UserID)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "pricing_leaks.connector.update", vendor, map[string]any{"key_changed": key != "", "key_hint": c.SecretHint, "settings": settings})
	started := s.startSpendSync(p.Tenant, vendor)
	writeJSON(w, http.StatusOK, map[string]any{"vendor": vendor, "configured": c.Configured(), "key_hint": c.SecretHint, "sync_started": started})
}

func (s *Server) deleteSpendConnector(w http.ResponseWriter, r *http.Request, p Principal) {
	vendor, ok := spendVendor(w, r)
	if !ok {
		return
	}
	err := s.Store.DeleteSpendConnector(r.Context(), p.Tenant, vendor)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "that vendor isn't connected")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "pricing_leaks.connector.delete", vendor, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// syncSpendNow starts a sync of one vendor or of every configured one. It
// answers at once (202); the console polls GET /pricing-leaks.
func (s *Server) syncSpendNow(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Vendor string `json:"vendor"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req)
	if req.Vendor != "" && !spend.IsVendor(req.Vendor) {
		writeErr(w, http.StatusBadRequest, "unknown vendor")
		return
	}
	conns, err := s.Store.ListSpendConnectors(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	started, running := []string{}, []string{}
	for _, c := range conns {
		if !c.Configured() || (req.Vendor != "" && c.Vendor != req.Vendor) {
			continue
		}
		if s.startSpendSync(p.Tenant, c.Vendor) {
			started = append(started, c.Vendor)
		} else {
			running = append(running, c.Vendor)
		}
	}
	if len(started) == 0 && len(running) == 0 {
		writeErr(w, http.StatusBadRequest, "no vendor is connected; add an admin API key first")
		return
	}
	s.audit(r, p, "pricing_leaks.sync", strings.Join(started, ","), map[string]any{"started": started, "already_running": running})
	writeJSON(w, http.StatusAccepted, map[string]any{"started": started, "already_running": running})
}

// startSpendSync claims a vendor's sync and runs it in the background.
func (s *Server) startSpendSync(tenant, vendor string) bool {
	c, ok, err := s.Store.ClaimSpendSync(context.Background(), tenant, vendor)
	if err != nil {
		s.Logf("pricing leaks: claim %s/%s: %v", tenant, vendor, err)
		return false
	}
	if !ok {
		return false
	}
	go s.syncSpend(context.Background(), c)
	return true
}

// syncSpend pulls one vendor's last 30 days and stores them. The connector
// must already be claimed (sync_status = running).
func (s *Server) syncSpend(ctx context.Context, c store.SpendConnector) {
	ctx, cancel := context.WithTimeout(ctx, spendSyncTimeout)
	defer cancel()
	fail := func(err error) {
		msg := clip(err.Error(), 500)
		s.Logf("pricing leaks: sync %s/%s failed: %s", c.Tenant, c.Vendor, msg)
		if err := s.Store.FailSpendSync(context.Background(), c.Tenant, c.Vendor, msg); err != nil {
			s.Logf("pricing leaks: record failure: %v", err)
		}
	}
	key, err := s.open(c.Tenant, spendField(c.Vendor), c.SecretEnc)
	if err != nil {
		fail(fmt.Errorf("%v — paste the key again", err))
		return
	}
	cl, err := spend.NewClient(spend.Config{Vendor: c.Vendor, Key: key, Org: c.Settings["org"], BaseURL: s.SpendBaseURLs[c.Vendor]})
	if err != nil {
		fail(err)
		return
	}
	to := time.Now().UTC()
	from := spend.Day(to).AddDate(0, 0, -(spendWindowDays - 1))
	pull, err := cl.Pull(ctx, from, to)
	if err != nil {
		fail(err)
		return
	}
	if err := s.Store.FinishSpendSync(context.Background(), c.Tenant, c.Vendor, from, to, pull); err != nil {
		fail(fmt.Errorf("storing the results: %v", err))
		return
	}
	s.Logf("pricing leaks: synced %s/%s: %d seats, %d usage rows", c.Tenant, c.Vendor, len(pull.Seats), len(pull.Usage))
}

// runSpendSyncs is the nightly sync: every hour it syncs connectors whose
// last attempt is older than SpendSyncEvery (default 24h), one at a time.
func (s *Server) runSpendSyncs(ctx context.Context) {
	every := s.SpendSyncEvery
	if every <= 0 {
		every = spendSyncDefault
	}
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		due, err := s.Store.DueSpendSyncs(ctx, every)
		if err != nil {
			s.Logf("pricing leaks: due syncs: %v", err)
		}
		for _, c := range due {
			if c, ok, err := s.Store.ClaimSpendSync(ctx, c.Tenant, c.Vendor); err == nil && ok {
				s.syncSpend(ctx, c)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// importSpendCSV stores a vendor's CSV export ({"vendor", "kind": "seats" |
// "usage", "csv": "<file contents>"}).
func (s *Server) importSpendCSV(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Vendor string `json:"vendor"`
		Kind   string `json:"kind"`
		CSV    string `json:"csv"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, spendMaxCSVBytes)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "body must be {\"vendor\", \"kind\": \"seats\"|\"usage\", \"csv\": \"…\"} (at most 20 MB)")
		return
	}
	if !spend.IsVendor(req.Vendor) {
		writeErr(w, http.StatusBadRequest, "unknown vendor (cursor, anthropic, copilot, openai)")
		return
	}
	res, err := spend.ParseCSV(req.Vendor, req.Kind, strings.NewReader(req.CSV))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.Store.ImportSpendCSV(r.Context(), p.Tenant, req.Vendor, res); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "pricing_leaks.import", req.Vendor, map[string]any{"kind": req.Kind, "rows": res.Rows, "seats": len(res.Seats), "usage_rows": len(res.Usage), "skipped": res.Skipped})
	writeJSON(w, http.StatusOK, map[string]any{"vendor": req.Vendor, "kind": req.Kind, "rows": res.Rows, "seats": len(res.Seats),
		"usage_rows": len(res.Usage), "skipped": res.Skipped, "warnings": res.Warnings})
}

func (s *Server) clearSpendCSV(w http.ResponseWriter, r *http.Request, p Principal) {
	vendor, ok := spendVendor(w, r)
	if !ok {
		return
	}
	if err := s.Store.ClearSpendCSV(r.Context(), p.Tenant, vendor); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "pricing_leaks.import.delete", vendor, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// cleanSpendSettings validates the people directory and price overrides.
func cleanSpendSettings(in store.SpendSettings) (store.SpendSettings, error) {
	out := store.SpendSettings{People: []spend.Person{}, Prices: spend.Prices{Seat: map[string]int64{}, Personal: map[string]int64{}}}
	if len(in.People) > spendMaxPeople {
		return out, fmt.Errorf("at most %d people", spendMaxPeople)
	}
	seen := map[string]bool{}
	for _, p := range in.People {
		email := strings.ToLower(strings.TrimSpace(p.Email))
		if email == "" {
			continue
		}
		if !strings.Contains(email, "@") || len(email) > 254 || strings.ContainsAny(email, " \t,;") {
			return out, fmt.Errorf("%q isn't an email address", p.Email)
		}
		if seen[email] {
			return out, fmt.Errorf("%s is listed twice", email)
		}
		seen[email] = true
		var aliases []string
		dup := map[string]bool{}
		for _, a := range p.Aliases {
			a = strings.TrimSpace(a)
			if a == "" || dup[strings.ToLower(a)] {
				continue
			}
			if len(a) > 200 {
				return out, fmt.Errorf("alias %q is too long", clip(a, 40))
			}
			dup[strings.ToLower(a)] = true
			aliases = append(aliases, a)
		}
		if len(aliases) > spendMaxAliases {
			return out, fmt.Errorf("%s has more than %d aliases", email, spendMaxAliases)
		}
		if aliases == nil {
			aliases = []string{}
		}
		out.People = append(out.People, spend.Person{Email: email, Name: clip(strings.TrimSpace(p.Name), 120), Aliases: aliases})
	}
	price := func(dst map[string]int64, src map[string]int64, what string) error {
		for k, v := range src {
			k = strings.ToLower(strings.TrimSpace(k))
			vendor, _, _ := strings.Cut(k, "/")
			if _, known := spend.DefaultPrices.Personal[vendor]; !known && !spend.IsVendor(vendor) {
				return fmt.Errorf("%s price for unknown vendor %q", what, k)
			}
			if v < 0 || v > spendMaxPriceCent {
				return fmt.Errorf("%s price for %s is out of range", what, k)
			}
			dst[k] = v
		}
		return nil
	}
	if err := price(out.Prices.Seat, in.Prices.Seat, "seat"); err != nil {
		return out, err
	}
	if err := price(out.Prices.Personal, in.Prices.Personal, "personal plan"); err != nil {
		return out, err
	}
	return out, nil
}

func (s *Server) putSpendSettings(w http.ResponseWriter, r *http.Request, p Principal) {
	var req store.SpendSettings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "body must be {\"people\": [{\"email\", \"name\", \"aliases\": []}], \"prices\": {\"seat\": {}, \"personal\": {}}}")
		return
	}
	c, err := cleanSpendSettings(req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.Store.PutSpendSettings(r.Context(), p.Tenant, p.UserID, c); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "pricing_leaks.settings.update", "pricing_leaks", map[string]any{"people": len(c.People), "seat_prices": c.Prices.Seat, "personal_prices": c.Prices.Personal})
	c, err = s.Store.GetSpendSettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}
