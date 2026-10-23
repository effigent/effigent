package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/effigent/effigent/internal/endpoint/api"
	"github.com/effigent/effigent/internal/endpoint/cpclient"
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/hooks"
	"github.com/effigent/effigent/internal/endpoint/ident"
)

// gateHandler answers POST /gate/{agent} (FR Q3): it evaluates the gated
// command line as a Bash tool call under the agent's rule — the same
// command_deny / actions / approvals pipeline a Claude Bash hook runs — and
// returns {"allow":bool,"reason":string}. The kernel has already guaranteed
// that only effigentd (this gate) can exec the gated binary, so this is where
// the launch is actually judged.
func gateHandler(eng *engine.Engine, cp func() *cpclient.Client) func(ctx context.Context, c api.GateCall) ([]byte, error) {
	return func(ctx context.Context, c api.GateCall) ([]byte, error) {
		agent := c.Agent
		if a, ok := hookAgents[c.Agent]; ok && a.name != "" {
			agent = a.name
		}
		in := hooks.ClaudeInput{Cwd: c.Cwd, ToolName: "Bash", ToolInput: map[string]any{"command": c.Command}}
		call := hooks.FromClaude(in)
		env := hooks.CleanAgentEnv(c.Env)
		home, uid, uidKnown := "", 0, false
		if c.OSUser != "" {
			home, uid, uidKnown = ident.Default.Account(c.OSUser)
			uidKnown = uidKnown && uid != 0 // a claimed root must not read root-only files
		}
		for i := range call.Canon {
			call.Canon[i].Agent, call.Canon[i].Env, call.Canon[i].Home = agent, env, home
			call.Canon[i].UID, call.Canon[i].UIDKnown = uid, uidKnown
		}
		ev := event.Event{Time: time.Now(), Type: event.Exec, Severity: "info", Agent: agent,
			Kind: "tool", Target: call.Summary(), Rule: "gate", Message: "gated exec", OSUser: c.OSUser}

		if hooks.Claude == nil { // watch mode: record, allow
			ev.Mode = "monitor"
			eng.Emit(ev)
			return gateJSON(true, "")
		}
		rule := eng.RuleFor(agent)
		d := hooks.EvaluateCall(hooks.Claude, rule, call)
		ev.Mode = string(rule.Mode)
		ev.Actions = d.Actions
		if d.Approve {
			if id, until, active := eng.BreakGlass(); active {
				ev.Type, ev.Severity, ev.Rule = event.BreakGlass, "medium", d.Rule
				ev.Message = "allowed under break-glass " + id + " (would need approval: " + d.Reason +
					"); window ends " + until.UTC().Format("15:04 MST")
				eng.Emit(ev)
				return gateJSON(true, ev.Message)
			}
			hc := api.HookCall{Agent: c.Agent, Budget: c.Budget, OSUser: c.OSUser, Env: c.Env}
			d = askApproval(ctx, eng, cp(), hc, pausedCall{agent: agent, tool: "Bash", cwd: c.Cwd,
				summary: approvalSummary(call), action: callAction(call)}, d, &ev)
			eng.Emit(ev)
			return gateJSON(!d.Deny, d.Reason)
		}
		if t := reportType(d); t != "" {
			ev.Type, ev.Severity, ev.Message = t, severity(t), d.Reason
			if d.Rule != "" {
				ev.Rule = d.Rule
			}
		}
		eng.Emit(ev)
		if d.Deny {
			return gateJSON(false, d.Reason)
		}
		return gateJSON(true, "")
	}
}

func gateJSON(allow bool, reason string) ([]byte, error) {
	return json.Marshal(map[string]any{"allow": allow, "reason": reason})
}

// gateCmd implements `effigentd gate [--agent NAME] -- command [args...]`.
func gateCmd(args []string) {
	agent := os.Getenv("EFFIGENT_AGENT")
	// Minimal flag parsing so the command after `--` keeps its own flags.
	i := 0
	for i < len(args) {
		switch {
		case args[i] == "--":
			i++
			goto done
		case args[i] == "--agent" && i+1 < len(args):
			agent, i = args[i+1], i+2
		case strings.HasPrefix(args[i], "--agent="):
			agent, i = strings.TrimPrefix(args[i], "--agent="), i+1
		default:
			goto done
		}
	}
done:
	cmd := args[i:]
	if len(cmd) == 0 {
		fmt.Fprintln(os.Stderr, "usage: effigentd gate [--agent NAME] -- command [args...]")
		os.Exit(2)
	}
	runGate(agent, cmd)
}

// gateShim is the entry when effigentd is exec'd through a PATH shim named for
// a gated binary (FR Q3): the binary is the shim's own name, the arguments
// follow.
func gateShim(bin string, args []string) {
	runGate(os.Getenv("EFFIGENT_AGENT"), append([]string{bin}, args...))
}

// runGate resolves the real binary (never the shim), asks the daemon to judge
// the command, and execs it in place on allow. It fails closed: any error
// asking the daemon denies the launch.
func runGate(agent string, cmd []string) {
	if agent == "" {
		agent = "claude" // the canonical Bash-shaped agent; one policy covers all
	}
	real, err := resolveReal(cmd[0])
	if err != nil {
		fatalf("gate: %v", err)
	}
	if !gateAllowed(agent, cmd) {
		os.Exit(1) // gateAllowed already printed why
	}
	argv := append([]string{real}, cmd[1:]...)
	if err := syscall.Exec(real, argv, os.Environ()); err != nil {
		fatalf("gate: exec %s: %v", real, err)
	}
}

// gateAllowed asks the daemon and returns whether the command may run, printing
// the reason on a deny. Fail closed.
func gateAllowed(agent string, cmd []string) bool {
	addr := os.Getenv("EFFIGENT_API")
	if addr == "" {
		addr = "127.0.0.1:7777"
	}
	body, _ := json.Marshal(map[string]string{"command": quoteArgs(cmd), "cwd": cwd()})
	const budget = 28 * time.Second
	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/gate/"+agent, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Effigent-Hook-Budget", fmt.Sprint(int(budget/time.Second)))
	if u, err := user.Current(); err == nil {
		req.Header.Set("X-Effigent-OS-User", u.Username)
	}
	if env := hooks.AgentEnv(os.Environ()); len(env) > 0 {
		if b, err := json.Marshal(env); err == nil {
			req.Header.Set("X-Effigent-Agent-Env", base64.StdEncoding.EncodeToString(b))
		}
	}
	res, err := (&http.Client{Timeout: budget}).Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "effigentd gate: effigentd is not reachable, refusing %s\n", cmd[0])
		return false
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var d struct {
		Allow  bool   `json:"allow"`
		Reason string `json:"reason"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(out, &d) != nil {
		fmt.Fprintf(os.Stderr, "effigentd gate: effigentd could not decide, refusing %s\n", cmd[0])
		return false
	}
	if !d.Allow {
		msg := d.Reason
		if msg == "" {
			msg = "blocked by policy"
		}
		fmt.Fprintf(os.Stderr, "effigentd gate: %s\n", msg)
	}
	return d.Allow
}

// resolveReal finds the real binary for a shimmed name, skipping the shim dir
// so the gate doesn't re-enter itself. An explicit path is used as given.
// Anything that is effigentd itself is skipped too: the shim dir spelled
// differently on PATH, or an outer `effigentd run`'s shim dir, would otherwise
// exec the gate again, forever.
func resolveReal(name string) (string, error) {
	if strings.Contains(name, "/") {
		return name, nil
	}
	shim := os.Getenv("EFFIGENT_SHIM_DIR")
	var self os.FileInfo
	if exe, err := os.Executable(); err == nil {
		self, _ = os.Stat(exe)
	}
	for _, d := range filepath.SplitList(os.Getenv("PATH")) {
		if d == "" || shim != "" && filepath.Clean(d) == filepath.Clean(shim) {
			continue
		}
		p := filepath.Join(d, name)
		fi, err := os.Stat(p)
		if err != nil || fi.IsDir() || fi.Mode()&0o111 == 0 || self != nil && os.SameFile(fi, self) {
			continue
		}
		return p, nil
	}
	return "", fmt.Errorf("%q not found on PATH outside the shim dir", name)
}

func cwd() string {
	d, err := os.Getwd()
	if err != nil {
		return ""
	}
	return d
}

// quoteArgs renders argv as a shell command line for the Bash classifier.
func quoteArgs(argv []string) string {
	q := make([]string, len(argv))
	for i, a := range argv {
		if a == "" || strings.ContainsAny(a, " \t\n\"'\\$`&|;<>()*?[]{}#~!") {
			q[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		} else {
			q[i] = a
		}
	}
	return strings.Join(q, " ")
}
