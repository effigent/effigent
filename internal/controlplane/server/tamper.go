package server

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// Tamper alerts (migration 022): signs that someone switched enforcement off
// on a machine that kept running. Unlike offline alerts they are emailed by
// default (email_tamper), and never for a machine that slept, went silent,
// shut down or rebooted:
//   - daemon_stopped: a daemon_stop whose `shutdown` is "no" (effigentd
//     knew the OS wasn't going down) and the machine didn't come back within
//     its offline threshold. Announced by the offline detector, so a restart
//     or an upgrade (back within seconds) never alerts. "system" (shutdown,
//     reboot) and "unknown" (macOS, no systemd, builds before the field) don't.
//   - unclean_restart: a daemon_unclean_restart whose `shutdown` is "no"
//     (the machine booted before the previous run started: killed or crashed,
//     not a power loss). Announced at ingest: effigentd is back by then.
//   - policy_load_failed: a high-severity kernel policy load failure.
//
// Each kind is claimed per machine with a cooldown (one update, so instances
// can't both send). Replayed batches are dropped by batch_id before this, and a
// stop is announced once per silence (the offline mark).

var tamperCooldown = map[string]time.Duration{
	store.TamperStopped: time.Hour,
	store.TamperUnclean: time.Hour,
	// a host whose kernel refuses a policy fails at every agent start
	store.TamperPolicyFailure: 24 * time.Hour,
}

// shutdownNo is the daemon's "the machine kept running" (event.Event.Shutdown).
const shutdownNo = "no"

// tamperEvent is an unclean restart or a failed kernel policy load from one batch.
type tamperEvent struct {
	Kind     string
	Time     time.Time
	Shutdown string // unclean restarts: system | no | unknown ("" from builds before the field)
	Agent    string
	Rule     string
	Message  string
	Count    int // policy load failures in the batch
}

// tamperFromBatch picks what may be alerted from one ingested batch: the
// newest unclean restart, and the newest failed kernel policy load (with how
// many the batch had).
func tamperFromBatch(evs []store.Event) []tamperEvent {
	newest := map[string]*tamperEvent{}
	count := map[string]int{}
	var kinds []string
	for _, e := range evs {
		var kind string
		switch {
		case e.Type == "daemon_unclean_restart":
			kind = store.TamperUnclean
		case e.Type == "policy" && e.Severity == "high": // engine: "failed to load kernel policy"
			kind = store.TamperPolicyFailure
		default:
			continue
		}
		count[kind]++
		cur := newest[kind]
		if cur == nil {
			kinds = append(kinds, kind)
		} else if e.Time.Before(cur.Time) {
			continue
		}
		var body struct {
			Shutdown string `json:"shutdown"`
			Rule     string `json:"rule"`
			Message  string `json:"message"`
		}
		_ = json.Unmarshal(e.Body, &body)
		newest[kind] = &tamperEvent{Kind: kind, Time: e.Time, Shutdown: clip(body.Shutdown, 20), Agent: clip(e.Agent, 120),
			Rule: clip(body.Rule, 200), Message: clip(body.Message, 500)}
	}
	out := make([]tamperEvent, 0, len(kinds))
	for _, k := range kinds {
		te := *newest[k]
		te.Count = count[k]
		out = append(out, te)
	}
	return out
}

// announceTamperEvent handles an unclean restart or a policy load failure
// from ingest. Audited whatever happens.
func (s *Server) announceTamperEvent(ctx context.Context, ep store.Endpoint, te tamperEvent) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	host := cmpOr(ep.Hostname, ep.ID)
	details := map[string]any{"event_time": te.Time, "message": te.Message}
	var res map[string]string
	switch te.Kind {
	case store.TamperUnclean:
		details["shutdown"] = te.Shutdown
		switch te.Shutdown {
		case shutdownNo:
			res = s.tamperAlert(ctx, ep, te.Kind, details, notify.Message{
				Title: "effigentd was killed or crashed on " + host,
				Fields: [][2]string{
					{"Machine", host + " (" + ep.OS + ")"},
					{"What happened", te.Message + ". The machine itself kept running, so effigentd was killed (for example kill -9) or crashed. " +
						"It is running again since " + te.Time.UTC().Format("Jan 2 15:04 MST") + "; agent actions in between were not checked or recorded."},
				},
			})
		case "system":
			res = map[string]string{"email": "skipped: the machine itself restarted (power loss, OS crash or forced power-off)"}
		default:
			res = map[string]string{"email": "skipped: effigentd didn't say whether the machine restarted (build before the shutdown field)"}
		}
	case store.TamperPolicyFailure:
		details["agent"], details["rule"], details["count"] = te.Agent, te.Rule, te.Count
		fields := [][2]string{
			{"Machine", host + " (" + ep.OS + ")"},
			{"Agent", cmpOr(te.Agent, "—")},
			{"Policy", cmpOr(te.Rule, "—")},
			{"Error", te.Message},
		}
		if te.Count > 1 {
			fields = append(fields, [2]string{"Failures", fmt.Sprintf("%d in this report", te.Count)})
		}
		res = s.tamperAlert(ctx, ep, te.Kind, details, notify.Message{
			Title:  "Kernel policy failed to load on " + host,
			Fields: fields,
			Footer: "Until it loads, that agent isn't blocked in the kernel on this machine (its hooks still apply where installed). " +
				"Usually BPF LSM is off or Tetragon is unhealthy: run `effigentd status` there.",
		})
	default:
		return
	}
	details["hostname"], details["channels"] = ep.Hostname, res
	s.auditSystem(ctx, ep.Tenant, "endpoint."+te.Kind, ep.ID, details)
}

// tamperStopped is the stop alert, from the offline detector: the machine's
// last word was a daemon_stop that said the OS kept running. Audited here;
// returns what happened for the offline entry.
func (s *Server) tamperStopped(ctx context.Context, ep store.Endpoint, si stopInfo) map[string]string {
	host := cmpOr(ep.Hostname, ep.ID)
	how := cmpOr(si.Signal, "a stop request")
	if si.Via != "" {
		how += " via " + si.Via
	}
	if si.OSUser != "" {
		how += ", run by " + si.OSUser
	}
	details := map[string]any{"stopped_at": ep.StoppedAt, "last_seen": ep.LastSeen, "stop": si}
	res := s.tamperAlert(ctx, ep, store.TamperStopped, details, notify.Message{
		Title: "effigentd was stopped on " + host,
		Fields: [][2]string{
			{"Machine", host + " (" + ep.OS + ")"},
			{"What happened", "effigentd was stopped at " + ep.StoppedAt.UTC().Format("Jan 2 15:04 MST") + " (" + how +
				") while the machine kept running, and it hasn't checked in since. Until it runs again, agent actions on it are not checked or recorded."},
		},
	})
	details["hostname"], details["channels"] = ep.Hostname, res
	s.auditSystem(ctx, ep.Tenant, "endpoint."+store.TamperStopped, ep.ID, details)
	return res
}

// tamperAlert claims the machine's cooldown for this kind, then sends the
// endpoint.tamper webhook and (email_tamper) the email. It says where the
// alert went, for the audit entry.
func (s *Server) tamperAlert(ctx context.Context, ep store.Endpoint, kind string, details map[string]any, m notify.Message) map[string]string {
	cooldown := tamperCooldown[kind]
	ok, err := s.Store.ClaimTamperAlert(ctx, ep.ID, kind, cooldown)
	switch {
	case err != nil:
		s.Logf("endpoint health: tamper alert claim %s: %v", ep.ID, err)
		return map[string]string{"email": "error: " + clip(err.Error(), 500)}
	case !ok:
		return map[string]string{"email": "suppressed: alerted within the last " + everyText(int(cooldown/time.Minute))}
	}
	data := map[string]any{"kind": kind, "endpoint_id": ep.ID, "hostname": ep.Hostname, "os": ep.OS}
	for k, v := range details {
		data[k] = v
	}
	if l := s.endpointLink(ep.ID); l != "" {
		data["review_url"] = l
	}
	s.emit(ctx, ep.Tenant, "endpoint.tamper", data)
	set, err := s.Store.GetEndpointHealthSettings(ctx, ep.Tenant, s.offlineAfter())
	if err != nil {
		s.Logf("endpoint health: settings %s: %v", ep.Tenant, err)
	}
	m.Link = s.endpointLink(ep.ID)
	if m.Footer != "" {
		m.Footer += " "
	}
	m.Footer += "Effigent sends this at most once every " + everyText(int(cooldown/time.Minute)) + " per machine, and never for a machine " +
		"that sleeps, shuts down or restarts. Turn these emails off in Enforcement → Machine health alerts."
	return s.emailHealth(ctx, ep.Tenant, set.EmailTamper, m)
}
