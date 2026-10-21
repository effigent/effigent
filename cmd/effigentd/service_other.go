//go:build !windows

package main

// serviceStop is closed by the Windows service wrapper; never on other OSes.
var serviceStop = make(chan struct{})

// serviceMode: started by the Windows Service Control Manager; serviceStopWhy
// says what it asked for. Never set on other OSes.
var (
	serviceMode    bool
	serviceStopWhy string
)

func runAsServiceIfNeeded(func()) bool { return false }
