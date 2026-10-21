package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/golang-jwt/jwt/v5"
)

func TestOIDCOptionsFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if o, err := OIDCOptionsFromEnv(env(nil)); o != nil || err != nil {
		t.Fatalf("unset: %+v %v", o, err)
	}
	if _, err := OIDCOptionsFromEnv(env(map[string]string{"EFFIGENT_OIDC_ISSUER": "https://idp"})); err == nil {
		t.Fatal("issuer without audience accepted")
	}
	o, err := OIDCOptionsFromEnv(env(map[string]string{"EFFIGENT_OIDC_ISSUER": "https://idp", "EFFIGENT_OIDC_CLIENT_ID": "console",
		"EFFIGENT_OIDC_ADMIN_GROUPS": "sec-admins, platform ", "EFFIGENT_OIDC_ADMIN_EMAILS": "a@x.io"}))
	if err != nil || o.Audience != "console" || o.Tenant != "org:self-hosted" || !reflect.DeepEqual(o.AdminGroups, []string{"sec-admins", "platform"}) {
		t.Fatalf("%+v %v", o, err)
	}
	if _, err := OIDCOptionsFromEnv(env(map[string]string{"EFFIGENT_OIDC_ISSUER": "https://idp", "EFFIGENT_OIDC_AUDIENCE": "c", "EFFIGENT_OIDC_TENANT": "acme"})); err == nil {
		t.Fatal("tenant without org: accepted")
	}
}

func TestOIDCAuth(t *testing.T) {
	ti := newTestIssuer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := NewAuthenticator(ctx, Options{OIDC: &OIDCOptions{Issuer: ti.srv.URL, Audience: "console", Tenant: "org:acme",
		AdminGroups: []string{"effigent-admins"}, SecurityAdminGroups: []string{"secops"}, AdminEmails: []string{"Boss@Acme.io"}}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tok := func(alg string, extra jwt.MapClaims) string {
		c := jwt.MapClaims{"iss": ti.srv.URL, "aud": "console", "sub": "u-1", "email": "Dev@Acme.io", "email_verified": true,
			"name": "Dev One", "exp": now.Add(time.Minute).Unix(), "iat": now.Unix()}
		for k, v := range extra {
			if v == nil {
				delete(c, k)
			} else {
				c[k] = v
			}
		}
		return ti.sign(t, alg, c)
	}
	cases := []struct {
		name  string
		tok   string
		role  string
		email string
		err   string
	}{
		{name: "member", tok: tok("", nil), role: "member", email: "dev@acme.io"},
		{name: "ES256", tok: tok("ES256", nil), role: "member", email: "dev@acme.io"},
		{name: "admin group", tok: tok("", jwt.MapClaims{"groups": []any{"eng", "effigent-admins"}}), role: "admin", email: "dev@acme.io"},
		{name: "security admin group", tok: tok("", jwt.MapClaims{"groups": []any{"secops"}}), role: "security_admin", email: "dev@acme.io"},
		{name: "admin group wins", tok: tok("", jwt.MapClaims{"groups": []any{"secops", "effigent-admins"}}), role: "admin", email: "dev@acme.io"},
		{name: "admin email", tok: tok("", jwt.MapClaims{"email": "boss@acme.io"}), role: "admin", email: "boss@acme.io"},
		{name: "unverified admin email is no admin", tok: tok("", jwt.MapClaims{"email": "boss@acme.io", "email_verified": false}), role: "member", email: ""},
		{name: "no email_verified claim", tok: tok("", jwt.MapClaims{"email_verified": nil}), role: "member", email: ""},
		{name: "audience list", tok: tok("", jwt.MapClaims{"aud": []any{"other", "console"}}), role: "member", email: "dev@acme.io"},
		{name: "other audience", tok: tok("", jwt.MapClaims{"aud": "other"}), err: "invalid session token"},
		{name: "expired", tok: tok("", jwt.MapClaims{"exp": now.Add(-2 * time.Minute).Unix()}), err: "invalid session token"},
		{name: "no expiry", tok: tok("", jwt.MapClaims{"exp": nil}), err: "invalid session token"},
		{name: "no subject", tok: tok("", jwt.MapClaims{"sub": nil}), err: "invalid session token"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, err := a.Authenticate(bearer(c.tok))
			if c.err != "" {
				if err == nil || err.Error() != c.err {
					t.Fatalf("err = %v, want %q (%+v)", err, c.err, p)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if p.Tenant != "org:acme" || p.UserID != "u-1" || p.Via != "oidc" || p.Role != c.role || p.Email != c.email || p.Name != "Dev One" {
				t.Fatalf("principal %+v, want role %s email %q", p, c.role, c.email)
			}
		})
	}
	// HS256 signed with the public key as a secret: the classic alg confusion.
	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"iss": ti.srv.URL, "aud": "console", "sub": "u-1", "exp": now.Add(time.Minute).Unix()})
	hs.Header["kid"] = "rsa1"
	s, _ := hs.SignedString(ti.rsa.PublicKey.N.Bytes())
	if _, err := a.Authenticate(bearer(s)); err == nil {
		t.Fatal("HS256 token accepted")
	}
	// another issuer's token, signed with the right key: refused
	other := ti.sign(t, "", jwt.MapClaims{"iss": "https://evil.example", "aud": "console", "sub": "u-1", "exp": now.Add(time.Minute).Unix()})
	if _, err := a.Authenticate(bearer(other)); err == nil {
		t.Fatal("token from another issuer accepted")
	}
}

func TestOIDCAllowedGroupsAndClaims(t *testing.T) {
	ti := newTestIssuer(t)
	a, err := NewAuthenticator(context.Background(), Options{OIDC: &OIDCOptions{Issuer: ti.srv.URL, Audience: "console", Tenant: "org:acme",
		UserClaim: "oid", EmailClaim: "upn", GroupsClaim: "realm_access.roles", AllowUnverifiedEmail: true,
		AdminGroups: []string{"admins"}, AllowedGroups: []string{"effigent-users"}}})
	if err != nil {
		t.Fatal(err)
	}
	mk := func(roles ...any) string {
		return ti.sign(t, "", jwt.MapClaims{"iss": ti.srv.URL, "aud": "console", "sub": "ignored", "oid": "obj-9", "upn": "Ana@Acme.io",
			"realm_access": map[string]any{"roles": roles}, "exp": time.Now().Add(time.Minute).Unix()})
	}
	if _, err := a.Authenticate(bearer(mk("eng"))); err == nil || !strings.Contains(err.Error(), "allowed") {
		t.Fatalf("user outside the allowed groups: %v", err)
	}
	p, err := a.Authenticate(bearer(mk("effigent-users")))
	if err != nil || p.UserID != "obj-9" || p.Email != "ana@acme.io" || p.Role != "member" {
		t.Fatalf("%+v %v", p, err)
	}
	if p, err := a.Authenticate(bearer(mk("admins"))); err != nil || p.Role != "admin" {
		t.Fatalf("an admin outside the allowed groups: %+v %v", p, err)
	}
}

// Clerk and an OIDC issuer side by side: each token goes to its own issuer,
// and a Clerk token's principal is exactly what it was without OIDC.
func TestClerkAndOIDCTogether(t *testing.T) {
	clerk, idp := newTestIssuer(t), newTestIssuer(t)
	a, err := NewAuthenticator(context.Background(), Options{ClerkIssuer: clerk.srv.URL, OIDC: &OIDCOptions{Issuer: idp.srv.URL, Audience: "console", Tenant: "org:acme"}})
	if err != nil {
		t.Fatal(err)
	}
	exp := time.Now().Add(time.Minute).Unix()
	p, err := a.Authenticate(bearer(clerk.sign(t, "", jwt.MapClaims{"iss": clerk.srv.URL, "sub": "user_1", "org_id": "org_A", "org_role": "org:admin", "exp": exp})))
	if err != nil || !reflect.DeepEqual(p, Principal{UserID: "user_1", Tenant: "org:org_A", Role: "admin", Via: "clerk"}) {
		t.Fatalf("clerk: %+v %v", p, err)
	}
	p, err = a.Authenticate(bearer(idp.sign(t, "", jwt.MapClaims{"iss": idp.srv.URL, "aud": "console", "sub": "u", "exp": exp})))
	if err != nil || p.Via != "oidc" || p.Tenant != "org:acme" {
		t.Fatalf("oidc: %+v %v", p, err)
	}
	// a token claiming the OIDC issuer but signed by Clerk's key
	if _, err := a.Authenticate(bearer(clerk.sign(t, "", jwt.MapClaims{"iss": idp.srv.URL, "aud": "console", "sub": "u", "exp": exp}))); err == nil {
		t.Fatal("OIDC token signed with the wrong key accepted")
	}
}

// The provider may come up after the control plane: discovery is retried.
func TestOIDCLateProvider(t *testing.T) {
	var up bool
	ti := newTestIssuer(t)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		if r.URL.Path == "/.well-known/openid-configuration" {
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": ti.srv.URL, "jwks_uri": ti.srv.URL + "/.well-known/jwks.json"})
		}
	}))
	defer proxy.Close()
	oa, err := newOIDCAuth(context.Background(), OIDCOptions{Issuer: ti.srv.URL, Audience: "console", Tenant: "org:acme"})
	if err != nil {
		t.Fatal(err)
	}
	if oa.jwks == nil {
		t.Fatal("discovery against a live provider didn't load keys")
	}
	late, _ := newOIDCAuth(context.Background(), OIDCOptions{Issuer: proxy.URL, Audience: "console", Tenant: "org:acme"})
	if late.jwks != nil || late.lastErr == nil {
		t.Fatal("keys from a provider that is down")
	}
	up = true
	late.tried = time.Time{} // skip the 10s retry wait
	// discovery says the issuer is ti's, not the proxy's: refused
	if err := late.keys(); err == nil || !strings.Contains(err.Error(), "must match") {
		t.Fatalf("issuer mismatch: %v", err)
	}
}

// TestOIDCConsoleUsers: sign-ins are remembered (cp.console_users), listed by
// GET /api/v1/members and answer the approver checks. Needs a database.
func TestOIDCConsoleUsers(t *testing.T) {
	url := testDatabaseURL(t)
	ctx := context.Background()
	st, err := store.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	ti := newTestIssuer(t)
	tenant := fmt.Sprintf("org:oidc-%d-%d", os.Getpid(), time.Now().UnixNano())
	a, err := NewAuthenticator(ctx, Options{OIDC: &OIDCOptions{Issuer: ti.srv.URL, Audience: "console", Tenant: tenant, AdminGroups: []string{"admins"}}})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: st, Auth: a, Logf: t.Logf}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	get := func(tok, path string, out any) int {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if out != nil {
			_ = json.NewDecoder(res.Body).Decode(out)
		}
		return res.StatusCode
	}
	exp := time.Now().Add(time.Minute).Unix()
	admin := ti.sign(t, "", jwt.MapClaims{"iss": ti.srv.URL, "aud": "console", "sub": "u-admin", "email": "Admin@Acme.io", "email_verified": true, "name": "Ada", "groups": []any{"admins"}, "exp": exp})
	dev := ti.sign(t, "", jwt.MapClaims{"iss": ti.srv.URL, "aud": "console", "sub": "u-dev", "email": "dev@acme.io", "email_verified": true, "exp": exp})
	var me Principal
	if code := get(admin, "/api/v1/me", &me); code != 200 || me.Role != "admin" || me.Email != "admin@acme.io" || me.Via != "oidc" || me.Tenant != tenant {
		t.Fatalf("me: %d %+v", code, me)
	}
	if code := get(dev, "/api/v1/me", &me); code != 200 || me.Role != "member" {
		t.Fatalf("me (dev): %d %+v", code, me)
	}
	var m struct {
		Members []store.ConsoleUser `json:"members"`
	}
	if code := get(dev, "/api/v1/members", &m); code != 200 || len(m.Members) != 2 {
		t.Fatalf("members: %d %+v", code, m)
	}
	d := &StoreDirectory{Store: st}
	if r, err := d.MemberRole(ctx, tenant, "ADMIN@acme.io"); err != nil || r != "admin" {
		t.Fatalf("MemberRole admin: %q %v", r, err)
	}
	if r, _ := d.MemberRole(ctx, tenant, "nobody@acme.io"); r != "" {
		t.Fatalf("MemberRole stranger: %q", r)
	}
	if r, _ := d.MemberRole(ctx, "org:other", "admin@acme.io"); r != "" {
		t.Fatalf("MemberRole in another tenant: %q", r)
	}
	if es, err := d.UserEmails(ctx, tenant, "u-dev"); err != nil || !reflect.DeepEqual(es, []string{"dev@acme.io"}) {
		t.Fatalf("UserEmails: %v %v", es, err)
	}
	// a write needs an admin role from the token
	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/enrollment-tokens", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+dev)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("member wrote: %v %v", res.StatusCode, err)
	}
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/enrollment-tokens", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+admin)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusCreated {
		t.Fatalf("admin enrollment token: %v %v", res.StatusCode, err)
	}
}
