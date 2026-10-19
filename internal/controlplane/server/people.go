package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// People (migration 010): the workspace's people by work email and the
// identities each goes by — OS users ("dana", or "dana@build-7" for one
// machine), hostnames, git emails, GitHub logins, other emails, vendor API
// key names. Pricing Leaks attributes vendor seats and effigentd's activity
// through it (spend.Directory). GET also returns what effigentd saw in the
// last 30 days (sightings, resolved) and suggested mappings; nothing is
// mapped until someone accepts a suggestion. A host mapping attributes
// activity only: it doesn't change the machine's owner, which central
// policies compile against.

const (
	peopleMaxIdentities = 100
	peopleWindowDays    = 30
)

func (s *Server) listPeople(w http.ResponseWriter, r *http.Request, p Principal) {
	ctx := r.Context()
	since := spend.Day(time.Now().UTC()).AddDate(0, 0, -(peopleWindowDays - 1))
	rows, err := s.Store.ListPeople(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	people, err := s.Store.SpendPeople(ctx, p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	sightings, err := s.Store.Sightings(ctx, p.Tenant, since)
	if err != nil {
		s.fail(w, err)
		return
	}
	seats, _, err := s.Store.SpendData(ctx, p.Tenant, since)
	if err != nil {
		s.fail(w, err)
		return
	}
	for i := range rows {
		store.SortIdentities(rows[i].Identities)
	}
	d := spend.NewDirectory(people)
	for _, x := range seats {
		if spend.SeatKind(x.Vendor) == spend.KindEmail {
			d.AddKnown(x.Identity)
		}
	}
	for _, x := range sightings {
		d.AddKnown(x.Owner)
	}
	d.ResolveSightings(sightings)
	unattributed := map[string]bool{}
	for _, x := range sightings {
		if x.Person == "" {
			unattributed[x.Hostname] = true
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"people":       rows,
		"suggestions":  spend.Suggest(people, sightings, seats),
		"sightings":    sightings,
		"unattributed": keys(unattributed),
		"kinds":        spend.Kinds,
		"window_days":  peopleWindowDays,
	})
}

func personEmail(raw string) (string, error) {
	e := strings.ToLower(strings.TrimSpace(raw))
	if !strings.Contains(e, "@") || strings.HasPrefix(e, "@") || strings.HasSuffix(e, "@") || len(e) > 254 || strings.ContainsAny(e, " \t\r\n,;:") {
		return "", fmt.Errorf("%q isn't an email address", clip(raw, 60))
	}
	return e, nil
}

func (s *Server) identityConflict(w http.ResponseWriter, err error) bool {
	var c *store.IdentityConflict
	if errors.As(err, &c) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": c.Error(), "kind": c.Kind, "value": c.Value, "email": c.Email})
		return true
	}
	return false
}

// putPerson creates or updates a person: {"name", "identities": [{"kind", "value"}]}
// replaces their identities.
func (s *Server) putPerson(w http.ResponseWriter, r *http.Request, p Principal) {
	email, err := personEmail(r.PathValue("email"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		Name       string                 `json:"name"`
		Identities []store.PersonIdentity `json:"identities"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, `body must be {"name": "…", "identities": [{"kind": "os_user", "value": "dana"}]}`)
		return
	}
	if len(req.Identities) > peopleMaxIdentities {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("at most %d identities per person", peopleMaxIdentities))
		return
	}
	ids := make([]store.PersonIdentity, 0, len(req.Identities))
	seen := map[string]bool{}
	for _, x := range req.Identities {
		k, v, err := store.NormIdentity(x.Kind, x.Value)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if (k == spend.KindEmail || k == spend.KindGitEmail) && v == email || seen[k+":"+v] {
			continue
		}
		seen[k+":"+v] = true
		src := "manual"
		if x.Source == "suggestion" {
			src = "suggestion"
		}
		ids = append(ids, store.PersonIdentity{Kind: k, Value: v, Source: src})
	}
	name := clip(strings.TrimSpace(req.Name), 120)
	before, _ := s.Store.GetPerson(r.Context(), p.Tenant, email)
	created, err := s.Store.PutPerson(r.Context(), p.Tenant, email, name, ids, p.UserID)
	if s.identityConflict(w, err) {
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	action := "people.update"
	if created {
		action = "people.create"
	}
	s.audit(r, p, action, email, map[string]any{"name": name, "before": identityList(before.Identities), "after": identityList(ids)})
	after, err := s.Store.GetPerson(r.Context(), p.Tenant, email)
	if err != nil {
		s.fail(w, err)
		return
	}
	store.SortIdentities(after.Identities)
	writeJSON(w, http.StatusOK, after)
}

func identityList(ids []store.PersonIdentity) []string {
	out := make([]string, 0, len(ids))
	for _, x := range ids {
		out = append(out, x.Kind+":"+x.Value)
	}
	return out
}

func (s *Server) deletePerson(w http.ResponseWriter, r *http.Request, p Principal) {
	email, err := personEmail(r.PathValue("email"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	before, _ := s.Store.GetPerson(r.Context(), p.Tenant, email)
	if err := s.Store.DeletePerson(r.Context(), p.Tenant, email); errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such person")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "people.delete", email, map[string]any{"identities": identityList(before.Identities)})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// addPersonIdentity maps one identity ({"kind", "value", "email", "name",
// "source"}): accepting a suggestion, or a quick add. Kind "person" adds the
// person only. The person is created when needed.
func (s *Server) addPersonIdentity(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Kind   string `json:"kind"`
		Value  string `json:"value"`
		Email  string `json:"email"`
		Name   string `json:"name"`
		Source string `json:"source"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, `body must be {"kind", "value", "email"}`)
		return
	}
	email, err := personEmail(req.Email)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	kind, value := spend.KindPerson, email
	if strings.TrimSpace(req.Kind) != spend.KindPerson {
		if kind, value, err = store.NormIdentity(req.Kind, req.Value); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	src := "manual"
	if req.Source == "suggestion" {
		src = "suggestion"
	}
	err = s.Store.AddPersonIdentity(r.Context(), p.Tenant, kind, value, email, clip(strings.TrimSpace(req.Name), 120), src, p.UserID)
	if s.identityConflict(w, err) {
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "people.identity.add", email, map[string]any{"kind": kind, "value": value, "source": src})
	writeJSON(w, http.StatusOK, map[string]any{"kind": kind, "value": value, "email": email})
}

// deletePersonIdentity unmaps ?kind=&value=.
func (s *Server) deletePersonIdentity(w http.ResponseWriter, r *http.Request, p Principal) {
	kind, value, err := store.NormIdentity(r.URL.Query().Get("kind"), r.URL.Query().Get("value"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	email, err := s.Store.DeletePersonIdentity(r.Context(), p.Tenant, kind, value)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "that identity isn't mapped")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "people.identity.delete", email, map[string]any{"kind": kind, "value": value})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
