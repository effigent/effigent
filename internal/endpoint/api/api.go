// Package api is effigentd's local REST API (curl-friendly):
//
//	GET  /health
//	GET  /agents             tracked agents and their loaded kernel policy
//	GET  /policy             current policy YAML
//	PUT  /policy             replace the policy (YAML body); re-applied to live agents.
//	                         Requires EFFIGENT_API_TOKEN; without a token the API is read-only.
//	GET  /learned            binaries each agent has run (seed for exec_allow)
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"

	"github.com/effigent/effigent/internal/endpoint/engine"
)

type Server struct {
	Engine *engine.Engine
	Token  string // required as "Authorization: Bearer <token>" when set; without it the API is read-only
	Stats  func() map[string]any
	// Managed is set when the endpoint is enrolled: policy then comes only
	// from the control plane, and local PUT /policy is refused.
	Managed bool
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{"ok": true, "agents": len(s.Engine.Agents())}
		if s.Stats != nil {
			for k, v := range s.Stats() {
				out[k] = v
			}
		}
		writeJSON(w, http.StatusOK, out)
	})
	mux.HandleFunc("GET /agents", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.Engine.Agents())
	})
	mux.HandleFunc("GET /learned", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.Engine.Learned())
	})
	mux.HandleFunc("GET /policy", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/yaml")
		_, _ = w.Write(s.Engine.PolicyRaw())
	})
	mux.HandleFunc("PUT /policy", func(w http.ResponseWriter, r *http.Request) {
		if s.Managed {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "this endpoint is enrolled; change the policy in the control plane"})
			return
		}
		if s.Token == "" {
			// The governed agents run on this host and can reach localhost, so an
			// unauthenticated write API would let an agent lift its own policy.
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "policy updates are disabled: start effigentd with EFFIGENT_API_TOKEN set"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		n, err := s.Engine.SetPolicy(context.WithoutCancel(r.Context()), body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "reapplied_to_agents": n})
	})
	return s.auth(mux)
}

func (s *Server) auth(next http.Handler) http.Handler {
	if s.Token == "" {
		return next
	}
	want := []byte("Bearer " + s.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}
