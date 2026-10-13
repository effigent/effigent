//go:build !windows

package engine

import "syscall"

// stopProcess ends a process. A variable so tests can replace it.
var stopProcess = func(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }
