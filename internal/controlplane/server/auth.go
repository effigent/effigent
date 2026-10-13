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
	// adminTenants lists the tenants the admin token may act on. Empty means
	// the admin token is accepted for none: one leaked token must never be
	// able to rewrite every customer's policy.
	adminTenants map[string]bool
	// authorizedParties, when set, are the only origins whose Clerk session
	// tokens are accepted (Clerk's "azp" claim), e.g. https://app.effigent.ai.
	authorizedParties map[string]bool
}

// Options configures NewAuthenticator.
type Options struct {
	ClerkIssuer       string
	AdminToken        string
	AdminTenants      []string
	AuthorizedParties []string
}

func set(list []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range list {
		if x = strings.TrimSpace(x); x != "" {
			m[x] = true
		}
	}
	return m
}

func NewAuthenticator(ctx context.Context, o Options) (*Authenticator, error) {
	a := &Authenticator{clerkIssuer: strings.TrimSuffix(o.ClerkIssuer, "/"), adminToken: o.AdminToken,
		adminTenants: set(o.AdminTenants), authorizedParties: set(o.AuthorizedParties)}
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
	AZP     string `json:"azp"`
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
		if !a.adminTenants[tenant] && !a.adminTenants["*"] {
			return Principal{}, errors.New("the admin token is not enabled for this tenant")
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
	if len(a.authorizedParties) > 0 && !a.authorizedParties[c.AZP] {
		return Principal{}, errors.New("session token was not issued for this console")
	}
	// A personal workspace (no active org) belongs to its user alone.
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

// CanWrite reports whether the principal may change policy, machines and
// tokens. Org admins and the custom "security_admin" role (the CISO's team)
// can; every other member is read-only.
func (p Principal) CanWrite() bool {
	return p.Role == "admin" || p.Role == "security_admin"
}

type access int

const (
	read access = iota
	write
)

func (s *Server) console(need access, next func(http.ResponseWriter, *http.Request, Principal)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Auth.Authenticate(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, err.Error())
			return
		}
		if ok, wait := s.limits.console.allow("user:" + p.Tenant + "/" + p.UserID); !ok {
			tooMany(w, wait)
			return
		}
		if need == write && !p.CanWrite() {
			s.audit(r, p, "denied."+r.Method+" "+r.URL.Path, "", nil)
			writeErr(w, http.StatusForbidden, "your role can view but not change this; ask an org admin or security admin")
			return
		}
		next(w, r, p)
	}
}
