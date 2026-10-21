package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
)

// Exceptions lift one company-wide entry for some machines ("Dana's laptop
// may run curl"). They live in the policy version's source next to the
// central policies, so creating or removing one publishes a new version and
// every fetch of a version stays deterministic.

type exceptionView struct {
	compile.Exception
	Active   bool     `json:"active"`
	Machines []string `json:"machines"` // hostnames it covers right now
}

func (s *Server) latestSource(ctx context.Context, tenant string) (store.PolicyVersion, source, error) {
	pv, err := s.Store.LatestPolicy(ctx, tenant)
	if err != nil {
		return pv, source{}, err
	}
	src, err := decodeSource(pv.Source)
	return pv, src, err
}

func (s *Server) listExceptions(w http.ResponseWriter, r *http.Request, p Principal) {
	_, src, err := s.latestSource(r.Context(), p.Tenant)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, err)
		return
	}
	eps, err := s.Store.ListEndpoints(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	now := time.Now()
	out := []exceptionView{}
	for _, x := range src.Exceptions {
		v := exceptionView{Exception: x, Active: x.Live(now), Machines: []string{}}
		for _, e := range eps {
			if !e.Revoked && x.Applies(machineOf(e)) {
				v.Machines = append(v.Machines, e.Hostname)
			}
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, out)
}

// exceptionOptions lists what the published policy blocks or asks approval
// for, so the console can offer "allow this" choices.
func (s *Server) exceptionOptions(w http.ResponseWriter, r *http.Request, p Principal) {
	pv, _, err := s.latestSource(r.Context(), p.Tenant)
	body := string(ep.DefaultYAML)
	if err == nil {
		body = pv.Body
	} else if !errors.Is(err, store.ErrNotFound) {
		s.fail(w, err)
		return
	}
	pol, err := ep.Parse([]byte(body))
	if err != nil {
		s.fail(w, err)
		return
	}
	type option struct {
		List   string   `json:"list"`
		Value  string   `json:"value"`
		Agents []string `json:"agents"` // "" = defaults
	}
	idx := map[string]*option{}
	var out []*option
	add := func(agent string, r ep.Rule) {
		for _, list := range compile.ExceptionLists {
			if list == "exec_allow" {
				continue
			}
			for _, v := range *ruleList(&r, list) {
				k := list + "\x00" + v
				if idx[k] == nil {
					idx[k] = &option{List: list, Value: v, Agents: []string{}}
					out = append(out, idx[k])
				}
				if !slices.Contains(idx[k].Agents, agent) {
					idx[k].Agents = append(idx[k].Agents, agent)
				}
			}
		}
	}
	add("", pol.RuleFor(""))
	agents := []string{}
	for _, a := range pol.Agents {
		add(a.Name, pol.RuleFor(a.Name))
		agents = append(agents, a.Name)
	}
	writeJSON(w, http.StatusOK, map[string]any{"options": out, "agents": agents, "mode": pol.Defaults.Mode})
}

// ruleList mirrors compile's list lookup for reading.
func ruleList(r *ep.Rule, name string) *[]string {
	switch name {
	case "exec_deny":
		return &r.ExecDeny
	case "file_deny":
		return &r.FileDeny
	case "file_alert":
		return &r.FileAlert
	case "domain_deny":
		return &r.DomainDeny
	case "network_deny":
		return &r.NetDeny
	case "exec_approve":
		return &r.ExecApprove
	case "file_approve":
		return &r.FileApprove
	case "domain_approve":
		return &r.DomainApprove
	case "network_approve":
		return &r.NetApprove
	case "command_approve":
		return &r.CommandApprove
	case "tool_approve":
		return &r.ToolApprove
	case "tool_deny":
		return &r.ToolDeny
	}
	return &r.ExecAllow
}

func newExceptionID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "exc_" + hex.EncodeToString(b)
}

func clean(list []string) []string {
	out := []string{}
	for _, v := range list {
		if v = strings.TrimSpace(v); v != "" && !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

func (s *Server) createException(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Endpoints    []string `json:"endpoints"`
		Owners       []string `json:"owners"`
		Teams        []string `json:"teams"`
		Agents       []string `json:"agents"`
		List         string   `json:"list"`
		Value        string   `json:"value"`
		Reason       string   `json:"reason"`
		ExpiresHours int      `json:"expires_hours"` // 0 = never
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	_, src, err := s.latestSource(r.Context(), p.Tenant)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusConflict, "publish a policy first")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	x := compile.Exception{ID: newExceptionID(), Endpoints: clean(req.Endpoints), Owners: clean(req.Owners), Teams: clean(req.Teams),
		Agents: clean(req.Agents), List: req.List, Value: strings.TrimSpace(req.Value), Reason: clip(strings.TrimSpace(req.Reason), 300),
		CreatedBy: p.UserID, CreatedAt: time.Now().UTC().Truncate(time.Second)}
	if req.ExpiresHours > 0 {
		t := x.CreatedAt.Add(time.Duration(min(req.ExpiresHours, 24*365)) * time.Hour)
		x.ExpiresAt = &t
	}
	if err := x.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(src.Exceptions) >= 200 {
		writeErr(w, http.StatusBadRequest, "at most 200 exceptions; remove old ones first")
		return
	}
	c := policyChange{Exception: &x, ExpiresHours: req.ExpiresHours}
	if s.proposeIfRequired(w, r, p, "exception.create", "Add "+exceptionComment(x), c, nil) {
		return
	}
	code, resp, err := s.applyExceptionCreate(r, p, c, "")
	s.writeApplied(w, code, resp, err)
}

// verbFor says what an exception allows, for comments and the console.
func verbFor(list string) string {
	switch {
	case list == "exec_allow":
		return "may also run"
	case strings.HasSuffix(list, "_approve"):
		return "no approval needed for"
	case list == "file_alert":
		return "no alert for"
	}
	return "allowed:"
}

func (s *Server) deleteException(w http.ResponseWriter, r *http.Request, p Principal) {
	_, src, err := s.latestSource(r.Context(), p.Tenant)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, err)
		return
	}
	id := r.PathValue("id")
	i := slices.IndexFunc(src.Exceptions, func(x compile.Exception) bool { return x.ID == id })
	if i < 0 {
		writeErr(w, http.StatusNotFound, "no such exception")
		return
	}
	x := src.Exceptions[i]
	c := policyChange{ExceptionID: id}
	if s.proposeIfRequired(w, r, p, "exception.delete", fmt.Sprintf("Remove exception %s (%s %s)", x.ID, x.List, x.Value), c, nil) {
		return
	}
	code, resp, err := s.applyExceptionDelete(r, p, c, "")
	s.writeApplied(w, code, resp, err)
}

// expireExceptions republishes, without them, the exceptions whose time is
// up (a version compiles against its own publish time, so an expired
// exception stays in force until the next version).
func (s *Server) expireExceptions(ctx context.Context) {
	pvs, err := s.Store.LatestSources(ctx)
	if err != nil {
		s.Logf("exception expiry: %v", err)
		return
	}
	now := time.Now()
	for tenant, pv := range pvs {
		src, err := decodeSource(pv.Source)
		if err != nil {
			continue
		}
		var gone []string
		src.Exceptions = slices.DeleteFunc(src.Exceptions, func(x compile.Exception) bool {
			if !x.Live(now) {
				gone = append(gone, x.ID)
				return true
			}
			return false
		})
		if len(gone) == 0 {
			continue
		}
		p := Principal{UserID: "system", Tenant: tenant, Role: "admin", Via: "system"}
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/internal/expire", nil)
		comment := "exceptions expired: " + strings.Join(gone, ", ")
		if v, _, _, err := s.publishCentral(req, p, pv.Body, src, comment); err != nil {
			s.Logf("exception expiry for %s: %v", tenant, err)
		} else {
			s.audit(req, p, "exception.expire", strings.Join(gone, ","), map[string]any{"version": v})
			s.emit(ctx, tenant, "policy.published", map[string]any{"version": v, "comment": comment, "by": "system"})
		}
	}
}
