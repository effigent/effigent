// Package cloudtoken is the credential a cloud environment's hooks use
// (`effigentd hook <agent> --remote`): one string, kept in the vendor's
// secret store, that carries everything an enrollment would have left on
// disk — the control plane's address, the endpoint id and secret, the tenant
// and the policy signing key to pin. "efc_" + base64url(JSON).
package cloudtoken

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

const Prefix = "efc_"

// Token is a cloud environment's credentials.
type Token struct {
	Server          string `json:"s"`
	EndpointID      string `json:"e"`
	Tenant          string `json:"t"`
	Secret          string `json:"k"` // the endpoint secret (eps_…)
	ServerPublicKey string `json:"p"` // policy signing key, pinned
}

func Encode(t Token) string {
	b, _ := json.Marshal(t)
	return Prefix + base64.RawURLEncoding.EncodeToString(b)
}

var ErrInvalid = errors.New("not an Effigent cloud environment token (efc_…)")

func Decode(s string) (Token, error) {
	var t Token
	raw, ok := strings.CutPrefix(strings.TrimSpace(s), Prefix)
	if !ok || len(raw) > 4096 {
		return t, ErrInvalid
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(b, &t) != nil {
		return t, ErrInvalid
	}
	if t.Server == "" || t.EndpointID == "" || t.Tenant == "" || t.Secret == "" || t.ServerPublicKey == "" {
		return t, ErrInvalid
	}
	t.Server = strings.TrimSuffix(t.Server, "/")
	return t, nil
}
