// Package sign signs and verifies policy documents sent from the control plane
// to endpoints. Endpoints pin the control plane's public key at enrollment,
// reject anything not signed by it, and never accept an older version than the
// one they already run (no downgrade, FR-28).
package sign

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// Document is a signed policy version for one tenant. Endpoint is set when
// the body was compiled for one machine (central policies scoped to users and
// teams): another machine of the same tenant must not accept it, or a lax
// body could be swapped into a strict machine's cache.
type Document struct {
	Tenant    string    `json:"tenant"`
	Endpoint  string    `json:"endpoint,omitempty"`
	Version   int64     `json:"version"`
	IssuedAt  time.Time `json:"issued_at"`
	Body      string    `json:"body"`
	Signature string    `json:"signature,omitempty"`
}

func (d Document) payload() []byte {
	d.Signature = ""
	b, _ := json.Marshal(d)
	return b
}

func Sign(key ed25519.PrivateKey, d Document) Document {
	d.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(key, d.payload()))
	return d
}

var ErrBadSignature = errors.New("policy signature does not verify")

// Verify checks the signature and that the document is for the expected tenant.
func Verify(pub ed25519.PublicKey, tenant string, d Document) error {
	sig, err := base64.StdEncoding.DecodeString(d.Signature)
	if err != nil || !ed25519.Verify(pub, d.payload(), sig) {
		return ErrBadSignature
	}
	if d.Tenant != tenant {
		return fmt.Errorf("policy is for tenant %q, endpoint belongs to %q", d.Tenant, tenant)
	}
	return nil
}

// LoadOrCreateKey reads a base64 ed25519 seed from the env var or file, or
// creates the file with a fresh key when neither exists.
func LoadOrCreateKey(envValue, file string) (ed25519.PrivateKey, error) {
	if envValue != "" {
		return parseSeed(envValue)
	}
	if b, err := os.ReadFile(file); err == nil {
		return parseSeed(string(b))
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(file, []byte(base64.StdEncoding.EncodeToString(priv.Seed())), 0o600); err != nil {
		return nil, err
	}
	return priv, nil
}

func parseSeed(s string) (ed25519.PrivateKey, error) {
	seed, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("signing key must be a base64 32-byte ed25519 seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func EncodePublic(pub ed25519.PublicKey) string { return base64.StdEncoding.EncodeToString(pub) }

func DecodePublic(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("invalid public key")
	}
	return ed25519.PublicKey(b), nil
}
