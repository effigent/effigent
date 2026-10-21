//go:build windows

package hooks

import "os"

// userCanRead: Windows ACLs aren't checked; the daemon reads what it can.
func userCanRead(os.FileInfo, ClaudeInput) bool { return true }
