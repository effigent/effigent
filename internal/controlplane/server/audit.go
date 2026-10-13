package server

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/effigent/effigent/internal/controlplane/store"
)

// audit appends to the tenant's tamper-evident trail. Failures are logged,
// never shown to the caller.
func (s *Server) audit(r *http.Request, p Principal, action, target string, details any) {
	var raw json.RawMessage
	if details != nil {
		raw, _ = json.Marshal(details)
	}
	err := s.Store.AppendAudit(r.Context(), p.Tenant, store.AuditEntry{
		Actor: p.UserID, ActorVia: p.Via, ActorRole: p.Role, Action: action, Target: target,
		Details: raw, IP: clientIP(r),
	})
	if err != nil {
		s.Logf("audit %s %s: %v", p.Tenant, action, err)
	}
}

func (s *Server) listAudit(w http.ResponseWriter, r *http.Request, p Principal) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	entries, err := s.Store.ListAudit(r.Context(), p.Tenant, limit, r.URL.Query().Get("action"), r.URL.Query().Get("actor"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) verifyAudit(w http.ResponseWriter, r *http.Request, p Principal) {
	v, err := s.Store.VerifyAudit(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}
