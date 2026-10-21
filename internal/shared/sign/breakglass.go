package sign

// Break-glass codes let an admin lift a machine's approval lists for a short
// window while the control plane is unreachable (FR Q18). The control plane
// signs a grant with the tenant's existing ed25519 key; the admin reads the
// code to the user, who types `effigentd break-glass <code>` on the machine.
// effigentd verifies it against the public key pinned at enrollment — no
// network needed.
//
// The code is a compact, self-contained signed payload. The machine identity
// is implicit, never carried in the code: a machine-specific grant verifies
// only on the machine whose endpoint id the control plane signed over (every
// other machine reconstructs a different message and the signature fails); an
// all-machines grant verifies on any machine of the tenant. That keeps the
// code short — an ed25519 signature is 64 bytes, and nothing else has to be.

import (
	"crypto/ed25519"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"
)

// breakGlassDomain separates a break-glass message from a policy Document, so
// a signature over one can never verify as the other.
const breakGlassDomain = "effigent-break-glass-v1"

// AllMachines is the endpoint value of a grant that any machine of the tenant
// may use.
const AllMachines = "*"

const (
	bgVersion     = 1
	bgFlagAll     = 1 // bit 0: the grant is for all machines
	bgNonceLen    = 8
	bgHeaderLen   = 1 + 1 + 4 + bgNonceLen // version, flags, expiry (unix minutes), nonce
	bgCodeLen     = bgHeaderLen + ed25519.SignatureSize
	bgMinDuration = time.Minute
	// BreakGlassMaxDuration caps how long a break-glass window can last.
	BreakGlassMaxDuration = 8 * time.Hour
)

// Grant is a decoded, verified break-glass authorization.
type Grant struct {
	Tenant      string
	Endpoint    string // an endpoint id, or AllMachines
	AllMachines bool
	Expiry      time.Time
	// ID is the grant's nonce in hex: its identifier in the control plane and
	// in the daemon's single-use record.
	ID string
}

// bgMessage is the exact byte string the signature covers. Everything in it
// except the header (expiry, nonce, flags) is reconstructed locally from the
// endpoint's own state, so it never travels in the code.
func bgMessage(tenant, endpoint string, header []byte) []byte {
	var m []byte
	m = append(m, breakGlassDomain...)
	m = append(m, 0)
	m = append(m, tenant...)
	m = append(m, 0)
	m = append(m, endpoint...)
	m = append(m, 0)
	m = append(m, header...) // version, flags, expiry, nonce
	return m
}

// EncodeBreakGlass signs a grant and returns its code and id (nonce hex). The
// control plane stores the id, never the code. nonce must be bgNonceLen bytes.
func EncodeBreakGlass(key ed25519.PrivateKey, tenant, endpoint string, expiry time.Time, nonce []byte) (code, id string, err error) {
	if len(nonce) != bgNonceLen {
		return "", "", fmt.Errorf("break-glass nonce must be %d bytes", bgNonceLen)
	}
	all := endpoint == "" || endpoint == AllMachines
	ep := endpoint
	flags := byte(0)
	if all {
		ep, flags = AllMachines, bgFlagAll
	}
	header := make([]byte, bgHeaderLen)
	header[0] = bgVersion
	header[1] = flags
	binary.BigEndian.PutUint32(header[2:6], uint32(expiry.Unix()/60))
	copy(header[6:], nonce)
	sig := ed25519.Sign(key, bgMessage(tenant, ep, header))
	return encode32(append(header, sig...)), encodeHex(nonce), nil
}

// DecodeBreakGlass verifies a code against the pinned public key. tenant and
// endpointID are the machine's own identity, used to reconstruct the signed
// message. It checks the signature only; the caller checks expiry and
// single-use (the daemon records used nonces).
func DecodeBreakGlass(pub ed25519.PublicKey, tenant, endpointID, code string) (Grant, error) {
	raw, err := decode32(code)
	if err != nil {
		return Grant{}, errors.New("break-glass code is not valid")
	}
	if len(raw) != bgCodeLen {
		return Grant{}, errors.New("break-glass code has the wrong length")
	}
	if raw[0] != bgVersion {
		return Grant{}, fmt.Errorf("break-glass code version %d is not supported by this effigentd", raw[0])
	}
	all := raw[1]&bgFlagAll != 0
	ep := endpointID
	if all {
		ep = AllMachines
	}
	header, sig := raw[:bgHeaderLen], raw[bgHeaderLen:]
	if !ed25519.Verify(pub, bgMessage(tenant, ep, header), sig) {
		return Grant{}, ErrBadSignature
	}
	exp := time.Unix(int64(binary.BigEndian.Uint32(header[2:6]))*60, 0)
	return Grant{Tenant: tenant, Endpoint: ep, AllMachines: all, Expiry: exp, ID: encodeHex(header[6 : 6+bgNonceLen])}, nil
}

// ValidBreakGlassDuration clamps a requested window to [1 minute, 8 hours].
func ValidBreakGlassDuration(d time.Duration) (time.Duration, error) {
	if d < bgMinDuration {
		return 0, fmt.Errorf("break-glass duration must be at least %s", bgMinDuration)
	}
	if d > BreakGlassMaxDuration {
		return 0, fmt.Errorf("break-glass duration must be at most %s", BreakGlassMaxDuration)
	}
	return d, nil
}

// ---- compact encodings (no external deps) ----

const crock = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford base32

// encode32 renders bytes as grouped Crockford base32 (hyphen every 5 chars).
func encode32(b []byte) string {
	var sb strings.Builder
	var buf, bits uint32
	n := 0
	emit := func(c byte) {
		if n > 0 && n%5 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(c)
		n++
	}
	for _, x := range b {
		buf = buf<<8 | uint32(x)
		bits += 8
		for bits >= 5 {
			bits -= 5
			emit(crock[(buf>>bits)&0x1f])
		}
	}
	if bits > 0 {
		emit(crock[(buf<<(5-bits))&0x1f])
	}
	return sb.String()
}

var crockRev = func() map[byte]uint32 {
	m := map[byte]uint32{}
	for i := 0; i < len(crock); i++ {
		m[crock[i]] = uint32(i)
	}
	// Crockford aliases
	for _, p := range []struct{ from, to byte }{{'O', '0'}, {'I', '1'}, {'L', '1'}} {
		m[p.from] = m[p.to]
	}
	return m
}()

func decode32(s string) ([]byte, error) {
	var out []byte
	var buf, bits uint32
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '-' || c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			continue
		}
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		v, ok := crockRev[c]
		if !ok {
			return nil, fmt.Errorf("invalid character %q", c)
		}
		buf = buf<<5 | v
		bits += 5
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(buf>>bits))
		}
	}
	return out, nil
}

const hexDigits = "0123456789abcdef"

func encodeHex(b []byte) string {
	out := make([]byte, len(b)*2)
	for i, x := range b {
		out[i*2] = hexDigits[x>>4]
		out[i*2+1] = hexDigits[x&0xf]
	}
	return string(out)
}
