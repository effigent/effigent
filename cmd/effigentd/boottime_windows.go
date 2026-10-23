package main

import (
	"time"

	"golang.org/x/sys/windows"
)

// bootTime is when the machine booted: now minus the tick count, which
// counts sleep and hibernation too. A Fast Startup "shutdown" hibernates
// the kernel, so it doesn't count as a boot.
func bootTime() time.Time {
	return time.Now().Add(-windows.DurationSinceBoot()) // GetTickCount64
}
