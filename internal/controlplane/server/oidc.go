package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// OIDCOptions configures sign-in with a generic OpenID Connect provider
// (Okta, Entra ID, Keycloak, Google Workspace, Dex, …) for a self-hosted
// control plane. Every OIDC user belongs to one workspace, Tenant.
type OIDCOptions struct {
	Issuer string // exactly the tokens' "iss"
	// Audience is the "aud" the tokens must carry: the console's client id
	// when the console sends ID tokens (its default).
	Audience string
	// JWKSURL skips discovery (issuer/.well-known/openid-configuration);
	// useful when the issuer's public URL isn't reachable from the control plane.
	JWKSURL string
	// Tenant is the self-hosted workspace, e.g. "org:self-hosted".
	Tenant string
	// Claim names (defaults: sub, email, name, groups).
	UserClaim, EmailClaim, NameClaim, GroupsClaim string
	// Roles: a member of an admin group (or listed in AdminEmails, with a
	// verified email) is "admin"; of a security-admin group "security_admin";
	// everyone else "member" (read-only).
	AdminGroups, SecurityAdminGroups, AdminEmails []string
	// AllowedGroups, when set, refuses everyone in none of them (and in no
	// admin group / AdminEmails).
	AllowedGroups []string
	// AllowUnverifiedEmail accepts an email without email_verified=true
	// (some providers never send the claim). Off by default: an unverified
	// email never makes anyone an admin or an approver.
	AllowUnverifiedEmail bool
	// HTTP fetches discovery and keys (default: 10s timeout).
	HTTP *http.Client
}

// OIDCOptionsFromEnv reads EFFIGENT_OIDC_*; nil when EFFIGENT_OIDC_ISSUER is unset.
func OIDCOptionsFromEnv(getenv func(string) string) (*OIDCOptions, error) {
	iss := strings.TrimSpace(getenv("EFFIGENT_OIDC_ISSUER"))
	if iss == "" {
		return nil, nil
	}
	list := func(k string) []string {
		var out []string
		for _, x := range strings.Split(getenv(k), ",") {
			if x = strings.TrimSpace(x); x != "" {
				out = append(out, x)
			}
		}
		return out
	}
	o := &OIDCOptions{
		Issuer:    iss,
		Audience:  strings.TrimSpace(getenv("EFFIGENT_OIDC_AUDIENCE")),
		JWKSURL:   strings.TrimSpace(getenv("EFFIGENT_OIDC_JWKS_URL")),
		Tenant:    strings.TrimSpace(getenv("EFFIGENT_OIDC_TENANT")),
		UserClaim: getenv("EFFIGENT_OIDC_USER_CLAIM"), EmailClaim: getenv("EFFIGENT_OIDC_EMAIL_CLAIM"),
		NameClaim: getenv("EFFIGENT_OIDC_NAME_CLAIM"), GroupsClaim: getenv("EFFIGENT_OIDC_GROUPS_CLAIM"),
		AdminGroups: list("EFFIGENT_OIDC_ADMIN_GROUPS"), SecurityAdminGroups: list("EFFIGENT_OIDC_SECURITY_ADMIN_GROUPS"),
		AdminEmails: list("EFFIGENT_OIDC_ADMIN_EMAILS"), AllowedGroups: list("EFFIGENT_OIDC_ALLOWED_GROUPS"),
		AllowUnverifiedEmail: getenv("EFFIGENT_OIDC_ALLOW_UNVERIFIED_EMAIL") == "1",
	}
	if o.Audience == "" {
		o.Audience = strings.TrimSpace(getenv("EFFIGENT_OIDC_CLIENT_ID"))
	}
	if o.Audience == "" {
		return nil, errors.New("EFFIGENT_OIDC_ISSUER needs EFFIGENT_OIDC_AUDIENCE (the console's OIDC client id)")
	}
	if o.Tenant == "" {
		o.Tenant = "org:self-hosted"
	}
	return o, o.validate()
}

func (o *OIDCOptions) validate() error {
	if kind, id, ok := strings.Cut(o.Tenant, ":"); !ok || (kind != "org" && kind != "user") || id == "" {
		return fmt.Errorf("EFFIGENT_OIDC_TENANT %q must look like org:<name>", o.Tenant)
	}
	if !strings.HasPrefix(o.Issuer, "https://") && !strings.HasPrefix(o.Issuer, "http://") {
		return fmt.Errorf("EFFIGENT_OIDC_ISSUER %q must be an http(s) URL", o.Issuer)
	}
	return nil
}

// oidcAuth verifies tokens from one issuer. Discovery is lazy and retried, so
// a control plane that starts before its identity provider still comes up.
type oidcAuth struct {
	o OIDCOptions

	mu       sync.Mutex
	jwks     keyfunc.Keyfunc
	tried    time.Time
	lastErr  error
	baseCtx  context.Context
	adminSet map[string]bool
}

// OIDC accepts these; never HMAC or "none".
var oidcAlgs = []string{"RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"}

func newOIDCAuth(ctx context.Context, o OIDCOptions) (*oidcAuth, error) {
	if err := o.validate(); err != nil {
		return nil, err
	}
	for _, p := range []*string{&o.UserClaim, &o.EmailClaim, &o.NameClaim, &o.GroupsClaim} {
		*p = strings.TrimSpace(*p)
	}
	o.UserClaim, o.EmailClaim = cmpOr(o.UserClaim, "sub"), cmpOr(o.EmailClaim, "email")
	o.NameClaim, o.GroupsClaim = cmpOr(o.NameClaim, "name"), cmpOr(o.GroupsClaim, "groups")
	if o.HTTP == nil {
		o.HTTP = &http.Client{Timeout: 10 * time.Second}
	}
	a := &oidcAuth{o: o, baseCtx: ctx, adminSet: map[string]bool{}}
	for _, e := range o.AdminEmails {
		a.adminSet[strings.ToLower(e)] = true
	}
	_ = a.keys() // first attempt now; failures are retried on use
	return a, nil
}

func (a *oidcAuth) keys() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.jwks != nil {
		return nil
	}
	if time.Since(a.tried) < 10*time.Second && !a.tried.IsZero() {
		return a.lastErr
	}
	a.tried = time.Now()
	jwksURL := a.o.JWKSURL
	if jwksURL == "" {
		u, err := a.discover()
		if err != nil {
			a.lastErr = err
			return err
		}
		jwksURL = u
	}
	k, err := keyfunc.NewDefaultCtx(a.baseCtx, []string{jwksURL})
	if err != nil {
		a.lastErr = fmt.Errorf("oidc keys %s: %w", jwksURL, err)
		return a.lastErr
	}
	a.jwks, a.lastErr = k, nil
	return nil
}

func (a *oidcAuth) discover() (string, error) {
	u := strings.TrimSuffix(a.o.Issuer, "/") + "/.well-known/openid-configuration"
	ctx, cancel := context.WithTimeout(a.baseCtx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	res, err := a.o.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("oidc discovery: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("oidc discovery %s answered %d", u, res.StatusCode)
	}
	var doc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&doc); err != nil {
		return "", fmt.Errorf("oidc discovery: %w", err)
	}
	if doc.Issuer != a.o.Issuer {
		return "", fmt.Errorf("oidc discovery: issuer is %q, configured %q (they must match exactly)", doc.Issuer, a.o.Issuer)
	}
	if doc.JWKSURI == "" {
		return "", errors.New("oidc discovery: no jwks_uri")
	}
	return doc.JWKSURI, nil
}

// peekIssuer reads a JWT's "iss" without verifying it, to pick the verifier.
func peekIssuer(tok string) string {
	var c jwt.RegisteredClaims
	if _, _, err := jwt.NewParser().ParseUnverified(tok, &c); err != nil {
		return ""
	}
	return c.Issuer
}

func (a *oidcAuth) authenticate(tok string) (Principal, error) {
	if err := a.keys(); err != nil {
		return Principal{}, errors.New("the identity provider's signing keys aren't available yet; try again shortly")
	}
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(tok, claims, a.jwks.Keyfunc,
		jwt.WithIssuer(a.o.Issuer), jwt.WithAudience(a.o.Audience), jwt.WithValidMethods(oidcAlgs),
		jwt.WithExpirationRequired(), jwt.WithLeeway(30*time.Second))
	if err != nil {
		return Principal{}, errors.New("invalid session token")
	}
	user := claimString(claims, a.o.UserClaim)
	if user == "" {
		return Principal{}, errors.New("invalid session token")
	}
	email := strings.ToLower(claimString(claims, a.o.EmailClaim))
	verified := a.o.AllowUnverifiedEmail
	if v, ok := claims["email_verified"].(bool); ok {
		verified = v
	} else if s, ok := claims["email_verified"].(string); ok { // some providers send "true"
		verified = s == "true"
	}
	if !verified {
		email = ""
	}
	groups := claimStrings(claims, a.o.GroupsClaim)
	in := func(list []string) bool {
		for _, g := range groups {
			if slices.Contains(list, g) {
				return true
			}
		}
		return false
	}
	role := "member"
	switch {
	case in(a.o.AdminGroups) || (email != "" && a.adminSet[email]):
		role = "admin"
	case in(a.o.SecurityAdminGroups):
		role = "security_admin"
	}
	if len(a.o.AllowedGroups) > 0 && role == "member" && !in(a.o.AllowedGroups) {
		return Principal{}, errors.New("your account isn't in a group allowed to use this console; ask your identity admin")
	}
	return Principal{UserID: user, Tenant: a.o.Tenant, Role: role, Via: "oidc", Email: email,
		Name: clip(claimString(claims, a.o.NameClaim), 120), Groups: groups}, nil
}

// claimString reads a claim; a dotted name walks nested objects
// ("realm_access.roles" style claims are lists: see claimStrings).
func claimString(c jwt.MapClaims, name string) string {
	switch v := claimAt(c, name).(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return fmt.Sprint(int64(v))
	}
	return ""
}

func claimStrings(c jwt.MapClaims, name string) []string {
	var out []string
	switch v := claimAt(c, name).(type) {
	case string:
		for _, x := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
			out = append(out, x)
		}
	case []any:
		for _, x := range v {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	}
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

func claimAt(c jwt.MapClaims, name string) any {
	if v, ok := c[name]; ok {
		return v
	}
	var cur any = map[string]any(c)
	for _, part := range strings.Split(name, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[part]
	}
	return cur
}
