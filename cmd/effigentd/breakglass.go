package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/endpoint/cpclient"
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/shared/sign"
)

// bgResult is the daemon's answer to an activation.
type bgResult struct {
	OK      bool      `json:"ok"`
	Until   time.Time `json:"until,omitempty"`
	ID      string    `json:"id,omitempty"`
	Message string    `json:"message"`
}

// breakGlassState is the daemon's single-use record of grants already
// activated on this machine. A used nonce is never honored again.
type breakGlassState struct {
	Used map[string]time.Time `json:"used"` // grant id -> its expiry (pruned after expiry)
	// Active is the window opened last, restored when the daemon restarts
	// before it ends (a restart must not put the approval lists back early).
	Active *bgWindow `json:"active,omitempty"`
}

type bgWindow struct {
	ID    string    `json:"id"`
	Until time.Time `json:"until"`
}

func bgStatePath(dir string) string { return filepath.Join(dir, "break-glass.json") }

// breakGlassHandler verifies and applies a break-glass code (POST
// /break-glass on the local API). The code is authority in itself (signed by
// the control plane), so no extra auth is needed; who activated it is
// recorded (self-asserted OS user, same caveat as hooks).
func breakGlassHandler(eng *engine.Engine, cpFn func() *cpclient.Client, stateDir string) func(ctx context.Context, code, osUser string) ([]byte, error) {
	return func(ctx context.Context, code, osUser string) ([]byte, error) {
		cp := cpFn()
		if cp == nil {
			return bgError("This machine is not enrolled, so a break-glass code cannot be verified."), nil
		}
		pub, err := sign.DecodePublic(cp.State.ServerPublicKey)
		if err != nil {
			return bgError("the pinned control-plane key is unreadable"), nil
		}
		g, err := sign.DecodeBreakGlass(pub, cp.State.Tenant, cp.State.EndpointID, strings.TrimSpace(code))
		if err != nil {
			return bgError("The code is not valid for this machine (" + err.Error() + ")."), nil
		}
		if time.Now().After(g.Expiry) {
			return bgError("This code expired at " + g.Expiry.UTC().Format("Jan 2 15:04 MST") + "."), nil
		}
		if used, err := bgMarkUsed(stateDir, g.ID, g.Expiry); err != nil {
			return bgError("could not record the code: " + err.Error()), nil
		} else if used {
			return bgError("This code has already been used on this machine. Ask for a new one."), nil
		}
		eng.SetBreakGlass(ctx, g.ID, g.Expiry)
		scope := "this machine"
		if g.AllMachines {
			scope = "all machines"
		}
		msg := fmt.Sprintf("Break-glass active until %s. Approval-required actions run without approval; deny rules still apply.",
			g.Expiry.UTC().Format("15:04 MST"))
		eng.Emit(event.Event{Time: time.Now(), Type: event.BreakGlassStart, Severity: "high", Rule: g.ID, OSUser: osUser,
			Target:  g.Expiry.UTC().Format(time.RFC3339),
			Message: "break-glass activated (" + scope + ") by " + cmpOrUser(osUser) + "; " + msg})
		b, _ := json.Marshal(bgResult{OK: true, Until: g.Expiry, ID: g.ID, Message: msg})
		return b, nil
	}
}

func cmpOrUser(u string) string {
	if u == "" {
		return "an operator"
	}
	return u
}

func bgError(why string) []byte {
	b, _ := json.Marshal(bgResult{OK: false, Message: why})
	return b
}

// bgMarkUsed records grant id (single-use) as the active window and returns
// whether it was already used. Expired entries are pruned. Written with
// write-then-rename.
func bgMarkUsed(dir, id string, expiry time.Time) (already bool, err error) {
	var st breakGlassState
	if b, err := os.ReadFile(bgStatePath(dir)); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Used == nil {
		st.Used = map[string]time.Time{}
	}
	now := time.Now()
	for k, exp := range st.Used {
		if now.After(exp) {
			delete(st.Used, k)
		}
	}
	if _, ok := st.Used[id]; ok {
		return true, nil
	}
	st.Used[id] = expiry
	st.Active = &bgWindow{ID: id, Until: expiry}
	b, _ := json.MarshalIndent(st, "", "  ")
	tmp := bgStatePath(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return false, err
	}
	return false, os.Rename(tmp, bgStatePath(dir))
}

// bgActiveWindow returns the window a previous run opened, if it hasn't
// ended. The code was verified when it was activated; the file sits in the
// state dir, which only root (and, on Linux, not the agent tree: 2l) can write.
func bgActiveWindow(dir string, now time.Time) (id string, until time.Time, ok bool) {
	var st breakGlassState
	b, err := os.ReadFile(bgStatePath(dir))
	if err != nil || json.Unmarshal(b, &st) != nil || st.Active == nil {
		return "", time.Time{}, false
	}
	a := st.Active
	// never longer than a code can last, whatever the file says
	if a.ID == "" || !now.Before(a.Until) || a.Until.Sub(now) > sign.BreakGlassMaxDuration {
		return "", time.Time{}, false
	}
	return a.ID, a.Until, true
}

// breakGlassCmd implements `effigentd break-glass <code>`: it forwards the
// code to the local daemon, which verifies and applies it.
func breakGlassCmd(args []string) {
	if len(args) < 1 || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprintln(os.Stderr, "usage: effigentd break-glass <code>")
		fmt.Fprintln(os.Stderr, "  Activates an admin-issued offline break-glass code on this machine.")
		os.Exit(2)
	}
	code := strings.Join(args, "")
	addr := os.Getenv("EFFIGENT_API")
	if addr == "" {
		addr = "127.0.0.1:7777"
	}
	body, _ := json.Marshal(map[string]string{"code": code})
	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/break-glass", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if u, err := user.Current(); err == nil {
		req.Header.Set("X-Effigent-OS-User", u.Username)
	}
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		fatalf("effigentd is not reachable on %s: %v", addr, err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	var r bgResult
	_ = json.Unmarshal(out, &r)
	if !r.OK {
		fatalf("%s", cmpOr2(r.Message, "the code was refused"))
	}
	fmt.Println(r.Message)
}

func cmpOr2(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
