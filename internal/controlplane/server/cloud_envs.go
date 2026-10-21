package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/effigent/effigent/internal/shared/cloudtoken"
	"github.com/effigent/effigent/internal/shared/sign"
)

// CloudVendors are the vendor-hosted agents whose repository hooks run
// `effigentd hook <agent> --remote` (docs/cloud-agents.md), and the hook
// agent each one uses.
var CloudVendors = map[string]string{
	"claude-code-web": "claude",  // Claude Code on the web (claude.ai/code)
	"copilot":         "copilot", // GitHub Copilot cloud agent
	"cursor":          "cursor",  // Cursor cloud agents
	"other":           "claude",  // anything else that runs Claude Code-style hooks
}

// createCloudEnvironment registers a cloud environment (POST
// /api/v1/cloud-environments {name, vendor}) and returns its token once:
// the vendor's secret store keeps it, and every session's hook uses it.
func (s *Server) createCloudEnvironment(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Name   string `json:"name"`
		Vendor string `json:"vendor"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "body must be {\"name\": …, \"vendor\": …}")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeErr(w, http.StatusBadRequest, "name is required (at most 100 characters), e.g. the repository")
		return
	}
	hook, ok := CloudVendors[req.Vendor]
	if !ok {
		writeErr(w, http.StatusBadRequest, "vendor must be one of claude-code-web, copilot, cursor, other")
		return
	}
	ep, secret, err := s.Store.CreateCloudEnvironment(r.Context(), p.Tenant, req.Name, req.Vendor)
	if err != nil {
		s.fail(w, err)
		return
	}
	server := strings.TrimSuffix(s.PublicBaseURL, "/")
	tok := cloudtoken.Encode(cloudtoken.Token{Server: server, EndpointID: ep.ID, Tenant: p.Tenant, Secret: secret,
		ServerPublicKey: sign.EncodePublic(s.publicKey())})
	s.audit(r, p, "cloud_environment.create", ep.ID, map[string]string{"name": req.Name, "vendor": req.Vendor})
	s.emit(r.Context(), p.Tenant, "endpoint.enrolled", map[string]any{"endpoint_id": ep.ID, "hostname": req.Name,
		"os": "cloud", "kind": "cloud", "vendor": req.Vendor})
	writeJSON(w, http.StatusCreated, map[string]any{"endpoint": ep, "token": tok, "server": server, "hook_agent": hook})
}
