package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// Endpoint health (migration 014). Two signals that a machine stopped being
// under policy:
//   - hooks: effigentd reports, with its heartbeat, whether its hook is in each
//     agent's machine-wide config (and, for Gemini CLI, whether a user turned
//     it off). An installed agent whose hook went missing or off is announced
//     once per change: webhook endpoint.hooks_missing, email, audit.
//   - offline: the detector marks machines not heard from for the tenant's
//     threshold (default 5 min, never under 2) once per silence and clears the
//     mark when they're back: webhooks endpoint.offline / endpoint.online,
//     audit, and an offline email only when the tenant picked a repeat
//     interval (default never; migration 021). The interval is remembered per
//     machine across online/offline flips, so a laptop that sleeps, wakes
//     briefly and sleeps again isn't emailed about every time. A machine
//     whose last word was daemon_stop was stopped deliberately; otherwise it
//     just went silent (sleep, network, power, or a kill that left no time to
//     say so).
// Detection time is the threshold plus up to one tick (1 min).

const (
	offlineAfterDefault = 5 * time.Minute
	offlineAfterMin     = 2 * time.Minute
	offlineAfterMax     = 7 * 24 * time.Hour
	endpointHealthTick  = time.Minute
	// a daemon_stop counts as the machine's last word when nothing was heard
	// later than this after it (the final batch itself updates last_seen)
	stopSlack = 30 * time.Second
	// offline alert emails: 0 = never, else at most once per machine per interval
	offlineAlertIntervalMin = time.Hour
	offlineAlertIntervalMax = 7 * 24 * time.Hour
)

func validOfflineAlertInterval(mins int) bool {
	d := time.Duration(mins) * time.Minute
	return mins == 0 || (d >= offlineAlertIntervalMin && d <= offlineAlertIntervalMax)
}

// everyText: 60 → "hour", 360 → "6 hours", 1440 → "day", 10080 → "week".
func everyText(mins int) string {
	switch {
	case mins == 10080:
		return "week"
	case mins == 1440:
		return "day"
	case mins == 60:
		return "hour"
	case mins%1440 == 0:
		return fmt.Sprintf("%d days", mins/1440)
	case mins%60 == 0:
		return fmt.Sprintf("%d hours", mins/60)
	}
	return fmt.Sprintf("%d minutes", mins)
}

// offlineEmailOff says why no offline email goes out under these settings
// ("" = it may, subject to the per-machine interval).
func offlineEmailOff(set store.EndpointHealthSettings) string {
	switch {
	case set.OfflineAlertIntervalMinutes <= 0:
		return "off: offline alerts set to never"
	case !set.EmailOffline:
		return "off"
	}
	return ""
}

func (s *Server) offlineAfter() time.Duration {
	if s.OfflineAfter > 0 {
		return max(s.OfflineAfter, offlineAfterMin)
	}
	return offlineAfterDefault
}

func (s *Server) healthTick() time.Duration {
	if s.HealthTick > 0 {
		return s.HealthTick
	}
	return endpointHealthTick
}

// runEndpointHealth runs the offline detector every tick on one instance at a
// time. The marks are exactly-once on their own (an update that matches only
// unmarked rows); the lock keeps instances from racing for the same batch.
func (s *Server) runEndpointHealth(ctx context.Context) {
	tick := time.NewTicker(s.healthTick())
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		s.checkEndpointHealth(ctx)
	}
}

func (s *Server) checkEndpointHealth(ctx context.Context) {
	release, ok, err := s.Store.EndpointHealthLock(ctx)
	if err != nil || !ok {
		if err != nil && ctx.Err() == nil {
			s.Logf("endpoint health: lock: %v", err)
		}
		return
	}
	defer release()
	off, err := s.Store.MarkEndpointsOffline(ctx, s.offlineAfter(), 500)
	if err != nil {
		s.Logf("endpoint health: offline: %v", err)
	}
	for _, ep := range off {
		s.announceOffline(ctx, ep)
	}
	on, err := s.Store.MarkEndpointsOnline(ctx, 500)
	if err != nil {
		s.Logf("endpoint health: online: %v", err)
	}
	for _, ep := range on {
		s.announceOnline(ctx, ep)
	}
}

// stopInfo is what effigentd's daemon_stop event says about the stop.
type stopInfo struct {
	Signal string `json:"signal,omitempty"`  // SIGTERM, SIGINT, "service stop"
	OSUser string `json:"os_user,omitempty"` // who ran effigentd in a terminal; a signal's sender isn't known
	Via    string `json:"via,omitempty"`     // systemd | launchd | windows-service | terminal
	// Shutdown: "system" (the machine was shutting down or rebooting), "no"
	// (it kept running: a tamper alert if it doesn't come back), "unknown" or
	// "" (macOS, no systemd, older builds: treated like a silence).
	Shutdown string `json:"shutdown,omitempty"`
}

// stoppedDeliberately reports whether the endpoint's last word was a
// daemon_stop (nothing heard after it).
func stoppedDeliberately(ep store.Endpoint) (stopInfo, bool) {
	var si stopInfo
	if ep.StoppedAt == nil || ep.LastSeen == nil || ep.StoppedAt.Before(ep.LastSeen.Add(-stopSlack)) {
		return si, false
	}
	_ = json.Unmarshal(ep.Stop, &si)
	return si, true
}

func (s *Server) endpointLink(id string) string {
	if s.ConsoleOrigin == "" {
		return ""
	}
	return s.ConsoleOrigin + "/enforcement?endpoint=" + url.QueryEscape(id)
}

func (s *Server) announceOffline(ctx context.Context, ep store.Endpoint) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	set, err := s.Store.GetEndpointHealthSettings(ctx, ep.Tenant, s.offlineAfter())
	if err != nil {
		s.Logf("endpoint health: settings %s: %v", ep.Tenant, err)
	}
	si, stopped := stoppedDeliberately(ep)
	reason := "silent"
	if stopped {
		reason = "stopped"
	}
	data := map[string]any{"endpoint_id": ep.ID, "hostname": ep.Hostname, "os": ep.OS, "last_seen": ep.LastSeen,
		"offline_after_seconds": set.OfflineAfterSeconds, "reason": reason}
	if stopped {
		data["stopped_at"], data["stop"] = ep.StoppedAt, si
	}
	if l := s.endpointLink(ep.ID); l != "" {
		data["review_url"] = l
	}
	s.emit(ctx, ep.Tenant, "endpoint.offline", data)

	last := "never"
	if ep.LastSeen != nil {
		last = ep.LastSeen.UTC().Format("Jan 2 15:04 MST")
	}
	m := notify.Message{
		Title: "Machine offline: " + cmpOr(ep.Hostname, ep.ID),
		Fields: [][2]string{
			{"Machine", cmpOr(ep.Hostname, ep.ID) + " (" + ep.OS + ")"},
			{"Last heard from", last},
		},
		Link: s.endpointLink(ep.ID),
		Footer: "A machine counts as offline after " + minutes(set.OfflineAfterSeconds) + " of silence. Effigent emails about a machine at most once every " +
			everyText(set.OfflineAlertIntervalMinutes) + "; change this in Enforcement settings. " +
			"A laptop that sleeps looks the same as one whose effigentd was killed; agents on it keep the last policy it has.",
	}
	if stopped {
		how := cmpOr(si.Signal, "a stop request")
		if si.Via != "" {
			how += " via " + si.Via
		}
		if si.OSUser != "" {
			how += ", run by " + si.OSUser
		}
		m.Fields = append(m.Fields, [2]string{"What happened", "effigentd was stopped at " +
			ep.StoppedAt.UTC().Format("Jan 2 15:04 MST") + " (" + how + "). Until it runs again, agent actions on it are not checked or recorded."})
	} else {
		m.Fields = append(m.Fields, [2]string{"What happened", "effigentd stopped reporting without saying it was stopping: " +
			"the machine may be asleep, off or offline, or effigentd was killed."})
	}
	var res map[string]string
	if stopped && si.Shutdown == shutdownNo {
		// switched off while the machine kept running: the tamper alert
		// (on by default, its own cooldown) instead of the offline email
		tr := s.tamperStopped(ctx, ep, si)
		res = map[string]string{"email": "see endpoint." + store.TamperStopped + " (" + tr["email"] + ")"}
	} else {
		res = s.offlineEmail(ctx, ep, set, m)
		switch {
		case !stopped:
		case si.Shutdown == "system":
			res["tamper"] = "skipped: the machine was shutting down or restarting"
		default:
			res["tamper"] = "skipped: effigentd couldn't tell whether the machine was shutting down"
		}
	}
	s.auditSystem(ctx, ep.Tenant, "endpoint.offline", ep.ID, map[string]any{"hostname": ep.Hostname, "last_seen": ep.LastSeen,
		"reason": reason, "stop": data["stop"], "offline_after_seconds": set.OfflineAfterSeconds,
		"offline_alert_interval_minutes": set.OfflineAlertIntervalMinutes, "channels": res})
}

// offlineEmail sends the offline email when the tenant wants one and none
// went out about this machine within the interval. Nothing that could stop
// the email from being sent is checked after the claim, so a claimed slot
// means an email was attempted.
func (s *Server) offlineEmail(ctx context.Context, ep store.Endpoint, set store.EndpointHealthSettings, m notify.Message) map[string]string {
	if why := offlineEmailOff(set); why != "" {
		return map[string]string{"email": why}
	}
	emails, why := s.healthRecipients(ctx, ep.Tenant)
	if why != "" {
		return map[string]string{"email": why}
	}
	every := time.Duration(set.OfflineAlertIntervalMinutes) * time.Minute
	ok, err := s.Store.ClaimOfflineAlert(ctx, ep.ID, every)
	switch {
	case err != nil:
		s.Logf("endpoint health: offline alert claim %s: %v", ep.ID, err)
		return map[string]string{"email": "error: " + clip(err.Error(), 500)}
	case !ok:
		return map[string]string{"email": "suppressed: alerted within the last " + everyText(set.OfflineAlertIntervalMinutes)}
	}
	return s.sendHealth(ctx, emails, m)
}

// announceOnline: webhook and audit only (a laptop waking up is not news
// worth an email).
func (s *Server) announceOnline(ctx context.Context, ep store.Endpoint) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	data := map[string]any{"endpoint_id": ep.ID, "hostname": ep.Hostname, "os": ep.OS, "last_seen": ep.LastSeen,
		"offline_since": ep.OfflineAt}
	s.emit(ctx, ep.Tenant, "endpoint.online", data)
	s.auditSystem(ctx, ep.Tenant, "endpoint.online", ep.ID, map[string]any{"hostname": ep.Hostname, "offline_since": ep.OfflineAt})
}

// emailHealth sends a health alert to the workspace's notification emails
// and says where it went (for the audit entry).
func (s *Server) emailHealth(ctx context.Context, tenant string, on bool, m notify.Message) map[string]string {
	if !on {
		return map[string]string{"email": "off"}
	}
	emails, why := s.healthRecipients(ctx, tenant)
	if why != "" {
		return map[string]string{"email": why}
	}
	return s.sendHealth(ctx, emails, m)
}

// healthRecipients returns the workspace's notification emails, or why no
// email can go out.
func (s *Server) healthRecipients(ctx context.Context, tenant string) ([]string, string) {
	n, err := s.Store.GetNotificationSettings(ctx, tenant)
	if err != nil {
		s.Logf("endpoint health: notification settings %s: %v", tenant, err)
	}
	switch {
	case len(n.Emails) == 0:
		return nil, "no recipients"
	case s.Notify == nil || !s.Notify.EmailEnabled():
		return nil, "off: this control plane doesn't send email"
	}
	return n.Emails, ""
}

func (s *Server) sendHealth(ctx context.Context, emails []string, m notify.Message) map[string]string {
	var failed []string
	for _, rcpt := range emails {
		if err := s.Notify.Email(ctx, []string{rcpt}, m); err != nil {
			failed = append(failed, rcpt+": "+err.Error())
		}
	}
	if len(failed) > 0 {
		return map[string]string{"email": "error: " + clip(strings.Join(failed, "; "), 500)}
	}
	return map[string]string{"email": "sent"}
}

func minutes(secs int) string {
	if secs%60 != 0 || secs < 60 {
		return fmt.Sprintf("%d seconds", secs)
	}
	if secs == 60 {
		return "1 minute"
	}
	return fmt.Sprintf("%d minutes", secs/60)
}

// ---- hooks ----

// hookReport is the report effigentd sends with its heartbeat
// (internal/endpoint/hookstate).
type hookReport struct {
	Sensor string                    `json:"sensor"` // tetragon | hooks
	Agents map[string]hookAgentState `json:"agents"`
	// Expected is added by the control plane: agents whose hook was seen in
	// place in some report, so its removal is an alarm on any machine.
	Expected []string `json:"expected,omitempty"`
}

type hookAgentState struct {
	Present    bool     `json:"present"` // the agent's program was found on the machine
	State      string   `json:"state"`   // installed | missing | modified | unreadable
	File       string   `json:"file"`
	Detail     string   `json:"detail,omitempty"`
	DisabledBy []string `json:"disabled_by,omitempty"` // users who turned the hook off in their own settings
}

func (a hookAgentState) broken() bool { return a.State != "installed" || len(a.DisabledBy) > 0 }

// problems lists the agents whose hook is gone or off where it matters: the
// agent is on a machine that relies on hooks (no kernel layer), or its hook
// was in place before (someone removed it). A Linux machine that never had
// hooks installed is not an alarm.
func (r *hookReport) problems() map[string]hookAgentState {
	out := map[string]hookAgentState{}
	if r == nil {
		return out
	}
	for name, a := range r.Agents {
		if a.broken() && ((a.Present && r.Sensor == "hooks") || slices.Contains(r.Expected, name)) {
			out[name] = a
		}
	}
	return out
}

func problemKey(a hookAgentState) string {
	d := slices.Clone(a.DisabledBy)
	sort.Strings(d)
	return a.State + "|" + strings.Join(d, ",")
}

func parseHookReport(raw json.RawMessage) *hookReport {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var r hookReport
	if json.Unmarshal(raw, &r) != nil || r.Agents == nil {
		return nil
	}
	return &r
}

// withExpected is the report as stored: the endpoint's own, plus the agents
// whose hook was in place in this or an earlier report.
func withExpected(raw json.RawMessage, cur, prev *hookReport) json.RawMessage {
	var exp []string
	if prev != nil {
		exp = append(exp, prev.Expected...)
	}
	for name, a := range cur.Agents {
		if !a.broken() {
			exp = append(exp, name)
		}
	}
	sort.Strings(exp)
	cur.Expected = slices.Compact(exp)
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return raw
	}
	m["expected"], _ = json.Marshal(cur.Expected)
	out, _ := json.Marshal(m)
	return out
}

// reportHooks stores an endpoint's hook report and announces hooks that went
// missing or off since the previous one (and records the ones restored).
func (s *Server) reportHooks(ctx context.Context, ep store.Endpoint, raw json.RawMessage) error {
	cur := parseHookReport(raw)
	if cur == nil {
		return nil
	}
	prevRaw, err := s.Store.SetEndpointHooks(ctx, ep.ID, func(prevRaw json.RawMessage) json.RawMessage {
		return withExpected(raw, cur, parseHookReport(prevRaw))
	})
	if err != nil {
		return err
	}
	now, before := cur.problems(), parseHookReport(prevRaw).problems()
	var names []string
	for name, a := range now {
		if b, ok := before[name]; ok && problemKey(b) == problemKey(a) {
			continue // already announced
		}
		names = append(names, name)
	}
	sort.Strings(names)
	var fresh []map[string]any
	for _, name := range names {
		a := now[name]
		fresh = append(fresh, map[string]any{"agent": name, "state": a.State, "file": a.File, "detail": a.Detail,
			"disabled_by": a.DisabledBy, "agent_installed": a.Present})
	}
	var restored []string
	for name := range before {
		if _, still := now[name]; !still {
			restored = append(restored, name)
		}
	}
	sort.Strings(restored)
	if len(restored) > 0 {
		s.auditSystem(ctx, ep.Tenant, "endpoint.hooks_restored", ep.ID, map[string]any{"hostname": ep.Hostname, "agents": restored})
	}
	if len(fresh) == 0 {
		return nil
	}
	go s.announceHooks(context.WithoutCancel(ctx), ep, fresh) // the heartbeat answers now
	return nil
}

var hookAgentLabel = map[string]string{"claude": "Claude Code", "codex": "Codex", "gemini": "Gemini CLI", "cursor": "Cursor"}

func (s *Server) announceHooks(ctx context.Context, ep store.Endpoint, agents []map[string]any) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	data := map[string]any{"endpoint_id": ep.ID, "hostname": ep.Hostname, "os": ep.OS, "agents": agents}
	if l := s.endpointLink(ep.ID); l != "" {
		data["review_url"] = l
	}
	s.emit(ctx, ep.Tenant, "endpoint.hooks_missing", data)
	set, err := s.Store.GetEndpointHealthSettings(ctx, ep.Tenant, s.offlineAfter())
	if err != nil {
		s.Logf("endpoint health: settings %s: %v", ep.Tenant, err)
	}
	m := notify.Message{
		Title:  "Agent hook missing on " + cmpOr(ep.Hostname, ep.ID),
		Fields: [][2]string{{"Machine", cmpOr(ep.Hostname, ep.ID) + " (" + ep.OS + ")"}},
		Link:   s.endpointLink(ep.ID),
		Footer: "Without its hook an agent's tool calls aren't checked against your policy on this machine. " +
			"Re-run `sudo effigentd install-hooks` there (the installers do this), and find out who changed the file.",
	}
	for _, a := range agents {
		name, _ := a["agent"].(string)
		what := describeHook(a)
		m.Fields = append(m.Fields, [2]string{cmpOr(hookAgentLabel[name], name), what})
	}
	res := s.emailHealth(ctx, ep.Tenant, set.EmailHooks, m)
	s.auditSystem(ctx, ep.Tenant, "endpoint.hooks_missing", ep.ID, map[string]any{"hostname": ep.Hostname, "agents": agents, "channels": res})
}

func describeHook(a map[string]any) string {
	state, _ := a["state"].(string)
	file, _ := a["file"].(string)
	detail, _ := a["detail"].(string)
	var out string
	switch state {
	case "missing":
		out = "effigentd's hook is not in " + file
	case "modified":
		out = "effigentd's hook in " + file + " was changed"
	case "unreadable":
		out = file + " could not be read"
	default:
		out = "hook in " + file
	}
	if detail != "" {
		out += ": " + detail
	}
	if by, _ := a["disabled_by"].([]string); len(by) > 0 {
		out += "; turned off by " + strings.Join(by, ", ")
	}
	return out
}

// ---- console: GET/PUT /api/v1/endpoint-health ----

func (s *Server) healthView(ctx context.Context, tenant string) (map[string]any, error) {
	set, err := s.Store.GetEndpointHealthSettings(ctx, tenant, s.offlineAfter())
	if err != nil {
		return nil, err
	}
	n, err := s.Store.GetNotificationSettings(ctx, tenant)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"offline_after_minutes": set.OfflineAfterSeconds / 60, "email_offline": set.EmailOffline, "email_hooks": set.EmailHooks, "email_tamper": set.EmailTamper,
		"default_minutes": int(s.offlineAfter() / time.Minute), "min_minutes": int(offlineAfterMin / time.Minute),
		"tick_seconds": int(s.healthTick() / time.Second), "offline_alert_interval_minutes": set.OfflineAlertIntervalMinutes, "emails": n.Emails, "email_available": s.Notify != nil && s.Notify.EmailEnabled(),
		"webhook_events": []string{"endpoint.offline", "endpoint.online", "endpoint.hooks_missing", "endpoint.tamper"},
		"updated_by":     set.UpdatedBy, "updated_at": set.UpdatedAt, "saved": set.Saved,
	}, nil
}

func (s *Server) getEndpointHealth(w http.ResponseWriter, r *http.Request, p Principal) {
	v, err := s.healthView(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) putEndpointHealth(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		OfflineAfterMinutes         *int  `json:"offline_after_minutes"`
		EmailOffline                *bool `json:"email_offline"`
		OfflineAlertIntervalMinutes *int  `json:"offline_alert_interval_minutes"`
		EmailHooks                  *bool `json:"email_hooks"`
		EmailTamper                 *bool `json:"email_tamper"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	before, err := s.Store.GetEndpointHealthSettings(r.Context(), p.Tenant, s.offlineAfter())
	if err != nil {
		s.fail(w, err)
		return
	}
	after := before
	if req.OfflineAfterMinutes != nil {
		d := time.Duration(*req.OfflineAfterMinutes) * time.Minute
		if d < offlineAfterMin || d > offlineAfterMax {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("offline_after_minutes must be %d to %d", int(offlineAfterMin/time.Minute), int(offlineAfterMax/time.Minute)))
			return
		}
		after.OfflineAfterSeconds = int(d / time.Second)
	}
	if req.OfflineAlertIntervalMinutes != nil {
		if !validOfflineAlertInterval(*req.OfflineAlertIntervalMinutes) {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("offline_alert_interval_minutes must be 0 (never) or %d to %d",
				int(offlineAlertIntervalMin/time.Minute), int(offlineAlertIntervalMax/time.Minute)))
			return
		}
		after.OfflineAlertIntervalMinutes = *req.OfflineAlertIntervalMinutes
	}
	if req.EmailOffline != nil {
		after.EmailOffline = *req.EmailOffline
	}
	if req.EmailHooks != nil {
		after.EmailHooks = *req.EmailHooks
	}
	if req.EmailTamper != nil {
		after.EmailTamper = *req.EmailTamper
	}
	if err := s.Store.PutEndpointHealthSettings(r.Context(), p.Tenant, after, p.UserID); err != nil {
		s.fail(w, err)
		return
	}
	view := func(h store.EndpointHealthSettings) map[string]any {
		return map[string]any{"offline_after_seconds": h.OfflineAfterSeconds, "email_offline": h.EmailOffline,
			"offline_alert_interval_minutes": h.OfflineAlertIntervalMinutes, "email_hooks": h.EmailHooks, "email_tamper": h.EmailTamper}
	}
	s.audit(r, p, "endpoint_health.update", "", map[string]any{"before": view(before), "after": view(after)})
	s.getEndpointHealth(w, r, p)
}
