package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Per-workspace retention and legal hold (Settings → Storage, admins).
// retention_days overrides EFFIGENT_EVENT_RETENTION_DAYS for the tenant
// (never under 90). A legal hold stops every deletion of the tenant's
// events — retention skips it, and the database's delete guard refuses it —
// and puts an S3 Object Lock legal hold on every version of its archive
// objects (released the same way). Without an archive bucket the hold
// still stops deletion (nothing is deleted then anyway). The S3 sync runs
// right after a change and then with retention until it succeeds; it is
// idempotent, so an interrupted run is just run again.

// archivePrefix is where a tenant's archive objects live (archiveKey).
func archivePrefix(tenant string) string {
	return "events/" + strings.NewReplacer("/", "_", "..", "_").Replace(tenant) + "/"
}

func (s *Server) retentionView(ctx context.Context, tenant string) (map[string]any, error) {
	e, err := s.Store.GetEventRetention(ctx, tenant)
	if err != nil {
		return nil, err
	}
	sync := "none"
	switch {
	case s.Archive == nil:
		sync = "no_archive"
	case !e.HoldInSync() && e.HoldError != "":
		sync = "error"
	case !e.HoldInSync():
		sync = "pending"
	case e.HoldSyncedAt != nil:
		sync = "done"
	}
	return map[string]any{
		"retention_days": s.tenantRetentionDays(ctx, tenant), "retention_override": e.RetentionDays, "default_days": s.retentionDays(),
		"min_days": MinRetentionDays, "archive_enabled": s.Archive != nil,
		"legal_hold": e.LegalHold, "hold_reason": e.HoldReason, "hold_set_by": e.HoldSetBy, "hold_set_at": e.HoldSetAt,
		"hold_sync": map[string]any{"state": sync, "objects": e.HoldObjects, "synced_at": e.HoldSyncedAt, "error": e.HoldError},
		"updated_by": e.UpdatedBy, "updated_at": e.UpdatedAt,
	}, nil
}

func (s *Server) getEventRetention(w http.ResponseWriter, r *http.Request, p Principal) {
	v, err := s.retentionView(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) putEventRetention(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		RetentionDays *int    `json:"retention_days"` // 0 = the control plane's default
		LegalHold     *bool   `json:"legal_hold"`
		HoldReason    *string `json:"hold_reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, `body must be {"retention_days": 0 | ≥90, "legal_hold": true | false, "hold_reason": "…"}`)
		return
	}
	ctx := r.Context()
	cur, err := s.Store.GetEventRetention(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	days, hold, reason := cur.RetentionDays, cur.LegalHold, cur.HoldReason
	if req.RetentionDays != nil {
		if d := *req.RetentionDays; d != 0 && (d < MinRetentionDays || d > 3650) {
			writeErr(w, http.StatusBadRequest, "retention_days is 0 (the default) or 90 to 3650")
			return
		}
		days = *req.RetentionDays
	}
	if req.HoldReason != nil {
		reason = clip(strings.TrimSpace(*req.HoldReason), 500)
	}
	if req.LegalHold != nil {
		hold = *req.LegalHold
		if hold && !cur.LegalHold && reason == "" {
			writeErr(w, http.StatusBadRequest, "a legal hold needs a reason (the matter or ticket)")
			return
		}
		if !hold && req.HoldReason == nil {
			reason = cur.HoldReason // keep what it was held for, for the record
		}
	}
	e, err := s.Store.PutEventRetention(ctx, p.Tenant, days, hold, reason, p.UserID)
	if err != nil {
		s.fail(w, err)
		return
	}
	if days != cur.RetentionDays {
		s.audit(r, p, "events.retention.update", "events", map[string]any{"before": cur.RetentionDays, "after": days,
			"effective_days": s.tenantRetentionDays(ctx, p.Tenant), "default_days": s.retentionDays()})
	}
	if hold != cur.LegalHold {
		act := "events.legal_hold.off"
		if hold {
			act = "events.legal_hold.on"
		}
		s.audit(r, p, act, "events", map[string]any{"reason": e.HoldReason, "archive_enabled": s.Archive != nil, "prefix": archivePrefix(p.Tenant)})
		go s.syncHolds(context.WithoutCancel(ctx)) // the S3 objects now; retention retries if this fails
	} else if hold && reason != cur.HoldReason {
		s.audit(r, p, "events.legal_hold.reason", "events", map[string]any{"before": cur.HoldReason, "after": reason})
	}
	v, err := s.retentionView(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// syncHolds brings every tenant's archive objects to its current hold
// state. One control plane instance at a time.
func (s *Server) syncHolds(ctx context.Context) {
	if s.Archive == nil {
		return
	}
	release, ok, err := s.Store.HoldLock(ctx)
	if err != nil || !ok {
		if err != nil {
			s.Logf("legal hold sync: %v", err)
		}
		return
	}
	defer release()
	due, err := s.Store.HoldSyncDue(ctx)
	if err != nil {
		s.Logf("legal hold sync: %v", err)
		return
	}
	for tenant, e := range due {
		n, err := s.Archive.SetLegalHold(ctx, archivePrefix(tenant), e.LegalHold)
		msg := ""
		if err != nil {
			msg = clip(err.Error(), 500)
			s.Logf("legal hold sync %s: %v", tenant, err)
		}
		if err := s.Store.HoldSyncDone(ctx, tenant, e.HoldGeneration, n, msg); err != nil {
			s.Logf("legal hold sync %s: %v", tenant, err)
			continue
		}
		if msg == "" {
			p := Principal{UserID: "system", Tenant: tenant, Role: "admin", Via: "system"}
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/internal/legal-hold", nil)
			s.audit(req, p, "events.legal_hold.sync", "events", map[string]any{"legal_hold": e.LegalHold, "objects": n,
				"prefix": archivePrefix(tenant), "at": time.Now().UTC()})
		}
	}
}
