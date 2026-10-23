package main

import (
	"time"

	"golang.org/x/sys/unix"
)

// bootTime is when the machine booted (kern.boottime; sleep doesn't change
// it), zero when unknown.
func bootTime() time.Time {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil || tv.Sec <= 0 {
		return time.Time{}
	}
	return time.Unix(tv.Unix())
}
