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

// source is what a policy version compiles from besides its base body:
// central policies and per-machine exceptions. Stored as
// {"policies": [...], "exceptions": [...]}; versions from before exceptions
// stored the policies array alone.
type source struct {
	Policies   []policy.Policy     `json:"policies"`
	Exceptions []compile.Exception `json:"exceptions,omitempty"`
}

func (src source) empty() bool { return len(src.Policies) == 0 && len(src.Exceptions) == 0 }

func decodeSource(raw json.RawMessage) (source, error) {
	var src source
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return src, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if raw[0] == '[' {
		if err := dec.Decode(&src.Policies); err != nil {
			return src, fmt.Errorf("policies: %w", err)
		}
		return src, nil
	}
	if err := dec.Decode(&src); err != nil {
		return src, fmt.Errorf("source: %w", err)
	}
	return src, nil
}

func decodePolicies(raw json.RawMessage) ([]policy.Policy, error) {
	src, err := decodeSource(raw)
	return src.Policies, err
}

func encodeSource(src source) json.RawMessage {
	if src.empty() {
		return nil
	}
	if src.Policies == nil {
		src.Policies = []policy.Policy{}
	}
	b, _ := json.Marshal(src)
	return b
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
	src, err := decodeSource(pv.Source)
	if err != nil {
		return "", nil, err
	}
	out, err := compile.CompileWith([]byte(pv.Body), src.Policies, src.Exceptions, machineOf(e), pv.CreatedAt)
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
func compileAll(base []byte, src source, eps []store.Endpoint, at time.Time) (*publishReport, error) {
	ps := src.Policies
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
		out, err := compile.CompileWith(base, ps, src.Exceptions, machineOf(e), at)
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
func (s *Server) publishCentral(r *http.Request, p Principal, base string, src source, comment string) (int64, *publishReport, int, error) {
	ps := src.Policies
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
	for _, x := range src.Exceptions {
		if err := x.Validate(); err != nil {
			return 0, nil, http.StatusBadRequest, fmt.Errorf("exception %s: %w", x.ID, err)
		}
	}
	rep, err := compileAll([]byte(base), src, eps, at)
	if err != nil {
		return 0, nil, http.StatusBadRequest, err
	}
	v, err := s.Store.PutPolicy(r.Context(), p.Tenant, base, encodeSource(src), comment, p.UserID, at)
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
	e, err := s.Store.GetEndpoint(r.Context(), p.Tenant, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such endpoint")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	// A machine's owner and teams pick its central policies, so with change
	// approval on this waits for a second admin like a policy edit (the
	// owner is not saved until then).
	c := policyChange{EndpointID: e.ID, Hostname: e.Hostname, Owner: strings.TrimSpace(req.Owner), Teams: teams}
	if s.proposeIfRequired(w, r, p, "endpoint.owner", fmt.Sprintf("Set %s's owner to %q, teams %v", e.Hostname, c.Owner, teams), c,
		map[string]any{"endpoint": e}) {
		return
	}
	code, resp, err := s.applyEndpointOwner(r, p, c, "")
	s.writeApplied(w, code, resp, err)
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
