//go:build windows

package main

import (
	"time"

	"golang.org/x/sys/windows/svc"
)

// serviceStop is closed when Windows asks the service to stop.
var serviceStop = make(chan struct{})

// serviceMode: started by the Service Control Manager; serviceStopWhy is
// what it asked for ("service stop" or "system shutdown"), set before
// serviceStop is closed.
var (
	serviceMode    bool
	serviceStopWhy string
)

// runAsServiceIfNeeded runs daemon under the Service Control Manager when
// Windows started us as a service, and reports whether it did.
func runAsServiceIfNeeded(daemon func()) bool {
	is, err := svc.IsWindowsService()
	if err != nil || !is {
		return false
	}
	serviceMode = true
	_ = svc.Run("effigentd", &winService{daemon: daemon})
	return true
}

type winService struct{ daemon func() }

func (w *winService) Execute(_ []string, req <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
	st <- svc.Status{State: svc.StartPending}
	done := make(chan struct{})
	go func() { w.daemon(); close(done) }()
	st <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				st <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				st <- svc.Status{State: svc.StopPending}
				serviceStopWhy = "service stop"
				if c.Cmd == svc.Shutdown {
					serviceStopWhy = "system shutdown"
				}
				close(serviceStop)
				select {
				case <-done:
				case <-time.After(10 * time.Second):
				}
				return false, 0
			}
		case <-done:
			return false, 1 // daemon exited on its own: let Windows restart it
		}
	}
}
