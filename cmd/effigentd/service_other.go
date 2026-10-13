//go:build !windows

package main

// serviceStop is closed by the Windows service wrapper; never on other OSes.
var serviceStop = make(chan struct{})

func runAsServiceIfNeeded(func()) bool { return false }
