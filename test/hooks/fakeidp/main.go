// fakeidp is a stand-in OpenID Connect issuer for the hook e2e scripts
// (test/hooks/approval.sh, remote.sh): approvals need a person since
// checklist #12, and the admin token isn't one. The control plane trusts it
// through EFFIGENT_OIDC_ISSUER like a self-hosted IdP (docs/self-hosting.md);
// the scripts fetch a signed ID token for their approver from /token.
//
//	fakeidp -listen 127.0.0.1:8099 -audience effigent-test
//	curl '127.0.0.1:8099/token?sub=u-sam&email=sam@example.test&name=Sam+Sec'
//
// Loopback only, a fresh key per run, every token verified-email. Never for
// anything but a local test control plane.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8099", "loopback address to serve on")
	audience := flag.String("audience", "effigent-test", "the tokens' aud (EFFIGENT_OIDC_AUDIENCE)")
	flag.Parse()
	if host, _, err := net.SplitHostPort(*listen); err != nil || !net.ParseIP(host).IsLoopback() {
		log.Fatalf("fakeidp: -listen must be a loopback address, got %q", *listen)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	issuer := "http://" + *listen
	b64 := base64.RawURLEncoding.EncodeToString
	pad := func(b []byte) []byte { out := make([]byte, 32); copy(out[32-len(b):], b); return out }

	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "jwks_uri": issuer + "/.well-known/jwks.json"})
	})
	mux.HandleFunc("GET /.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{"kty": "EC", "kid": "fake1", "use": "sig",
			"alg": "ES256", "crv": "P-256", "x": b64(pad(key.X.Bytes())), "y": b64(pad(key.Y.Bytes()))}}})
	})
	mux.HandleFunc("GET /token", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("sub") == "" {
			http.Error(w, "sub is required", http.StatusBadRequest)
			return
		}
		now := time.Now()
		claims := jwt.MapClaims{"iss": issuer, "aud": *audience, "sub": q.Get("sub"), "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
		if e := q.Get("email"); e != "" {
			claims["email"], claims["email_verified"] = e, true
		}
		if n := q.Get("name"); n != "" {
			claims["name"] = n
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
		tok.Header["kid"] = "fake1"
		s, err := tok.SignedString(key)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(s))
	})
	log.Printf("fakeidp: issuer %s", issuer)
	log.Fatal(http.ListenAndServe(*listen, mux))
}
