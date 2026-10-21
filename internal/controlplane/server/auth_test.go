package server

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// testIssuer serves a JWKS (and an OIDC discovery document) for keys it
// signs tokens with, like Clerk or any OIDC provider.
type testIssuer struct {
	srv *httptest.Server
	rsa *rsa.PrivateKey
	ec  *ecdsa.PrivateKey
}

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	ti := &testIssuer{}
	var err error
	if ti.rsa, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
		t.Fatal(err)
	}
	if ti.ec, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		pad := func(b []byte) []byte { out := make([]byte, 32); copy(out[32-len(b):], b); return out }
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{
			{"kty": "RSA", "kid": "rsa1", "use": "sig", "alg": "RS256", "n": b64u(ti.rsa.N.Bytes()), "e": b64u(big.NewInt(int64(ti.rsa.E)).Bytes())},
			{"kty": "EC", "kid": "ec1", "use": "sig", "alg": "ES256", "crv": "P-256", "x": b64u(pad(ti.ec.X.Bytes())), "y": b64u(pad(ti.ec.Y.Bytes()))},
		}})
	})
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": ti.srv.URL, "jwks_uri": ti.srv.URL + "/.well-known/jwks.json"})
	})
	ti.srv = httptest.NewServer(mux)
	t.Cleanup(ti.srv.Close)
	return ti
}

// sign mints a token; alg "RS256" (default) or "ES256".
func (ti *testIssuer) sign(t *testing.T, alg string, claims jwt.MapClaims) string {
	t.Helper()
	var m jwt.SigningMethod = jwt.SigningMethodRS256
	var key crypto.Signer = ti.rsa
	kid := "rsa1"
	if alg == "ES256" {
		m, key, kid = jwt.SigningMethodES256, ti.ec, "ec1"
	}
	tok := jwt.NewWithClaims(m, claims)
	tok.Header["kid"] = kid
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func bearer(tok string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	return r
}

// TestClerkAuth pins how Clerk session tokens become principals (the SaaS
// path): any change here changes who gets which workspace.
func TestClerkAuth(t *testing.T) {
	ti := newTestIssuer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := NewAuthenticator(ctx, Options{ClerkIssuer: ti.srv.URL + "/", AuthorizedParties: []string{"https://app.effigent.ai"}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	base := func(extra jwt.MapClaims) jwt.MapClaims {
		c := jwt.MapClaims{"iss": ti.srv.URL, "sub": "user_1", "azp": "https://app.effigent.ai", "exp": now.Add(time.Minute).Unix(), "iat": now.Unix()}
		for k, v := range extra {
			c[k] = v
		}
		return c
	}
	cases := []struct {
		name   string
		alg    string
		claims jwt.MapClaims
		want   Principal
		err    string
	}{
		{name: "personal workspace", claims: base(nil), want: Principal{UserID: "user_1", Tenant: "user:user_1", Role: "admin", Via: "clerk"}},
		{name: "v1 org claims", claims: base(jwt.MapClaims{"org_id": "org_A", "org_role": "org:member"}), want: Principal{UserID: "user_1", Tenant: "org:org_A", Role: "member", Via: "clerk"}},
		{name: "v2 org claims", claims: base(jwt.MapClaims{"o": map[string]any{"id": "org_B", "rol": "security_admin"}}), want: Principal{UserID: "user_1", Tenant: "org:org_B", Role: "security_admin", Via: "clerk"}},
		{name: "v2 wins over v1", claims: base(jwt.MapClaims{"org_id": "org_A", "org_role": "org:admin", "o": map[string]any{"id": "org_B", "rol": "member"}}), want: Principal{UserID: "user_1", Tenant: "org:org_B", Role: "member", Via: "clerk"}},
		{name: "other console", claims: base(jwt.MapClaims{"azp": "https://evil.example"}), err: "session token was not issued for this console"},
		{name: "wrong issuer", claims: base(jwt.MapClaims{"iss": "https://other.example"}), err: "invalid session token"},
		{name: "expired", claims: base(jwt.MapClaims{"exp": now.Add(-time.Minute).Unix()}), err: "invalid session token"},
		{name: "no subject", claims: base(jwt.MapClaims{"sub": ""}), err: "invalid session token"},
		{name: "ES256 refused for Clerk", alg: "ES256", claims: base(nil), err: "invalid session token"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, err := a.Authenticate(bearer(ti.sign(t, c.alg, c.claims)))
			if c.err != "" {
				if err == nil || err.Error() != c.err {
					t.Fatalf("err = %v, want %q (principal %+v)", err, c.err, p)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if p.UserID != c.want.UserID || p.Tenant != c.want.Tenant || p.Role != c.want.Role || p.Via != c.want.Via || len(p.Scopes) != 0 {
				t.Fatalf("principal = %+v, want %+v", p, c.want)
			}
		})
	}
	if _, err := a.Authenticate(bearer("garbage")); err == nil || err.Error() != "invalid session token" {
		t.Fatalf("garbage token: %v", err)
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := a.Authenticate(r); err == nil || err.Error() != "missing bearer token" {
		t.Fatalf("no token: %v", err)
	}
}

func TestAdminTokenAuth(t *testing.T) {
	a, err := NewAuthenticator(context.Background(), Options{AdminToken: "devadmin", AdminTenants: []string{"org:dev"}})
	if err != nil {
		t.Fatal(err)
	}
	r := bearer("devadmin")
	r.Header.Set("X-Effigent-Tenant", "org:dev")
	if p, err := a.Authenticate(r); err != nil || !reflect.DeepEqual(p, Principal{UserID: "admin", Tenant: "org:dev", Role: "admin", Via: "admin-token"}) {
		t.Fatalf("%+v %v", p, err)
	}
	r.Header.Set("X-Effigent-Tenant", "org:other")
	if _, err := a.Authenticate(r); err == nil {
		t.Fatal("admin token accepted for a tenant it isn't enabled for")
	}
	if _, err := a.Authenticate(bearer("eyJhbGciOiJSUzI1NiJ9.e30.x")); err == nil || err.Error() != "invalid token" {
		t.Fatalf("no JWT issuer configured: %v", err)
	}
	if _, err := NewAuthenticator(context.Background(), Options{}); err == nil {
		t.Fatal("an authenticator with nothing configured")
	}
}
