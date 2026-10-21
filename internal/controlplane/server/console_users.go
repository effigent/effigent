package server

import (
	"context"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
)

// With a generic OIDC provider there is no directory API to ask "who is in
// this workspace" (Clerk's Backend API answers that for SaaS). The control
// plane remembers who signed in instead (cp.console_users, migration 020):
// the Team page lists them, and StoreDirectory answers the approver checks.

// memberWindow: a user not seen signing in for this long no longer counts
// as a workspace member (their IdP account may be gone).
const memberWindow = 30 * 24 * time.Hour

// seenUsers throttles the sign-in upsert to once per user per 5 minutes,
// unless what the token says changed.
type seenUsers struct {
	mu sync.Mutex
	m  map[string]seenEntry
}

type seenEntry struct {
	at  time.Time
	sig string
}

func (s *Server) noteOIDCUser(ctx context.Context, p Principal) {
	if p.Via != "oidc" || s.Store == nil {
		return
	}
	sig := p.Email + "\x00" + p.Name + "\x00" + p.Role + "\x00" + joinGroups(p.Groups)
	key := p.Tenant + "\x00" + p.UserID
	s.seen.mu.Lock()
	if s.seen.m == nil {
		s.seen.m = map[string]seenEntry{}
	}
	e, ok := s.seen.m[key]
	if ok && e.sig == sig && time.Since(e.at) < 5*time.Minute {
		s.seen.mu.Unlock()
		return
	}
	s.seen.m[key] = seenEntry{at: time.Now(), sig: sig}
	s.seen.mu.Unlock()
	if err := s.Store.SeeConsoleUser(ctx, p.Tenant, store.ConsoleUser{UserID: p.UserID, Email: p.Email, Name: p.Name, Role: p.Role, Groups: p.Groups}); err != nil {
		s.Logf("console user %s: %v", p.UserID, err)
		s.seen.mu.Lock()
		delete(s.seen.m, key)
		s.seen.mu.Unlock()
	}
}

func joinGroups(g []string) string {
	g = slices.Clone(g)
	slices.Sort(g)
	out := ""
	for _, x := range g {
		out += x + ","
	}
	return out
}

// members lists the people who signed in to this workspace through OIDC
// (GET /api/v1/members). Clerk workspaces read members from Clerk in the
// browser and get an empty list here.
func (s *Server) members(w http.ResponseWriter, r *http.Request, p Principal) {
	us, err := s.Store.ListConsoleUsers(r.Context(), p.Tenant, time.Now().Add(-memberWindow))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": us, "source": "sign-ins", "window_days": int(memberWindow.Hours() / 24)})
}

// StoreDirectory answers the approver checks from cp.console_users, for a
// control plane signing people in through a generic OIDC provider.
type StoreDirectory struct {
	Store *store.Store
}

// MemberRole is the role of the user with this verified email, from their
// latest sign-in within memberWindow, or "".
func (d *StoreDirectory) MemberRole(ctx context.Context, tenant, email string) (string, error) {
	u, ok, err := d.Store.ConsoleUserByEmail(ctx, tenant, email, time.Now().Add(-memberWindow))
	if err != nil || !ok {
		return "", err
	}
	return u.Role, nil
}

// UserEmails is the user's verified email, as their last sign-in said.
func (d *StoreDirectory) UserEmails(ctx context.Context, tenant, userID string) ([]string, error) {
	u, ok, err := d.Store.ConsoleUserByID(ctx, tenant, userID)
	if err != nil || !ok || u.Email == "" {
		return nil, err
	}
	return []string{u.Email}, nil
}
