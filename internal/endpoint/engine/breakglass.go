package engine

import (
	"context"
	"time"
)

// Break-glass (FR Q18): while a window is open, approval-required actions run
// without an approver (the control plane is unreachable, so none can be
// asked). In the kernel that means the approve lists are not folded into
// denies (ruleFor uses Rule.KernelLifted); the hook layer lets an Approve
// decision through. Deny lists are never affected.

// SetBreakGlass opens a window until `until` under grant `id`, re-applies every
// live agent's kernel policy at once so the approve-as-deny lifting takes
// effect, and schedules a re-apply at expiry to put the denies back. A zero
// `until` or one in the past closes any window.
func (e *Engine) SetBreakGlass(ctx context.Context, id string, until time.Time) {
	e.mu.Lock()
	if e.bgTimer != nil {
		e.bgTimer.Stop()
		e.bgTimer = nil
	}
	active := !until.IsZero() && time.Now().Before(until)
	if active {
		e.bgUntil, e.bgID = until, id
		d := time.Until(until)
		e.bgTimer = time.AfterFunc(d, func() { e.expireBreakGlass(context.Background()) })
	} else {
		e.bgUntil, e.bgID = time.Time{}, ""
	}
	pids := e.livePIDsLocked()
	e.mu.Unlock()
	for _, pid := range pids {
		e.reapply(ctx, pid)
	}
}

// expireBreakGlass closes the window at its end and restores enforcement.
func (e *Engine) expireBreakGlass(ctx context.Context) {
	e.mu.Lock()
	if e.bgUntil.IsZero() {
		e.mu.Unlock()
		return
	}
	e.bgUntil, e.bgID, e.bgTimer = time.Time{}, "", nil
	pids := e.livePIDsLocked()
	e.mu.Unlock()
	e.logf("break-glass window ended; approval lists back in force")
	for _, pid := range pids {
		e.reapply(ctx, pid)
	}
}

// BreakGlass reports the active window: its grant id, end time, and whether
// it is currently open.
func (e *Engine) BreakGlass() (id string, until time.Time, active bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.bgID, e.bgUntil, e.bgActiveLocked()
}

// livePIDsLocked lists tracked agent root pids. Caller holds e.mu.
func (e *Engine) livePIDsLocked() []uint32 {
	pids := make([]uint32, 0, len(e.roots))
	for pid := range e.roots {
		pids = append(pids, pid)
	}
	return pids
}
