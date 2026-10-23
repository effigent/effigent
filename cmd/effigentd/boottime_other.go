//go:build !linux && !darwin && !windows

package main

import "time"

// bootTime is unknown here.
func bootTime() time.Time { return time.Time{} }
