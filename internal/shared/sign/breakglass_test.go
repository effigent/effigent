package sign

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"
)

func testKey(t *testing.T) (ed25519.PrivateKey, ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv, pub
}

func nonce(t *testing.T) []byte {
	t.Helper()
	b := make([]byte, bgNonceLen)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestBreakGlassRoundTrip(t *testing.T) {
	priv, pub := testKey(t)
	exp := time.Now().Add(time.Hour).Truncate(time.Minute)
	code, id, err := EncodeBreakGlass(priv, "org:acme", "ep_123", exp, nonce(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != bgNonceLen*2 {
		t.Fatalf("id %q", id)
	}
	g, err := DecodeBreakGlass(pub, "org:acme", "ep_123", code)
	if err != nil {
		t.Fatal(err)
	}
	if g.Tenant != "org:acme" || g.Endpoint != "ep_123" || g.AllMachines {
		t.Fatalf("grant %+v", g)
	}
	if !g.Expiry.Equal(exp) {
		t.Fatalf("expiry %v != %v", g.Expiry, exp)
	}
	if g.ID != id {
		t.Fatalf("id %q != %q", g.ID, id)
	}
}

func TestBreakGlassAllMachines(t *testing.T) {
	priv, pub := testKey(t)
	exp := time.Now().Add(time.Hour)
	code, _, err := EncodeBreakGlass(priv, "org:acme", AllMachines, exp, nonce(t))
	if err != nil {
		t.Fatal(err)
	}
	// Any machine of the tenant can verify an all-machines grant.
	for _, ep := range []string{"ep_1", "ep_2", "whatever"} {
		g, err := DecodeBreakGlass(pub, "org:acme", ep, code)
		if err != nil {
			t.Fatalf("ep %s: %v", ep, err)
		}
		if !g.AllMachines || g.Endpoint != AllMachines {
			t.Fatalf("ep %s: grant %+v", ep, g)
		}
	}
}

func TestBreakGlassMachineSpecificRejectsOtherMachine(t *testing.T) {
	priv, pub := testKey(t)
	code, _, _ := EncodeBreakGlass(priv, "org:acme", "ep_123", time.Now().Add(time.Hour), nonce(t))
	if _, err := DecodeBreakGlass(pub, "org:acme", "ep_999", code); err != ErrBadSignature {
		t.Fatalf("other machine: want ErrBadSignature, got %v", err)
	}
}

func TestBreakGlassWrongTenant(t *testing.T) {
	priv, pub := testKey(t)
	code, _, _ := EncodeBreakGlass(priv, "org:acme", "ep_123", time.Now().Add(time.Hour), nonce(t))
	if _, err := DecodeBreakGlass(pub, "org:evil", "ep_123", code); err != ErrBadSignature {
		t.Fatalf("other tenant: want ErrBadSignature, got %v", err)
	}
}

func TestBreakGlassWrongKey(t *testing.T) {
	priv, _ := testKey(t)
	_, otherPub := testKey(t)
	code, _, _ := EncodeBreakGlass(priv, "org:acme", "ep_123", time.Now().Add(time.Hour), nonce(t))
	if _, err := DecodeBreakGlass(otherPub, "org:acme", "ep_123", code); err != ErrBadSignature {
		t.Fatalf("other key: want ErrBadSignature, got %v", err)
	}
}

func TestBreakGlassNotConfusedWithPolicyDoc(t *testing.T) {
	// A break-glass code and a policy Document use disjoint signed domains:
	// neither signature can verify as the other.
	priv, pub := testKey(t)
	code, _, _ := EncodeBreakGlass(priv, "org:acme", "ep_123", time.Now().Add(time.Hour), nonce(t))
	raw, err := decode32(code)
	if err != nil {
		t.Fatal(err)
	}
	// Feed the break-glass signature bytes into a Document and verify: must fail.
	d := Document{Tenant: "org:acme", Version: 1, Body: "x", Signature: encode32(raw[bgHeaderLen:])}
	if err := Verify(pub, "org:acme", d); err == nil {
		t.Fatal("break-glass signature verified as a policy document")
	}
}

func TestBreakGlassGarbage(t *testing.T) {
	_, pub := testKey(t)
	for _, c := range []string{"", "not-a-code", strings.Repeat("A", 200)} {
		if _, err := DecodeBreakGlass(pub, "org:acme", "ep_123", c); err == nil {
			t.Fatalf("garbage %q verified", c)
		}
	}
}

func TestBase32RoundTrip(t *testing.T) {
	for _, n := range []int{1, 2, 5, 8, 78, 100} {
		b := make([]byte, n)
		rand.Read(b)
		s := encode32(b)
		got, err := decode32(s)
		if err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		if len(got) != n {
			t.Fatalf("n=%d: got %d bytes", n, len(got))
		}
		for i := range b {
			if got[i] != b[i] {
				t.Fatalf("n=%d byte %d: %x != %x", n, i, got[i], b[i])
			}
		}
	}
	// Crockford aliases and lower case decode the same.
	b := make([]byte, 10)
	rand.Read(b)
	s := encode32(b)
	low, _ := decode32(strings.ToLower(s))
	up, _ := decode32(s)
	if string(low) != string(up) {
		t.Fatal("case sensitivity")
	}
}

func TestValidBreakGlassDuration(t *testing.T) {
	if _, err := ValidBreakGlassDuration(30 * time.Second); err == nil {
		t.Fatal("too short accepted")
	}
	if _, err := ValidBreakGlassDuration(9 * time.Hour); err == nil {
		t.Fatal("too long accepted")
	}
	if _, err := ValidBreakGlassDuration(2 * time.Hour); err != nil {
		t.Fatalf("2h: %v", err)
	}
}
