package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// Tenant secrets the control plane must use later (a Slack app's bot token
// and signing secret, AI vendors' admin API keys for Pricing Leaks) are sealed with AES-256-GCM under EFFIGENT_SECRETS_KEY,
// bound to the tenant and the field so a sealed value can't be moved to
// another tenant. The key is separate from the policy signing key so either
// can be rotated without the other; losing it means reconnecting Slack.

var (
	errNoSecretsKey      = errors.New("this control plane has no EFFIGENT_SECRETS_KEY, so it can't store Slack credentials")
	errNoSecretsKeySpend = errors.New("this control plane has no EFFIGENT_SECRETS_KEY, so it can't store vendor API keys; use CSV import instead")
)

// SecretsKeyFrom turns the EFFIGENT_SECRETS_KEY value (at least 32
// characters, e.g. `openssl rand -base64 48`) into an AES-256 key.
func SecretsKeyFrom(v string) ([]byte, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, nil
	}
	if len(v) < 32 {
		return nil, errors.New("EFFIGENT_SECRETS_KEY must be at least 32 characters (openssl rand -base64 48)")
	}
	k := sha256.Sum256([]byte("effigent-secrets\x00" + v))
	return k[:], nil
}

func (s *Server) gcm() (cipher.AEAD, error) {
	if len(s.SecretsKey) != 32 {
		return nil, errNoSecretsKey
	}
	b, err := aes.NewCipher(s.SecretsKey)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}

func (s *Server) seal(tenant, field, plain string) (string, error) {
	g, err := s.gcm()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := g.Seal(nonce, nonce, []byte(plain), []byte(tenant+"\x00"+field))
	return "v1:" + base64.RawStdEncoding.EncodeToString(ct), nil
}

func (s *Server) open(tenant, field, sealed string) (string, error) {
	g, err := s.gcm()
	if err != nil {
		return "", err
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(sealed, "v1:"))
	if !strings.HasPrefix(sealed, "v1:") || err != nil || len(raw) < g.NonceSize() {
		return "", errors.New("sealed secret is malformed")
	}
	plain, err := g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], []byte(tenant+"\x00"+field))
	if err != nil {
		return "", errors.New("sealed secret does not open (was EFFIGENT_SECRETS_KEY changed?)")
	}
	return string(plain), nil
}
