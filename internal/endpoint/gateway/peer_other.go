//go:build !linux

package gateway

// PeerUser can't tell who owns a loopback connection here (macOS and
// Windows have no cheap lookup); the session's hook calls name the user.
func PeerUser(string) string { return "" }
