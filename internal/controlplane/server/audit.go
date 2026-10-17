package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
)

// audit appends to the tenant's tamper-evident trail. Failures are logged,
// never shown to the caller.
func (s *Server) audit(r *http.Request, p Principal, action, target string, details any) {
	if s.Store == nil { // tests without a database
		return
	}
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

// listAudit returns the newest entries (?limit, ?action prefix, ?actor). With
// ?paged=1 it returns one page {entries, total, next_before} and also takes
// ?before (seq cursor), comma-separated ?action prefixes and ?via actor
// kinds, ?q (words), ?since and ?until (RFC 3339).
func (s *Server) listAudit(w http.ResponseWriter, r *http.Request, p Principal) {
	qs := r.URL.Query()
	limit, _ := strconv.Atoi(qs.Get("limit"))
	if qs.Get("paged") != "1" {
		if limit <= 0 || limit > 1000 {
			limit = 200
		}
		entries, err := s.Store.ListAudit(r.Context(), p.Tenant, limit, qs.Get("action"), qs.Get("actor"))
		if err != nil {
			s.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, entries)
		return
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	q := store.AuditQuery{Limit: limit, Actions: splitList(qs.Get("action")), Vias: splitList(qs.Get("via")),
		Actor: qs.Get("actor"), Q: clip(qs.Get("q"), 200)}
	q.Before, _ = strconv.ParseInt(qs.Get("before"), 10, 64)
	for name, t := range map[string]*time.Time{"since": &q.Since, "until": &q.Until} {
		if v := qs.Get(name); v != "" {
			var err error
			if *t, err = time.Parse(time.RFC3339, v); err != nil {
				writeErr(w, http.StatusBadRequest, name+" must be an RFC 3339 time")
				return
			}
		}
	}
	entries, total, next, err := s.Store.QueryAudit(r.Context(), p.Tenant, q)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "total": total, "next_before": next})
}

func splitList(v string) []string {
	out := []string{}
	for _, x := range strings.Split(v, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

func (s *Server) verifyAudit(w http.ResponseWriter, r *http.Request, p Principal) {
	v, err := s.Store.VerifyAudit(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}
