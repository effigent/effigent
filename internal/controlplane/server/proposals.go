package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/compile"
	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
	ep "github.com/effigent/effigent/internal/endpoint/policy"
)

// Four-eyes policy changes. With the tenant's policy_change_approval on,
// every change that would publish a policy version — the policy itself
// (PUT /api/v1/policy), an exception (POST/DELETE /api/v1/exceptions) and a
// machine's owner/teams (PATCH /api/v1/endpoints/{id}) — is checked as usual
// and then filed as a proposal (202) instead of applied. Another admin or
// security admin approves it and it is applied exactly as the direct call
// would have been; the author can't approve their own (nor, for a proposal
// made with an API key, the person who created the key), and API keys can
// propose but never approve. A policy proposal is stale once another version
// is published after it (superseded on approval: re-propose on top); an
// exception or owner change is re-applied on the latest version. Turning
// the setting on is immediate; turning it off is itself a proposal. There is
// no break-glass: an emergency change needs a second admin like any other.
// Exceptions that expire are removed by the control plane without a
// proposal (removing an allowance only tightens the policy).

// policyChange is one change that publishes a version; it is a proposal's
// payload.
type policyChange struct {
	// policy
	Body     string          `json:"body,omitempty"`
	Comment  string          `json:"comment,omitempty"`
	Policies json.RawMessage `json:"policies,omitempty"` // nil = keep the published ones
	// exception.create
	Exception    *compile.Exception `json:"exception,omitempty"`
	ExpiresHours int                `json:"expires_hours,omitempty"`
	// exception.delete
	ExceptionID string `json:"exception_id,omitempty"`
	// endpoint.owner
	EndpointID string   `json:"endpoint_id,omitempty"`
	Hostname   string   `json:"hostname,omitempty"`
	Owner      string   `json:"owner,omitempty"`
	Teams      []string `json:"teams,omitempty"`
	// settings
	ChangeApproval *bool `json:"policy_change_approval,omitempty"`
}

// changeApproval reports whether the tenant's policy changes need a second admin.
func (s *Server) changeApproval(ctx context.Context, tenant string) (bool, error) {
	ps, err := s.Store.GetPolicySettings(ctx, tenant)
	return ps.ChangeApproval, err
}

// proposeIfRequired files c as a proposal when the tenant requires one and
// answers 202; it returns false when the caller should apply c itself.
func (s *Server) proposeIfRequired(w http.ResponseWriter, r *http.Request, p Principal, kind, summary string, c policyChange, extra map[string]any) bool {
	on, err := s.changeApproval(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return true
	}
	if !on {
		return false
	}
	s.propose(w, r, p, kind, summary, c, extra)
	return true
}

func (s *Server) propose(w http.ResponseWriter, r *http.Request, p Principal, kind, summary string, c policyChange, extra map[string]any) {
	ctx := r.Context()
	base := int64(0)
	if pv, err := s.Store.LatestPolicy(ctx, p.Tenant); err == nil {
		base = pv.Version
	} else if !errors.Is(err, store.ErrNotFound) {
		s.fail(w, err)
		return
	}
	payload, _ := json.Marshal(c)
	prop := store.Proposal{Tenant: p.Tenant, Kind: kind, Payload: payload, Summary: clip(summary, 500), BaseVersion: base,
		Author: p.UserID, AuthorName: s.principalName(ctx, p), AuthorVia: p.Via}
	if p.Via == "api-key" {
		prop.AuthorOwner = s.apiKeyOwner(ctx, p)
	}
	prop, err := s.Store.CreateProposal(ctx, prop)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "policy.propose", prop.ID, map[string]any{"kind": kind, "summary": prop.Summary, "base_version": base})
	s.emit(ctx, p.Tenant, "policy.proposed", s.proposalEvent(prop))
	s.announceProposal(ctx, prop)
	resp := map[string]any{"proposal": prop, "pending_approval": true,
		"message": "Policy changes in this workspace need a second admin: this change is waiting for approval."}
	for k, v := range extra {
		resp[k] = v
	}
	writeJSON(w, http.StatusAccepted, resp)
}

// principalName is how a proposal shows its author.
func (s *Server) principalName(ctx context.Context, p Principal) string {
	switch p.Via {
	case "api-key":
		return "API key " + strings.TrimPrefix(p.UserID, "apikey:")
	case "admin-token":
		return "admin token"
	}
	if d, ok := s.Directory.(userEmails); ok && s.Directory != nil {
		if es, err := d.UserEmails(ctx, p.Tenant, p.UserID); err == nil && len(es) > 0 {
			return es[0]
		}
	}
	return p.UserID
}

// apiKeyOwner is the console user who created the key p uses.
func (s *Server) apiKeyOwner(ctx context.Context, p Principal) string {
	keys, err := s.Store.ListAPIKeys(ctx, p.Tenant)
	if err != nil {
		return ""
	}
	for _, k := range keys {
		if "apikey:"+k.ID == p.UserID {
			return k.CreatedBy
		}
	}
	return ""
}

func (s *Server) proposalEvent(prop store.Proposal) map[string]any {
	d := map[string]any{"proposal": prop}
	if s.ConsoleOrigin != "" {
		d["review_url"] = s.ConsoleOrigin + "/policies?proposal=" + prop.ID
	}
	return d
}

// announceProposal emails the workspace's notification recipients (the
// approval emails): a proposal is decided in the console, never from email.
func (s *Server) announceProposal(ctx context.Context, prop store.Proposal) {
	if !s.Notify.EmailEnabled() {
		return
	}
	n, err := s.Store.GetNotificationSettings(ctx, prop.Tenant)
	if err != nil || len(n.Emails) == 0 {
		return
	}
	m := notify.Message{
		Title:  "Policy change waiting for a second admin",
		Fields: [][2]string{{"Change", prop.Summary}, {"Proposed by", prop.AuthorName}, {"Based on", fmt.Sprintf("version %d", prop.BaseVersion)}},
		Footer: "Approve or reject it in the Effigent console (Policies). The author can't approve their own change.",
	}
	if s.ConsoleOrigin != "" {
		m.Link = s.ConsoleOrigin + "/policies?proposal=" + prop.ID
	}
	for _, rcpt := range n.Emails {
		if strings.EqualFold(rcpt, prop.AuthorName) {
			continue
		}
		if err := s.Notify.Email(ctx, []string{rcpt}, m); err != nil {
			s.Logf("proposal %s: email %s: %v", prop.ID, rcpt, err)
		}
	}
}

// ---- applying a change (directly, or when its proposal is approved) ----

// applyChange publishes c as p. note is appended to the version's comment
// (who proposed and approved it). The answer is what the direct call
// returns; a 4xx error is the caller's to show.
func (s *Server) applyChange(r *http.Request, p Principal, kind string, c policyChange, note string) (int, map[string]any, error) {
	switch kind {
	case "policy":
		return s.applyPolicy(r, p, c, note)
	case "exception.create":
		return s.applyExceptionCreate(r, p, c, note)
	case "exception.delete":
		return s.applyExceptionDelete(r, p, c, note)
	case "endpoint.owner":
		return s.applyEndpointOwner(r, p, c, note)
	case "settings":
		on := c.ChangeApproval != nil && *c.ChangeApproval
		if err := s.Store.PutPolicySettings(r.Context(), p.Tenant, store.PolicySettings{ChangeApproval: on}, p.UserID); err != nil {
			return http.StatusInternalServerError, nil, err
		}
		s.audit(r, p, "policy.settings.update", "policy", map[string]any{"policy_change_approval": on, "note": note})
		ps, _ := s.Store.GetPolicySettings(r.Context(), p.Tenant)
		return http.StatusOK, map[string]any{"settings": ps}, nil
	}
	return http.StatusBadRequest, nil, fmt.Errorf("unknown change %q", kind)
}

func withNote(comment, note string) string {
	if note == "" {
		return comment
	}
	if comment == "" {
		return note
	}
	return comment + " (" + note + ")"
}

// policySource is the source a policy change publishes: the given central
// policies, or the published ones; exceptions are always kept.
func (s *Server) policySource(ctx context.Context, tenant string, c policyChange) (source, error) {
	prev, err := s.Store.LatestPolicy(ctx, tenant)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return source{}, err
	}
	prevSrc, err := decodeSource(prev.Source)
	if err != nil {
		return source{}, err
	}
	src := source{Policies: prevSrc.Policies, Exceptions: prevSrc.Exceptions}
	if c.Policies != nil {
		if src.Policies, err = decodePolicies(c.Policies); err != nil {
			return source{}, badRequest{err}
		}
	}
	return src, nil
}

// badRequest marks an error as the caller's (400).
type badRequest struct{ error }

// checkPolicy runs a policy change's checks without publishing (for a
// proposal): the same parser and compiler as a publish.
func (s *Server) checkPolicy(ctx context.Context, tenant string, c policyChange) (*publishReport, error) {
	src, err := s.policySource(ctx, tenant, c)
	if err != nil {
		return nil, err
	}
	if src.empty() {
		if _, err := ep.Parse([]byte(c.Body)); err != nil {
			return nil, badRequest{err}
		}
		return nil, nil
	}
	base := c.Body
	if base == "" {
		base = string(ep.DefaultYAML)
	}
	if _, err := ep.Parse([]byte(base)); err != nil {
		return nil, badRequest{err}
	}
	if err := validatePolicies(src.Policies); err != nil {
		return nil, badRequest{err}
	}
	eps, err := s.Store.ListEndpoints(ctx, tenant)
	if err != nil {
		return nil, err
	}
	rep, err := compileAll([]byte(base), src, eps, time.Now().UTC().Truncate(time.Microsecond))
	if err != nil {
		return nil, badRequest{err}
	}
	return rep, nil
}

func (s *Server) applyPolicy(r *http.Request, p Principal, c policyChange, note string) (int, map[string]any, error) {
	src, err := s.policySource(r.Context(), p.Tenant, c)
	var bad badRequest
	if errors.As(err, &bad) {
		return http.StatusBadRequest, nil, err
	} else if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	comment := withNote(c.Comment, note)
	if !src.empty() {
		v, rep, code, err := s.publishCentral(r, p, c.Body, src, comment)
		if err != nil {
			return code, nil, err
		}
		s.Logf("policy v%d (%d central policies) published for %s by %s", v, len(src.Policies), p.Tenant, p.UserID)
		s.audit(r, p, "policy.publish", fmt.Sprintf("v%d", v), map[string]any{"version": v, "comment": comment,
			"bytes": len(c.Body), "policies": len(src.Policies), "unsupported": len(rep.Unsupported)})
		s.emit(r.Context(), p.Tenant, "policy.published", map[string]any{"version": v, "comment": comment, "by": p.UserID, "central_policies": len(src.Policies)})
		return http.StatusOK, map[string]any{"version": v, "report": rep}, nil
	}
	if _, err := ep.Parse([]byte(c.Body)); err != nil {
		return http.StatusBadRequest, nil, err
	}
	v, err := s.Store.PutPolicy(r.Context(), p.Tenant, c.Body, nil, comment, p.UserID, time.Now().UTC().Truncate(time.Microsecond))
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	s.Logf("policy v%d published for %s by %s", v, p.Tenant, p.UserID)
	s.audit(r, p, "policy.publish", fmt.Sprintf("v%d", v), map[string]any{"version": v, "comment": comment, "bytes": len(c.Body)})
	s.emit(r.Context(), p.Tenant, "policy.published", map[string]any{"version": v, "comment": comment, "by": p.UserID})
	return http.StatusOK, map[string]any{"version": v}, nil
}

func exceptionComment(x compile.Exception) string {
	who := strings.Join(append(append(append([]string{}, x.Endpoints...), x.Owners...), x.Teams...), ", ")
	return fmt.Sprintf("exception %s: %s — %s %s", x.ID, who, verbFor(x.List), x.Value)
}

func (s *Server) applyExceptionCreate(r *http.Request, p Principal, c policyChange, note string) (int, map[string]any, error) {
	if c.Exception == nil {
		return http.StatusBadRequest, nil, errors.New("no exception")
	}
	x := *c.Exception
	pv, src, err := s.latestSource(r.Context(), p.Tenant)
	if errors.Is(err, store.ErrNotFound) {
		return http.StatusConflict, nil, errors.New("publish a policy first")
	} else if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	// it starts now: an approved exception's clock runs from the approval
	x.CreatedAt = time.Now().UTC().Truncate(time.Second)
	x.ExpiresAt = nil
	if c.ExpiresHours > 0 {
		t := x.CreatedAt.Add(time.Duration(min(c.ExpiresHours, 24*365)) * time.Hour)
		x.ExpiresAt = &t
	}
	if err := x.Validate(); err != nil {
		return http.StatusBadRequest, nil, err
	}
	if len(src.Exceptions) >= 200 {
		return http.StatusBadRequest, nil, errors.New("at most 200 exceptions; remove old ones first")
	}
	src.Exceptions = append(src.Exceptions, x)
	comment := withNote(exceptionComment(x), note)
	v, rep, code, err := s.publishCentral(r, p, pv.Body, src, comment)
	if err != nil {
		return code, nil, err
	}
	s.audit(r, p, "exception.create", x.ID, x)
	s.emit(r.Context(), p.Tenant, "policy.published", map[string]any{"version": v, "comment": comment, "by": p.UserID})
	return http.StatusCreated, map[string]any{"exception": x, "version": v, "report": rep}, nil
}

func (s *Server) applyExceptionDelete(r *http.Request, p Principal, c policyChange, note string) (int, map[string]any, error) {
	pv, src, err := s.latestSource(r.Context(), p.Tenant)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return http.StatusInternalServerError, nil, err
	}
	i := slices.IndexFunc(src.Exceptions, func(x compile.Exception) bool { return x.ID == c.ExceptionID })
	if i < 0 {
		return http.StatusNotFound, nil, errors.New("no such exception")
	}
	x := src.Exceptions[i]
	src.Exceptions = slices.Delete(src.Exceptions, i, i+1)
	comment := withNote(fmt.Sprintf("exception %s removed (%s %s)", x.ID, x.List, x.Value), note)
	v, _, code, err := s.publishCentral(r, p, pv.Body, src, comment)
	if err != nil {
		return code, nil, err
	}
	s.audit(r, p, "exception.delete", x.ID, x)
	s.emit(r.Context(), p.Tenant, "policy.published", map[string]any{"version": v, "comment": comment, "by": p.UserID})
	return http.StatusOK, map[string]any{"version": v}, nil
}

func (s *Server) applyEndpointOwner(r *http.Request, p Principal, c policyChange, note string) (int, map[string]any, error) {
	teams := c.Teams
	if teams == nil {
		teams = []string{}
	}
	e, err := s.Store.SetEndpointOwner(r.Context(), p.Tenant, c.EndpointID, c.Owner, teams)
	if errors.Is(err, store.ErrNotFound) {
		return http.StatusNotFound, nil, errors.New("no such endpoint")
	}
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	s.audit(r, p, "endpoint.owner", e.ID, map[string]any{"hostname": e.Hostname, "owner": e.Owner, "teams": e.Teams})
	resp := map[string]any{"endpoint": e}
	pv, err := s.Store.LatestPolicy(r.Context(), p.Tenant)
	if err == nil && pv.Source != nil {
		src, err := decodeSource(pv.Source)
		if err != nil {
			return http.StatusInternalServerError, nil, err
		}
		comment := withNote(fmt.Sprintf("recompiled: %s owner %q teams %v", e.Hostname, e.Owner, e.Teams), note)
		v, rep, code, err := s.publishCentral(r, p, pv.Body, src, comment)
		if err != nil {
			if code == http.StatusInternalServerError {
				return code, nil, err
			}
			// The owner is saved; the policy can't be compiled for it.
			resp["policy_error"] = err.Error()
		} else {
			s.audit(r, p, "policy.publish", fmt.Sprintf("v%d", v), map[string]any{"version": v, "comment": comment})
			resp["version"], resp["report"] = v, rep
		}
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		return http.StatusInternalServerError, nil, err
	}
	return http.StatusOK, resp, nil
}

// writeApplied answers a direct change.
func (s *Server) writeApplied(w http.ResponseWriter, code int, resp map[string]any, err error) {
	switch {
	case code >= 500:
		s.fail(w, err)
	case err != nil:
		writeErr(w, code, err.Error())
	default:
		writeJSON(w, code, resp)
	}
}

// ---- proposals API ----

type proposalView struct {
	store.Proposal
	// Stale: a policy proposal made on an older version (approving it
	// supersedes it instead of applying it).
	Stale bool `json:"stale"`
	// CanDecide: this caller may approve or reject it.
	CanDecide bool   `json:"can_decide"`
	Why       string `json:"why,omitempty"` // why not
	// Base is the version it was proposed on, for the console's diff.
	Base *store.PolicyVersion `json:"base,omitempty"`
}

// proposalDecider says whether p may approve or reject prop ("" = yes).
func proposalDecider(p Principal, prop store.Proposal) string {
	switch {
	case p.Via == "api-key":
		return "API keys can propose policy changes but never approve them"
	case p.Via == "admin-token":
		return "the admin token can propose policy changes but never decide them: a second admin signed in to the console must"
	case !p.CanWrite():
		return "only workspace admins and security admins decide policy changes"
	case p.UserID == prop.Author:
		return "you proposed this change: another admin must approve it"
	case prop.AuthorOwner != "" && p.UserID == prop.AuthorOwner:
		return "this change was proposed with an API key you created: another admin must approve it"
	}
	return ""
}

func (s *Server) listProposals(w http.ResponseWriter, r *http.Request, p Principal) {
	state := r.URL.Query().Get("state")
	if state != "" && !slices.Contains([]string{store.ProposalPending, store.ProposalApproved, store.ProposalRejected, store.ProposalSuperseded, store.ProposalWithdrawn}, state) {
		writeErr(w, http.StatusBadRequest, "unknown state")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	props, err := s.Store.ListProposals(r.Context(), p.Tenant, state, limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	latest := int64(0)
	if pv, err := s.Store.LatestPolicy(r.Context(), p.Tenant); err == nil {
		latest = pv.Version
	}
	bases := map[int64]*store.PolicyVersion{}
	out := make([]proposalView, 0, len(props))
	for _, prop := range props {
		v := proposalView{Proposal: prop}
		if prop.State == store.ProposalPending {
			v.Stale = prop.Kind == "policy" && prop.BaseVersion != latest
			v.Why = proposalDecider(p, prop)
			v.CanDecide = v.Why == ""
			if prop.Kind == "policy" && prop.BaseVersion > 0 {
				if _, ok := bases[prop.BaseVersion]; !ok {
					if pv, err := s.Store.PolicyAt(r.Context(), p.Tenant, int(prop.BaseVersion)); err == nil {
						bases[prop.BaseVersion] = &pv
					} else {
						bases[prop.BaseVersion] = nil
					}
				}
				v.Base = bases[prop.BaseVersion]
			}
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) decideProposal(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Decision string `json:"decision"` // approve | reject
		Note     string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil || (req.Decision != "approve" && req.Decision != "reject") {
		writeErr(w, http.StatusBadRequest, `body must be {"decision": "approve" | "reject", "note": "…"}`)
		return
	}
	note := clip(strings.TrimSpace(req.Note), 500)
	ctx := r.Context()
	prop, err := s.Store.GetProposal(ctx, p.Tenant, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such proposal")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	if prop.State != store.ProposalPending {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "this proposal is already " + prop.State, "proposal": prop})
		return
	}
	if why := proposalDecider(p, prop); why != "" {
		if p.UserID == prop.Author || p.UserID == prop.AuthorOwner {
			s.audit(r, p, "policy.self_approval_refused", prop.ID, map[string]any{"kind": prop.Kind, "summary": prop.Summary})
		}
		writeErr(w, http.StatusForbidden, why)
		return
	}
	name := s.principalName(ctx, p)
	details := map[string]any{"kind": prop.Kind, "summary": prop.Summary, "author": prop.Author, "author_name": prop.AuthorName,
		"base_version": prop.BaseVersion, "note": note}
	if req.Decision == "reject" {
		prop, err = s.Store.CloseProposal(ctx, p.Tenant, prop.ID, store.ProposalRejected, p.UserID, name, note)
		if errors.Is(err, store.ErrProposalClosed) {
			writeErr(w, http.StatusConflict, err.Error())
			return
		} else if err != nil {
			s.fail(w, err)
			return
		}
		s.audit(r, p, "policy.reject", prop.ID, details)
		writeJSON(w, http.StatusOK, map[string]any{"proposal": prop})
		return
	}
	if prop.Kind == "policy" {
		latest := int64(0)
		if pv, err := s.Store.LatestPolicy(ctx, p.Tenant); err == nil {
			latest = pv.Version
		}
		if latest != prop.BaseVersion {
			why := fmt.Sprintf("superseded: version %d was published after this was proposed on version %d", latest, prop.BaseVersion)
			if prop, err = s.Store.CloseProposal(ctx, p.Tenant, prop.ID, store.ProposalSuperseded, p.UserID, name, why); err == nil {
				s.audit(r, p, "policy.supersede", prop.ID, details)
			}
			writeJSON(w, http.StatusConflict, map[string]any{"error": why + "; propose the change again on the current version", "proposal": prop})
			return
		}
	}
	var c policyChange
	if err := json.Unmarshal(prop.Payload, &c); err != nil {
		s.fail(w, err)
		return
	}
	// claim it first: only one approval applies it
	prop, err = s.Store.CloseProposal(ctx, p.Tenant, prop.ID, store.ProposalApproved, p.UserID, name, note)
	if errors.Is(err, store.ErrProposalClosed) {
		writeErr(w, http.StatusConflict, err.Error())
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	code, resp, err := s.applyChange(r, p, prop.Kind, c, fmt.Sprintf("proposal %s by %s, approved by %s", prop.ID, prop.AuthorName, name))
	if err != nil {
		_ = s.Store.ReopenProposal(ctx, p.Tenant, prop.ID)
		if code >= 500 {
			s.fail(w, err)
			return
		}
		// it no longer applies (the exception or machine is gone, or it doesn't compile now)
		why := "superseded: " + err.Error()
		if prop, err = s.Store.CloseProposal(ctx, p.Tenant, prop.ID, store.ProposalSuperseded, p.UserID, name, why); err == nil {
			s.audit(r, p, "policy.supersede", prop.ID, details)
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": why, "proposal": prop})
		return
	}
	if v, ok := resp["version"].(int64); ok {
		prop.Version = v
		_ = s.Store.ProposalApplied(ctx, p.Tenant, prop.ID, v)
	}
	details["version"] = prop.Version
	s.audit(r, p, "policy.approve", prop.ID, details)
	resp["proposal"] = prop
	writeJSON(w, http.StatusOK, resp)
}

// withdrawProposal: the author takes back their own pending proposal.
func (s *Server) withdrawProposal(w http.ResponseWriter, r *http.Request, p Principal) {
	prop, err := s.Store.GetProposal(r.Context(), p.Tenant, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such proposal")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	if prop.Author != p.UserID {
		writeErr(w, http.StatusForbidden, "only the author can withdraw a proposal; reject it instead")
		return
	}
	prop, err = s.Store.CloseProposal(r.Context(), p.Tenant, prop.ID, store.ProposalWithdrawn, p.UserID, s.principalName(r.Context(), p), "")
	if errors.Is(err, store.ErrProposalClosed) {
		writeErr(w, http.StatusConflict, err.Error())
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "policy.withdraw", prop.ID, map[string]any{"kind": prop.Kind, "summary": prop.Summary})
	writeJSON(w, http.StatusOK, map[string]any{"proposal": prop})
}

func (s *Server) getPolicySettings(w http.ResponseWriter, r *http.Request, p Principal) {
	ps, err := s.Store.GetPolicySettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

// putPolicySettings: turning change approval on applies at once; turning
// it off is a change like any other and needs a second admin.
func (s *Server) putPolicySettings(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		ChangeApproval *bool `json:"policy_change_approval"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil || req.ChangeApproval == nil {
		writeErr(w, http.StatusBadRequest, `body must be {"policy_change_approval": true | false}`)
		return
	}
	cur, err := s.Store.GetPolicySettings(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	if cur.ChangeApproval == *req.ChangeApproval {
		writeJSON(w, http.StatusOK, map[string]any{"settings": cur})
		return
	}
	c := policyChange{ChangeApproval: req.ChangeApproval}
	if cur.ChangeApproval { // on → off
		s.propose(w, r, p, "settings", "Turn off policy change approval (changes would publish without a second admin)", c, nil)
		return
	}
	code, resp, err := s.applyChange(r, p, "settings", c, "")
	s.writeApplied(w, code, resp, err)
}
