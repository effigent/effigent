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

// putPolicy validates with the same parser endpoints use, then publishes a
// new version. Endpoints pick it up on their next poll.
func (s *Server) putPolicy(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Body    string `json:"body"`
		Comment string `json:"comment"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "body must be {\"body\": \"<policy yaml>\", \"comment\": \"…\"}")
		return
	}
	if _, err := policy.Parse([]byte(req.Body)); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	v, err := s.Store.PutPolicy(r.Context(), p.Tenant, req.Body, req.Comment, p.UserID)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Logf("policy v%d published for %s by %s", v, p.Tenant, p.UserID)
	writeJSON(w, http.StatusOK, map[string]any{"version": v})
}

func (s *Server) policyHistory(w http.ResponseWriter, r *http.Request, p Principal) {
	h, err := s.Store.PolicyHistory(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h)
}

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request, p Principal) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	evs, err := s.Store.ListEvents(r.Context(), p.Tenant, limit, r.URL.Query().Get("type"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, evs)
}
