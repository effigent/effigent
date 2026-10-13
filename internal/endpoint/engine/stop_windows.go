//go:build windows

package engine

import "os"

// stopProcess ends a process. A variable so tests can replace it.
var stopProcess = func(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}
