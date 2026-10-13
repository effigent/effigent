package cpclient

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/shared/sign"
)

// A policy compiled for one machine must not be accepted by another machine
// of the same tenant (e.g. swapped into its offline cache).
func TestRefusesPolicyCompiledForAnotherEndpoint(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(nil)
	for _, tc := range []struct {
		endpoint string
		ok       bool
	}{{"ep-other", false}, {"ep-me", true}, {"", true}} {
		dir := t.TempDir()
		doc := sign.Sign(key, sign.Document{Tenant: "org:t", Endpoint: tc.endpoint, Version: 3, IssuedAt: time.Now(), Body: "defaults: {}"})
		b, _ := json.Marshal(doc)
		if err := os.WriteFile(policyPath(dir), b, 0o600); err != nil {
			t.Fatal(err)
		}
		applied := false
		c := &Client{Dir: dir, State: &State{EndpointID: "ep-me", Tenant: "org:t", ServerPublicKey: sign.EncodePublic(pub)},
			Apply: func(context.Context, []byte) error { applied = true; return nil }}
		err := c.LoadCached(context.Background())
		if tc.ok != (err == nil) || applied != tc.ok {
			t.Fatalf("endpoint %q: err=%v applied=%v", tc.endpoint, err, applied)
		}
		if !tc.ok && !strings.Contains(err.Error(), "compiled for endpoint ep-other") {
			t.Fatalf("unexpected error: %v", err)
		}
	}
}
