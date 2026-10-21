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
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/peer"
)

type Server struct {
	Engine *engine.Engine
	Token  string // required as "Authorization: Bearer <token>" when set; without it the API is read-only
	Stats  func() map[string]any
	// Hook answers an agent's pre-tool hook (POST /hook/{agent}); nil disables it.
	Hook func(ctx context.Context, c HookCall) ([]byte, error)
	// BreakGlass applies an admin-issued offline break-glass code (POST
	// /break-glass); nil disables it (not enrolled / hooks disabled).
	BreakGlass func(ctx context.Context, code, osUser string) ([]byte, error)
	// Managed is set when the endpoint is enrolled: policy then comes only
	// from the control plane, and local PUT /policy is refused.
	Managed bool
}

// HookCall is one pre-tool hook request.
type HookCall struct {
	Agent   string
	Payload []byte
	Budget  time.Duration // how long the hook process waits for the answer
	OSUser  string        // the user the agent runs as (reported by the hook process)
	// Env is the agent's identity-related environment (hooks.AgentEnv),
	// reported by the hook process in X-Effigent-Agent-Env.
	Env map[string]string
	// Result: a post-tool hook (POST /hook/{agent}/result) reporting how a
	// call ended; the answer is ignored by the hook process.
	Result bool
	// Peer is the hook process as the kernel tells it (the hook socket, on
	// Linux): it wins over OSUser. nil on the TCP API.
	Peer *peer.Info
}

// hook answers POST /hook/{agent}, or with result POST /hook/{agent}/result.
func (s *Server) hook(result bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { s.hookCall(w, r, result) }
}

func (s *Server) hookCall(w http.ResponseWriter, r *http.Request, result bool) {
	if s.Hook == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "hooks are not enabled on this endpoint"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// The hook process says how long it will wait for an answer; older
	// ones don't, and give up after 10s.
	budget := 8 * time.Second
	if v, err := strconv.Atoi(r.Header.Get("X-Effigent-Hook-Budget")); err == nil && v > 0 {
		budget = min(time.Duration(v)*time.Second, 5*time.Minute)
	}
	call := HookCall{Agent: r.PathValue("agent"), Payload: body, Budget: budget, Result: result,
		OSUser: r.Header.Get("X-Effigent-OS-User"), Env: agentEnv(r.Header.Get("X-Effigent-Agent-Env"))}
	if p, ok := r.Context().Value(peerKey{}).(*peer.Info); ok {
		call.Peer = p
	}
	out, err := s.Hook(r.Context(), call)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /hook/{agent}/result", s.hook(true))
	mux.HandleFunc("POST /hook/{agent}", s.hook(false))
	mux.HandleFunc("POST /break-glass", func(w http.ResponseWriter, r *http.Request) {
		if s.BreakGlass == nil {
			writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "message": "break-glass needs an enrolled endpoint"})
			return
		}
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil || req.Code == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "body must be {\"code\":\"...\"}"})
			return
		}
		out, err := s.BreakGlass(r.Context(), req.Code, r.Header.Get("X-Effigent-OS-User"))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	})
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

// agentEnv decodes X-Effigent-Agent-Env: base64 (std) JSON of name -> value.
func agentEnv(h string) map[string]string {
	if h == "" || len(h) > 16<<10 {
		return nil
	}
	b, err := base64.StdEncoding.DecodeString(h)
	if err != nil {
		return nil
	}
	var m map[string]string
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}
