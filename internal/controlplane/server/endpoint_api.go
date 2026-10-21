package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/effigent/effigent/internal/shared/sign"
	"github.com/google/uuid"
)

// Endpoint protocol, under /ep/v1. Every route but enroll needs
// "Authorization: Bearer <endpoint secret>".

type enrollRequest struct {
	Token string             `json:"token"`
	Info  store.EndpointInfo `json:"info"`
}

type EnrollResponse struct {
	EndpointID      string `json:"endpoint_id"`
	Secret          string `json:"secret"`
	Tenant          string `json:"tenant"`
	ServerPublicKey string `json:"server_public_key"`
}

func (s *Server) enroll(w http.ResponseWriter, r *http.Request) {
	var req enrollRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil || req.Token == "" {
		writeErr(w, http.StatusBadRequest, "token is required")
		return
	}
	id, secret, tenant, err := s.Store.Enroll(r.Context(), req.Token, req.Info)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusUnauthorized, "enrollment token is invalid, expired or used up")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Logf("enrolled endpoint %s (%s) for %s", id, req.Info.Hostname, tenant)
	s.emit(r.Context(), tenant, "endpoint.enrolled", map[string]any{"endpoint_id": id, "hostname": req.Info.Hostname,
		"os": req.Info.OS, "arch": req.Info.Arch, "version": req.Info.Version})
	s.audit(r, Principal{UserID: "endpoint:" + id, Tenant: tenant, Via: "enrollment-token"}, "endpoint.enroll", id,
		map[string]string{"hostname": req.Info.Hostname, "os": req.Info.OS, "arch": req.Info.Arch, "version": req.Info.Version})
	writeJSON(w, http.StatusOK, EnrollResponse{EndpointID: id, Secret: secret, Tenant: tenant,
		ServerPublicKey: sign.EncodePublic(s.publicKey())})
}

func (s *Server) endpointAuth(next func(http.ResponseWriter, *http.Request, store.Endpoint)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			writeErr(w, http.StatusUnauthorized, "missing endpoint credentials")
			return
		}
		ep, err := s.Store.AuthEndpoint(r.Context(), secret)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unknown or revoked endpoint")
			return
		}
		if ok, wait := s.limits.endpoint.allow("ep:" + ep.ID); !ok {
			tooMany(w, wait)
			return
		}
		next(w, r, ep)
	}
}

// endpointPolicy returns the latest signed policy, or 204 when the endpoint
// already has it (?have=<version>).
func (s *Server) endpointPolicy(w http.ResponseWriter, r *http.Request, ep store.Endpoint) {
	have, _ := strconv.ParseInt(r.URL.Query().Get("have"), 10, 64)
	p, err := s.Store.LatestPolicy(r.Context(), ep.Tenant)
	if errors.Is(err, store.ErrNotFound) || (err == nil && p.Version <= have) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	body, out, err := compiledBody(p, ep)
	if err != nil {
		// Publish compiled for every machine; this one changed since (or
		// enrolled later). It keeps its current policy until fixed.
		s.Logf("policy v%d does not compile for endpoint %s: %v", p.Version, ep.ID, err)
		writeErr(w, http.StatusUnprocessableEntity, "policy does not compile for this endpoint")
		return
	}
	d := sign.Document{Tenant: ep.Tenant, Version: p.Version, IssuedAt: time.Now().UTC(), Body: body}
	if out != nil {
		d.Endpoint = ep.ID // compiled for this machine only
	}
	writeJSON(w, http.StatusOK, sign.Sign(s.Key, d))
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request, ep store.Endpoint) {
	var req struct {
		PolicyVersion int64  `json:"policy_version"`
		Version       string `json:"version"`
		// effigentd's hook state, sent when it changed (older builds never send it)
		Hooks json.RawMessage `json:"hooks"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req)
	if err := s.Store.Heartbeat(r.Context(), ep.ID, req.PolicyVersion, clip(req.Version, 64)); err != nil {
		s.fail(w, err)
		return
	}
	if len(req.Hooks) > 0 {
		if err := s.reportHooks(r.Context(), ep, req.Hooks); err != nil {
			s.fail(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ingest accepts the endpoint's event batches ({"events":[...]}, the same shape
// effigentd's HTTP sink posts).
func (s *Server) ingest(w http.ResponseWriter, r *http.Request, ep store.Endpoint) {
	var req struct {
		BatchID string            `json:"batch_id"` // effigentd ≥ v0.5.4: retries and replays are stored once
		Events  []json.RawMessage `json:"events"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "body must be {\"events\":[...]}")
		return
	}
	evs := make([]store.Event, 0, len(req.Events))
	for _, raw := range req.Events {
		var head struct {
			Time     time.Time `json:"time"`
			Type     string    `json:"type"`
			Severity string    `json:"severity"`
			Agent    string    `json:"agent"`
		}
		if json.Unmarshal(raw, &head) != nil || head.Type == "" {
			continue
		}
		if head.Time.IsZero() {
			head.Time = time.Now()
		}
		evs = append(evs, store.Event{Time: head.Time, Type: head.Type, Severity: head.Severity, Agent: head.Agent, Body: raw})
	}
	batchID := strings.TrimSpace(req.BatchID)
	if batchID == "" || len(batchID) > 64 {
		batchID = "cp-" + uuid.NewString()
	}
	if len(evs) > 0 {
		n, dup, err := s.Store.IngestBatch(r.Context(), ep.Tenant, ep.ID, batchID, evs)
		if err != nil {
			s.fail(w, err)
			return
		}
		if dup {
			writeJSON(w, http.StatusOK, map[string]any{"accepted": n, "duplicate": true})
			return
		}
		for _, e := range evs {
			if e.Type == "blocked" || e.Type == "approval_denied" {
				s.emit(r.Context(), ep.Tenant, "action.blocked", map[string]any{"endpoint_id": ep.ID, "hostname": ep.Hostname,
					"event": json.RawMessage(e.Body)})
			}
			if e.Type == "daemon_stop" {
				// the offline detector tells "stopped" from "went silent" by it
				var body struct {
					Target string `json:"target"` // the signal
					Rule   string `json:"rule"`   // how it was run: systemd, launchd, windows-service, terminal
					OSUser string `json:"os_user"`
				}
				_ = json.Unmarshal(e.Body, &body)
				b, _ := json.Marshal(stopInfo{Signal: clip(body.Target, 40), Via: clip(body.Rule, 40), OSUser: clip(body.OSUser, 120)})
				if err := s.Store.RecordEndpointStop(r.Context(), ep.ID, e.Time, b); err != nil {
					s.Logf("endpoint %s: record stop: %v", ep.ID, err)
				}
			}
		}
	}
	_ = s.Store.Heartbeat(r.Context(), ep.ID, ep.PolicyVersion, "")
	writeJSON(w, http.StatusOK, map[string]any{"accepted": len(evs)})
}
