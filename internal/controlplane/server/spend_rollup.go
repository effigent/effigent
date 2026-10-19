package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// Pricing Leaks history and runaway cost alerts (migration 011). The rollup
// job computes each tenant's report (spendReport, the page's own) when its
// spend data changed and at least hourly, stores it as today's rows and
// updates the leak log. Runaway cost leaks that just appeared are then
// announced: webhook event pricing_leaks.runaway_cost (s.emit), email and,
// where Slack is on, the workspace's Slack.

const (
	spendRollupDefault  = time.Hour
	spendMetricsDays    = 90
	spendMetricsMaxDays = 365
	spendAlertEvent     = "pricing_leaks.runaway_cost"
)

func (s *Server) spendRollupEvery() time.Duration {
	if s.SpendRollupEvery > 0 {
		return s.SpendRollupEvery
	}
	return spendRollupDefault
}

// runSpendRollups rolls up due tenants every minute. The first pass waits a
// tick, so a control plane that just started serves requests first.
func (s *Server) runSpendRollups(ctx context.Context) {
	tick := time.NewTicker(spendPollTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		due, err := s.Store.DueSpendRollups(ctx, s.spendRollupEvery(), 50)
		if err != nil && ctx.Err() == nil {
			s.Logf("pricing leaks: due rollups: %v", err)
		}
		for _, tenant := range due {
			if ctx.Err() != nil {
				return
			}
			if err := s.rollupSpend(ctx, tenant); err != nil {
				s.Logf("pricing leaks: rollup %s: %v", tenant, err)
			}
		}
	}
}

// rollupSpend records a tenant's report as of now and announces new runaway
// cost leaks, under the tenant's rollup lock (another instance holding it
// is already doing this).
func (s *Server) rollupSpend(ctx context.Context, tenant string) error {
	release, ok, err := s.Store.SpendRollupLock(ctx, tenant)
	if err != nil || !ok {
		return err
	}
	defer release()
	started := time.Now().UTC()
	rep, _, set, err := s.spendReport(ctx, tenant, started)
	if err == nil {
		err = s.Store.RecordSpendReport(ctx, tenant, rep, started)
	}
	if err != nil {
		if ferr := s.Store.FailSpendRollup(ctx, tenant, clip(err.Error(), 500)); ferr != nil {
			s.Logf("pricing leaks: record rollup failure: %v", ferr)
		}
		return err
	}
	leaks, err := s.Store.ClaimSpendAlerts(ctx, tenant, spend.AlertTypes, spend.AlertRepeat)
	if err != nil {
		return err
	}
	for _, l := range leaks {
		s.announceSpendLeak(ctx, tenant, set, l)
	}
	return nil
}

// announceSpendLeak sends one runaway cost alert and records where it went.
// With alerts turned off the leak is marked as seen ("off") and not sent, so
// turning them back on doesn't replay what is already on the page.
func (s *Server) announceSpendLeak(ctx context.Context, tenant string, set store.SpendSettings, l store.SpendLeak) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res := map[string]string{}
	review := ""
	if s.ConsoleOrigin != "" {
		review = s.ConsoleOrigin + "/pricing-leaks?leak=" + url.QueryEscape(l.ID)
	}
	if !set.Alerts.RunawayOn() {
		res["alerts"] = "off"
	} else {
		data := map[string]any{"leak": l}
		if review != "" {
			data["review_url"] = review
		}
		s.emit(ctx, tenant, spendAlertEvent, data)
		n, err := s.Store.GetNotificationSettings(ctx, tenant)
		if err != nil {
			s.Logf("pricing leaks: alert %s: notification settings: %v", l.ID, err)
		}
		m := spendAlertMessage(l, review)
		recipients := set.Alerts.Emails
		if len(recipients) == 0 {
			recipients = n.Emails
		}
		switch {
		case len(recipients) == 0:
		case !s.Notify.EmailEnabled():
			res["email"] = "off: this control plane doesn't send email"
		default:
			var failed []string
			for _, rcpt := range recipients {
				if err := s.Notify.Email(ctx, []string{rcpt}, m); err != nil {
					failed = append(failed, rcpt+": "+err.Error())
				}
			}
			res["email"] = "sent"
			if len(failed) > 0 {
				res["email"] = "error: " + clip(strings.Join(failed, "; "), 500)
			}
		}
		if s.SlackEnabled && (n.SlackApp.Connected() || n.SlackWebhook != "") {
			res["slack"] = "sent"
			if err := s.postSlack(ctx, tenant, n, m, nil); err != nil {
				res["slack"] = "error: " + clip(err.Error(), 300)
			}
		}
	}
	if err := s.Store.SetSpendAlertResult(ctx, tenant, l.ID, res); err != nil {
		s.Logf("pricing leaks: alert %s: %v", l.ID, err)
	}
	s.auditSystem(ctx, tenant, "pricing_leaks.alert", l.ID, map[string]any{"type": l.Type, "vendor": l.Vendor, "person": l.Person,
		"title": l.Title, "monthly_savings_cents": l.SavingsCents, "channels": res})
}

// auditSystem records something the control plane did on its own.
func (s *Server) auditSystem(ctx context.Context, tenant, action, target string, details any) {
	p := Principal{UserID: "system", Tenant: tenant, Role: "admin", Via: "system"}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/internal/pricing-leaks", nil)
	s.audit(req, p, action, target, details)
}

func spendAlertMessage(l store.SpendLeak, review string) notify.Message {
	who := cmpOr(l.Name, l.Person)
	switch {
	case l.Person == "":
		who = "The organisation (not tied to a person)"
	case l.Name != "" && strings.Contains(l.Person, "@") && !strings.Contains(l.Person, ":"):
		who = l.Name + " <" + l.Person + ">"
	}
	m := notify.Message{
		Title: "Runaway AI spend: " + l.Title,
		Fields: [][2]string{
			{"Who", who},
			{"Vendor", cmpOr(spend.VendorLabel[l.Vendor], l.Vendor)},
			{"Above the usual", usd(l.SavingsCents) + " a month at this rate"},
			{"Evidence", strings.Join(l.Evidence, "\n")},
			{"Confidence", l.Confidence},
			{"First seen", l.FirstSeenAt.UTC().Format("Jan 2 15:04 MST")},
		},
		Link:   review,
		Footer: "Effigent Pricing Leaks announces a runaway cost once, and weekly while it lasts. Turn these alerts off on the Pricing Leaks page.",
	}
	return m
}

func usd(cents int64) string {
	if cents%100 == 0 {
		return fmt.Sprintf("$%d", cents/100)
	}
	return fmt.Sprintf("$%.2f", float64(cents)/100)
}

// spendMetrics is Spend over time: daily vendor usage and effigentd's agent
// activity per billed vendor (from the first sync on), and the rolled-up
// report and leaks (from the first rollup on). ?days=7…365, default 90.
func (s *Server) spendMetrics(w http.ResponseWriter, r *http.Request, p Principal) {
	days := spendMetricsDays
	if v := r.URL.Query().Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 7 || n > spendMetricsMaxDays {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("days must be 7 to %d", spendMetricsMaxDays))
			return
		}
		days = n
	}
	ctx := r.Context()
	to := spend.Day(time.Now().UTC())
	from := to.AddDate(0, 0, -(days - 1))
	_, usage, err := s.Store.SpendData(ctx, p.Tenant, from)
	if err != nil {
		s.fail(w, err)
		return
	}
	activity, err := s.Store.AgentActivity(ctx, p.Tenant, from)
	if err != nil {
		s.fail(w, err)
		return
	}
	report, leaks, err := s.Store.SpendHistory(ctx, p.Tenant, from)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"days": days, "from": from, "to": to,
		"usage": spend.DailyUsage(usage), "activity": spend.DailyActivity(activity),
		"report": report, "leaks": leaks,
	})
}

// spendAlerts lists runaway cost leaks, open and resolved, with where each
// announcement went, plus the alert settings.
func (s *Server) spendAlerts(w http.ResponseWriter, r *http.Request, p Principal) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	log, err := s.Store.SpendLeakLog(r.Context(), p.Tenant, spend.AlertTypes, limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	set, err := s.Store.GetSpendSettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	n, err := s.Store.GetNotificationSettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"alerts": log, "runaway_cost": set.Alerts.RunawayOn(), "emails": set.Alerts.Emails,
		"default_emails": n.Emails, "email_available": s.Notify.EmailEnabled(), "webhook_event": spendAlertEvent,
	})
}
