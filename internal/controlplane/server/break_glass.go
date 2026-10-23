package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/effigent/effigent/internal/shared/sign"
	"github.com/google/uuid"
)

// Break-glass (FR Q18): an admin creates a short signed code that lifts a
// machine's approval lists while the control plane is unreachable. The code
// is returned once, to be read out to the user; the control plane keeps only
// its id and metadata. Use is reported when the machine reconnects (a
// break_glass_start event), which marks the code used and notifies.
//
// Two-person rule: creating a code is deliberately NOT gated behind policy
// change approval, even where that is on (migration 013). An outage is the
// emergency the code exists for, and a second admin may be unreachable. The
// compensating controls are that a code only ever LIFTS approvals (never deny
// lists), lasts at most 8h, needs a written reason, and both its creation and
// its use alert every notification email and webhook and show in the console.

// The posture report's break_glass section: codes issued, revoked and left
// unused, and every activation in the period (always present, zeros included:
// "no break-glass this period" is part of the posture).
func init() {
	RegisterReportSection(ReportSection{Key: "break_glass",
		Build: func(ctx context.Context, s *Server, tenant string, from, to time.Time) (any, error) {
			return s.Store.BreakGlassActivity(ctx, tenant, from, to)
		}})
}

func (s *Server) createBreakGlass(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		EndpointID      string `json:"endpoint_id"` // "" / "*" = all machines
		DurationMinutes int    `json:"duration_minutes"`
		Reason          string `json:"reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		writeErr(w, http.StatusBadRequest, "a reason is required")
		return
	}
	dur, err := sign.ValidBreakGlassDuration(time.Duration(req.DurationMinutes) * time.Minute)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	endpoint := strings.TrimSpace(req.EndpointID)
	if endpoint == sign.AllMachines {
		endpoint = ""
	}
	if endpoint != "" {
		if _, err := uuid.Parse(endpoint); err != nil {
			writeErr(w, http.StatusNotFound, "no such machine")
			return
		}
		if _, err := s.Store.GetEndpoint(r.Context(), p.Tenant, endpoint); errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "no such machine")
			return
		} else if err != nil {
			s.fail(w, err)
			return
		}
	}
	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		s.fail(w, err)
		return
	}
	expiry := time.Now().Add(dur).Truncate(time.Minute)
	code, id, err := sign.EncodeBreakGlass(s.Key, p.Tenant, cmpOr(endpoint, sign.AllMachines), expiry, nonce)
	if err != nil {
		s.fail(w, err)
		return
	}
	c := store.BreakGlassCode{ID: id, Tenant: p.Tenant, EndpointID: endpoint, Reason: clip(req.Reason, 500),
		Expiry: expiry, CreatedBy: p.UserID, CreatedByName: s.principalName(r.Context(), p), CreatedVia: p.Via}
	if err := s.Store.CreateBreakGlass(r.Context(), c); err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "break_glass.create", id, map[string]any{"endpoint_id": endpoint, "expiry": expiry,
		"duration_minutes": int(dur / time.Minute), "reason": c.Reason})
	s.notifyBreakGlass(r.Context(), p.Tenant, "break_glass.created", c, "")
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "code": code, "endpoint_id": endpoint, "expiry": expiry, "duration_minutes": int(dur / time.Minute),
		"message": "Read this code to the user on the machine; they run: effigentd break-glass <code>. " +
			"It is shown only once and lifts approval lists only (deny rules keep working) until it expires.",
	})
}

func (s *Server) listBreakGlass(w http.ResponseWriter, r *http.Request, p Principal) {
	cs, err := s.Store.ListBreakGlass(r.Context(), p.Tenant, 200)
	if err != nil {
		s.fail(w, err)
		return
	}
	now := time.Now()
	type view struct {
		store.BreakGlassCode
		Status string `json:"status"`
	}
	out := make([]view, 0, len(cs))
	for _, c := range cs {
		st := "active"
		switch {
		case c.RevokedAt != nil:
			st = "revoked"
		case c.UsedAt != nil:
			st = "used"
		case now.After(c.Expiry):
			st = "expired"
		}
		out = append(out, view{BreakGlassCode: c, Status: st})
	}
	writeJSON(w, http.StatusOK, map[string]any{"codes": out})
}

func (s *Server) revokeBreakGlass(w http.ResponseWriter, r *http.Request, p Principal) {
	id := r.PathValue("id")
	if err := s.Store.RevokeBreakGlass(r.Context(), p.Tenant, id); errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such code, or already revoked")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "break_glass.revoke", id, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true,
		"message": "Revoked in the console. A machine that is already offline and has the code can still use it until it expires."})
}

// recordBreakGlassUse is called from event ingest when a machine reports a
// break_glass_start: it marks the code used and notifies (webhook + email +
// audit). An unknown id (code created against another control plane, or
// pruned) is still audited, so the use is never silent.
func (s *Server) recordBreakGlassUse(ctx context.Context, ep store.Endpoint, at time.Time, body json.RawMessage) {
	var b struct {
		Rule   string `json:"rule"`    // the grant id (nonce)
		OSUser string `json:"os_user"` // who ran break-glass (self-asserted)
		Target string `json:"target"`  // the window's expiry, for the record
	}
	_ = json.Unmarshal(body, &b)
	id := strings.TrimSpace(b.Rule)
	if id == "" {
		return
	}
	c, first, err := s.Store.MarkBreakGlassUsed(ctx, ep.Tenant, id, at, clip(b.OSUser, 120), ep.ID)
	if errors.Is(err, store.ErrNotFound) {
		s.auditSystem(ctx, ep.Tenant, "break_glass.used", id, map[string]any{"endpoint_id": ep.ID,
			"hostname": ep.Hostname, "os_user": clip(b.OSUser, 120), "unknown_code": true})
		return
	} else if err != nil {
		s.Logf("break-glass: mark used %s: %v", id, err)
		return
	}
	s.auditSystem(ctx, ep.Tenant, "break_glass.used", id, map[string]any{"endpoint_id": ep.ID, "hostname": ep.Hostname,
		"os_user": clip(b.OSUser, 120), "first_use": first, "reason": c.Reason, "created_by": c.CreatedByName})
	s.notifyBreakGlass(ctx, ep.Tenant, "break_glass.used", c, ep.Hostname+" ("+ep.ID+"), by "+cmpOr(c.UsedBy, "an operator"))
}

// notifyBreakGlass sends the webhook and emails the notification addresses.
func (s *Server) notifyBreakGlass(ctx context.Context, tenant, typ string, c store.BreakGlassCode, on string) {
	scope := "all machines"
	if c.EndpointID != "" {
		scope = c.EndpointID
	}
	data := map[string]any{"id": c.ID, "endpoint_id": c.EndpointID, "scope": scope, "reason": c.Reason,
		"expiry": c.Expiry, "created_by": c.CreatedByName}
	if typ == "break_glass.used" {
		data["used_on"] = on
	}
	if l := s.breakGlassLink(); l != "" {
		data["review_url"] = l
	}
	s.emit(ctx, tenant, typ, data)

	title := "Break-glass code created for " + scope
	what := "An admin created an offline break-glass code (it lifts approval lists only, not deny rules)."
	if typ == "break_glass.used" {
		title = "Break-glass code used: " + scope
		what = "A machine activated a break-glass code: " + on + ". Approval-required actions on it run without approval until the window ends."
	}
	m := notify.Message{Title: title, Link: s.breakGlassLink(), Fields: [][2]string{
		{"Scope", scope},
		{"Reason", c.Reason},
		{"Created by", c.CreatedByName},
		{"Window ends", c.Expiry.UTC().Format("Jan 2 15:04 MST")},
		{"What happened", what},
	}}
	s.emailNotify(ctx, tenant, m)
}

// breakGlassLink is the console page listing break-glass codes.
func (s *Server) breakGlassLink() string {
	if s.ConsoleOrigin == "" {
		return ""
	}
	return s.ConsoleOrigin + "/enforcement#break-glass"
}

// emailNotify sends m to the tenant's notification emails (unconditional:
// break-glass creation and use always alert).
func (s *Server) emailNotify(ctx context.Context, tenant string, m notify.Message) {
	if s.Notify == nil || !s.Notify.EmailEnabled() {
		return
	}
	n, err := s.Store.GetNotificationSettings(ctx, tenant)
	if err != nil {
		s.Logf("break-glass: notification settings %s: %v", tenant, err)
		return
	}
	for _, rcpt := range n.Emails {
		if err := s.Notify.Email(ctx, []string{rcpt}, m); err != nil {
			s.Logf("break-glass: email %s: %v", rcpt, err)
		}
	}
}
