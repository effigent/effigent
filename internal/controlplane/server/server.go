// Package server is the control plane's HTTP API: the endpoint protocol
// (/ep/v1) and the console API (/api/v1).
package server

import (
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

type Server struct {
	Store         *store.Store
	Key           ed25519.PrivateKey
	Auth          *Authenticator
	PublicBaseURL string         // used in install commands, e.g. https://api.effigent.ai
	ConsoleOrigin string         // CORS origin allowed for the console, e.g. https://app.effigent.ai
	Notify        *notify.Sender // announces approval requests (Slack always; email when SMTP is set)
	Logf          func(string, ...any)

	limits *limits
}

func (s *Server) publicKey() ed25519.PublicKey { return s.Key.Public().(ed25519.PublicKey) }

func (s *Server) Handler() http.Handler {
	if s.limits == nil {
		s.limits = newLimits()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	// endpoint protocol
	mux.HandleFunc("POST /ep/v1/enroll", s.enroll)
	mux.HandleFunc("GET /ep/v1/policy", s.endpointAuth(s.endpointPolicy))
	mux.HandleFunc("POST /ep/v1/heartbeat", s.endpointAuth(s.heartbeat))
	mux.HandleFunc("POST /ep/v1/events", s.endpointAuth(s.ingest))
	mux.HandleFunc("POST /ep/v1/approvals", s.endpointAuth(s.requestApproval))

	// console API
	mux.HandleFunc("GET /api/v1/me", s.console(read, s.me))
	mux.HandleFunc("POST /api/v1/enrollment-tokens", s.console(write, s.createEnrollmentToken))
	mux.HandleFunc("GET /api/v1/endpoints", s.console(read, s.listEndpoints))
	mux.HandleFunc("DELETE /api/v1/endpoints/{id}", s.console(write, s.revokeEndpoint))
	mux.HandleFunc("PATCH /api/v1/endpoints/{id}", s.console(write, s.setEndpointOwner))
	mux.HandleFunc("GET /api/v1/endpoints/{id}/policy", s.console(read, s.endpointCompiledPolicy))
	mux.HandleFunc("GET /api/v1/policy", s.console(read, s.getPolicy))
	mux.HandleFunc("PUT /api/v1/policy", s.console(write, s.putPolicy))
	mux.HandleFunc("GET /api/v1/policy/history", s.console(read, s.policyHistory))
	mux.HandleFunc("GET /api/v1/events", s.console(read, s.listEvents))
	mux.HandleFunc("GET /api/v1/audit", s.console(read, s.listAudit))
	mux.HandleFunc("GET /api/v1/audit/verify", s.console(read, s.verifyAudit))
	mux.HandleFunc("GET /api/v1/approvals", s.console(read, s.listApprovals))
	mux.HandleFunc("POST /api/v1/approvals/{id}/decision", s.console(write, s.decideApproval))
	mux.HandleFunc("GET /api/v1/notifications", s.console(read, s.getNotifications))
	mux.HandleFunc("PUT /api/v1/notifications", s.console(write, s.putNotifications))
	mux.HandleFunc("POST /api/v1/notifications/test", s.console(write, s.testNotifications))
	return s.rateLimitIP(s.cors(mux))
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.ConsoleOrigin != "" && r.Header.Get("Origin") == s.ConsoleOrigin && strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", s.ConsoleOrigin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Effigent-Tenant")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	s.Logf("internal error: %v", err)
	writeErr(w, http.StatusInternalServerError, "internal error")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
