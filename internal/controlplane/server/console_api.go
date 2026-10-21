package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

func (s *Server) me(w http.ResponseWriter, r *http.Request, p Principal) {
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) createEnrollmentToken(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Label    string `json:"label"`
		TTLHours int    `json:"ttl_hours"`
		MaxUses  int    `json:"max_uses"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req)
	if req.TTLHours <= 0 || req.TTLHours > 24*30 {
		req.TTLHours = 24
	}
	if req.MaxUses <= 0 || req.MaxUses > 1000 {
		req.MaxUses = 1
	}
	t, err := s.Store.CreateEnrollmentToken(r.Context(), p.Tenant, req.Label, p.UserID, time.Duration(req.TTLHours)*time.Hour, req.MaxUses)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "enrollment_token.create", t.ID, map[string]any{"label": t.Label, "max_uses": t.MaxUses, "expires_at": t.ExpiresAt})
	writeJSON(w, http.StatusCreated, map[string]any{
		"token":   t,
		"command": fmt.Sprintf("sudo effigentd enroll --server %s --token %s", s.PublicBaseURL, t.Token),
	})
}

func (s *Server) listEndpoints(w http.ResponseWriter, r *http.Request, p Principal) {
	eps, err := s.Store.ListEndpoints(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, eps)
}

func (s *Server) revokeEndpoint(w http.ResponseWriter, r *http.Request, p Principal) {
	err := s.Store.RevokeEndpoint(r.Context(), p.Tenant, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such endpoint")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "endpoint.revoke", r.PathValue("id"), nil)
	s.emit(r.Context(), p.Tenant, "endpoint.revoked", map[string]any{"endpoint_id": r.PathValue("id"), "by": p.UserID})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) getPolicy(w http.ResponseWriter, r *http.Request, p Principal) {
	pv, err := s.Store.LatestPolicy(r.Context(), p.Tenant)
	if errors.Is(err, store.ErrNotFound) {
		// Nothing published yet: show the built-in default as a starting point.
		writeJSON(w, http.StatusOK, store.PolicyVersion{Version: 0, Body: string(policy.DefaultYAML), Comment: "built-in default (not published)"})
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pv)
}

// getPolicyVersion returns one published version (to compare versions).
func (s *Server) getPolicyVersion(w http.ResponseWriter, r *http.Request, p Principal) {
	v, err := strconv.Atoi(r.PathValue("version"))
	if err != nil || v < 1 {
		writeErr(w, http.StatusBadRequest, "version must be a number")
		return
	}
	pv, err := s.Store.PolicyAt(r.Context(), p.Tenant, v)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such version")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pv)
}

// putPolicy validates with the same parser endpoints use, then publishes a
// new version. Endpoints pick it up on their next poll.
//
// With central policies ({"body": base yaml, "policies": [...]}) the body is
// the base every machine starts from, and the policies are compiled onto it
// per machine; the response reports what each machine gets and every clause
// the kernel doesn't enforce. Omitting "policies" keeps the ones already
// published (so editing the base YAML doesn't drop them); "policies": [] or
// null removes them.
func (s *Server) putPolicy(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Body     string          `json:"body"`
		Comment  string          `json:"comment"`
		Policies json.RawMessage `json:"policies"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "body must be {\"body\": \"<policy yaml>\", \"comment\": \"…\", \"policies\": [optional central policies]}")
		return
	}
	// Omitted policies keep the published ones; exceptions are always kept
	// (they are managed under /api/v1/exceptions).
	c := policyChange{Body: req.Body, Comment: clip(req.Comment, 1000), Policies: req.Policies}
	on, err := s.changeApproval(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	if on {
		// checked now with the same parser and compiler, so a proposal can be applied as is
		rep, err := s.checkPolicy(r.Context(), p.Tenant, c)
		var bad badRequest
		if errors.As(err, &bad) {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		} else if err != nil {
			s.fail(w, err)
			return
		}
		summary := "Publish the policy"
		if c.Comment != "" {
			summary += ": " + c.Comment
		}
		s.propose(w, r, p, "policy", summary, c, map[string]any{"report": rep})
		return
	}
	code, resp, err := s.applyPolicy(r, p, c, "")
	s.writeApplied(w, code, resp, err)
}

func (s *Server) policyHistory(w http.ResponseWriter, r *http.Request, p Principal) {
	h, err := s.Store.PolicyHistory(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h)
}
