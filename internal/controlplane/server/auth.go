package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Principal is who is calling the console API.
type Principal struct {
	UserID string `json:"user_id"`
	Tenant string `json:"tenant"` // Clerk ref: "org:<id>" or "user:<id>"
	Role   string `json:"role"`
	Via    string `json:"via"` // "clerk" | "admin-token"
}

// Authenticator accepts Clerk session JWTs (verified against the instance's
// JWKS) and, for automation, a static admin token plus X-Effigent-Tenant.
type Authenticator struct {
	clerkIssuer string
	jwks        keyfunc.Keyfunc
	adminToken  string
}

func NewAuthenticator(ctx context.Context, clerkIssuer, adminToken string) (*Authenticator, error) {
	a := &Authenticator{clerkIssuer: strings.TrimSuffix(clerkIssuer, "/"), adminToken: adminToken}
	if a.clerkIssuer != "" {
		k, err := keyfunc.NewDefaultCtx(ctx, []string{a.clerkIssuer + "/.well-known/jwks.json"})
		if err != nil {
			return nil, err
		}
		a.jwks = k
	}
	if a.jwks == nil && a.adminToken == "" {
		return nil, errors.New("configure CLERK_ISSUER and/or EFFIGENT_ADMIN_TOKEN")
	}
	return a, nil
}

type clerkClaims struct {
	jwt.RegisteredClaims
	OrgID   string `json:"org_id"`
	OrgRole string `json:"org_role"`
	O       *struct {
		ID  string `json:"id"`
		Rol string `json:"rol"`
	} `json:"o"`
}

func (a *Authenticator) Authenticate(r *http.Request) (Principal, error) {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || tok == "" {
		return Principal{}, errors.New("missing bearer token")
	}
	if a.adminToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(a.adminToken)) == 1 {
		tenant := r.Header.Get("X-Effigent-Tenant")
		if tenant == "" {
			return Principal{}, errors.New("admin token needs an X-Effigent-Tenant header")
		}
		return Principal{UserID: "admin", Tenant: tenant, Role: "admin", Via: "admin-token"}, nil
	}
	if a.jwks == nil {
		return Principal{}, errors.New("invalid token")
	}
	var c clerkClaims
	_, err := jwt.ParseWithClaims(tok, &c, a.jwks.Keyfunc,
		jwt.WithIssuer(a.clerkIssuer), jwt.WithValidMethods([]string{"RS256"}), jwt.WithLeeway(5*time.Second))
	if err != nil || c.Subject == "" {
		return Principal{}, errors.New("invalid session token")
	}
	p := Principal{UserID: c.Subject, Tenant: "user:" + c.Subject, Role: "admin", Via: "clerk"}
	org, role := c.OrgID, c.OrgRole
	if c.O != nil && c.O.ID != "" {
		org, role = c.O.ID, c.O.Rol
	}
	if org != "" {
		p.Tenant = "org:" + org
		p.Role = strings.TrimPrefix(role, "org:")
	}
	return p, nil
}

func (s *Server) console(next func(http.ResponseWriter, *http.Request, Principal)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Auth.Authenticate(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, err.Error())
			return
		}
		next(w, r, p)
	}
}
