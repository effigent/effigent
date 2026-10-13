package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/compile"
	"github.com/effigent/effigent/internal/controlplane/store"
	ep "github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/shared/policy"
)

// Central policies (internal/shared/policy) are stored next to the base
// endpoint policy and compiled for each machine when it fetches its policy.
// Compilation is deterministic and uses the version's publish time, so every
// fetch of a version gives a machine the same body.

func machineOf(e store.Endpoint) compile.Machine {
	return compile.Machine{EndpointID: e.ID, Hostname: e.Hostname, Owner: e.Owner, Teams: e.Teams}
}

func decodePolicies(raw json.RawMessage) ([]policy.Policy, error) {
	var ps []policy.Policy
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&ps); err != nil {
		return nil, fmt.Errorf("policies: %w", err)
	}
	return ps, nil
}

func validatePolicies(ps []policy.Policy) error {
	seen := map[string]bool{}
	var errs []string
	for i, p := range ps {
		where := p.ID
		if where == "" {
			where = fmt.Sprintf("policies[%d]", i)
			errs = append(errs, where+": id is required")
		} else if seen[p.ID] {
			errs = append(errs, where+": duplicate policy id")
		}
		seen[p.ID] = true
		for _, e := range policy.Validate(p) {
			errs = append(errs, where+": "+e)
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// compiledBody is what one endpoint enforces for a version.
func compiledBody(pv store.PolicyVersion, e store.Endpoint) (string, *compile.Output, error) {
	if pv.Source == nil {
		return pv.Body, nil, nil
	}
	ps, err := decodePolicies(pv.Source)
	if err != nil {
		return "", nil, err
	}
	out, err := compile.Compile([]byte(pv.Body), ps, machineOf(e), pv.CreatedAt)
	if err != nil {
		return "", nil, err
	}
	return string(out.YAML), out, nil
}

type machineReport struct {
	EndpointID string                    `json:"endpoint_id"`
	Hostname   string                    `json:"hostname"`
	Owner      string                    `json:"owner"`
	Teams      []string                  `json:"teams"`
	Added      map[string]compile.Kernel `json:"added"`
	Findings   []compile.Finding         `json:"findings"`
}

type publishReport struct {
	// Unsupported lists every clause the kernel doesn't enforce as written,
	// across all machines (machine-specific ones carry endpoint_id).
	Unsupported []unsupported   `json:"unsupported"`
	Endpoints   []machineReport `json:"endpoints"`
}

type unsupported struct {
	compile.Finding
	EndpointID string `json:"endpoint_id,omitempty"`
}

// compileAll compiles a version for every live endpoint of the tenant. Any
// compile error fails the publish: an endpoint would refuse the result.
func compileAll(base []byte, ps []policy.Policy, eps []store.Endpoint, at time.Time) (*publishReport, error) {
	bp, err := ep.Parse(base)
	if err != nil {
		return nil, err
	}
	static := compile.Static(bp, ps, at)
	rep := &publishReport{Unsupported: []unsupported{}, Endpoints: []machineReport{}}
	for _, f := range static {
		rep.Unsupported = append(rep.Unsupported, unsupported{Finding: f})
	}
	for _, e := range eps {
		if e.Revoked {
			continue
		}
		out, err := compile.Compile(base, ps, machineOf(e), at)
		if err != nil {
			return nil, fmt.Errorf("compiling for %s (%s): %w", e.Hostname, e.ID, err)
		}
		mr := machineReport{EndpointID: e.ID, Hostname: e.Hostname, Owner: e.Owner, Teams: e.Teams,
			Added: out.Added, Findings: []compile.Finding{}}
		for _, f := range out.Findings {
			if slices.Contains(static, f) {
				continue // already reported once for the whole tenant
			}
			mr.Findings = append(mr.Findings, f)
			rep.Unsupported = append(rep.Unsupported, unsupported{Finding: f, EndpointID: e.ID})
		}
		rep.Endpoints = append(rep.Endpoints, mr)
	}
	slices.SortFunc(rep.Endpoints, func(a, b machineReport) int { return strings.Compare(a.EndpointID, b.EndpointID) })
	return rep, nil
}

// publishCentral validates and compiles a base + central policies for every
// machine, stores the version, and returns it with the compile report.
func (s *Server) publishCentral(r *http.Request, p Principal, base string, ps []policy.Policy, comment string) (int64, *publishReport, int, error) {
	if base == "" {
		base = string(ep.DefaultYAML)
	}
	if _, err := ep.Parse([]byte(base)); err != nil {
		return 0, nil, http.StatusBadRequest, err
	}
	if err := validatePolicies(ps); err != nil {
		return 0, nil, http.StatusBadRequest, err
	}
	eps, err := s.Store.ListEndpoints(r.Context(), p.Tenant)
	if err != nil {
		return 0, nil, http.StatusInternalServerError, err
	}
	at := time.Now().UTC().Truncate(time.Microsecond) // what Postgres stores
	rep, err := compileAll([]byte(base), ps, eps, at)
	if err != nil {
		return 0, nil, http.StatusBadRequest, err
	}
	src, _ := json.Marshal(ps)
	v, err := s.Store.PutPolicy(r.Context(), p.Tenant, base, src, comment, p.UserID, at)
	if err != nil {
		return 0, nil, http.StatusInternalServerError, err
	}
	return v, rep, http.StatusOK, nil
}

// setEndpointOwner records who uses a machine (PATCH /api/v1/endpoints/{id},
// {"owner": "dana@acme.io", "teams": ["payments"]}). When central policies are
// published, the latest version is republished so every machine refetches
// (endpoints only accept a higher version) and this one gets its new rules.
func (s *Server) setEndpointOwner(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Owner string   `json:"owner"`
		Teams []string `json:"teams"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, `body must be {"owner": "<user id or email>", "teams": ["…"]}`)
		return
	}
	teams := []string{}
	for _, t := range req.Teams {
		if t = strings.TrimSpace(t); t != "" && !slices.Contains(teams, t) {
			teams = append(teams, t)
		}
	}
	slices.Sort(teams)
	e, err := s.Store.SetEndpointOwner(r.Context(), p.Tenant, r.PathValue("id"), strings.TrimSpace(req.Owner), teams)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such endpoint")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "endpoint.owner", e.ID, map[string]any{"hostname": e.Hostname, "owner": e.Owner, "teams": e.Teams})
	resp := map[string]any{"endpoint": e}
	pv, err := s.Store.LatestPolicy(r.Context(), p.Tenant)
	if err == nil && pv.Source != nil {
		ps, err := decodePolicies(pv.Source)
		if err != nil {
			s.fail(w, err)
			return
		}
		comment := fmt.Sprintf("recompiled: %s owner %q teams %v", e.Hostname, e.Owner, e.Teams)
		v, rep, code, err := s.publishCentral(r, p, pv.Body, ps, comment)
		if err != nil {
			if code == http.StatusInternalServerError {
				s.fail(w, err)
				return
			}
			// The owner is saved; the policy can't be compiled for it.
			resp["policy_error"] = err.Error()
		} else {
			s.audit(r, p, "policy.publish", fmt.Sprintf("v%d", v), map[string]any{"version": v, "comment": comment})
			resp["version"], resp["report"] = v, rep
		}
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// endpointCompiledPolicy previews what one machine enforces for the latest
// version (GET /api/v1/endpoints/{id}/policy).
func (s *Server) endpointCompiledPolicy(w http.ResponseWriter, r *http.Request, p Principal) {
	e, err := s.Store.GetEndpoint(r.Context(), p.Tenant, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such endpoint")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	pv, err := s.Store.LatestPolicy(r.Context(), p.Tenant)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no policy published")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	body, out, err := compiledBody(pv, e)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	resp := map[string]any{"version": pv.Version, "endpoint_id": e.ID, "compiled": out != nil, "body": body}
	if out != nil {
		resp["added"], resp["findings"] = out.Added, out.Findings
	}
	writeJSON(w, http.StatusOK, resp)
}
