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
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/api"
	"github.com/effigent/effigent/internal/endpoint/cpclient"
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/hooks"
	"github.com/effigent/effigent/internal/endpoint/redact"
	"github.com/effigent/effigent/internal/shared/action"
)

// hookHandler answers POST /hook/{agent} on the local API. cp is nil when
// the machine isn't enrolled (approvals then can't be asked for).
func hookHandler(eng *engine.Engine, cp func() *cpclient.Client) func(ctx context.Context, c api.HookCall) ([]byte, error) {
	var mu sync.Mutex
	seen := map[string]time.Time{} // Claude Code session id -> last call
	return func(ctx context.Context, c api.HookCall) ([]byte, error) {
		if c.Agent != "claude" {
			return nil, fmt.Errorf("unknown agent hook %q", c.Agent)
		}
		var in hooks.ClaudeInput
		if err := json.Unmarshal(c.Payload, &in); err != nil {
			return hooks.FailClosed("the hook input could not be read"), nil
		}
		// There is no kernel to report agents starting, so a session's first
		// tool call stands in for it (the console counts agents from these).
		mu.Lock()
		_, known := seen[in.SessionID]
		seen[in.SessionID] = time.Now()
		for id, t := range seen {
			if time.Since(t) > 24*time.Hour {
				delete(seen, id)
			}
		}
		mu.Unlock()
		if !known && in.SessionID != "" {
			eng.Emit(event.Event{Time: time.Now(), Type: event.AgentStart, Severity: "info", Agent: "claude-code",
				Kind: "agent", Target: in.Cwd, Rule: "hook", Message: "Claude Code session " + short(in.SessionID)})
		}
		// One event per tool call, so the console sees everything the agent
		// did; a policy match makes it blocked / would_block / file_open.
		ev := event.Event{Time: time.Now(), Type: event.Exec, Severity: "info", Agent: "claude-code",
			Kind: "tool", Target: hooks.Summary(in), Rule: "hook", Message: "session " + short(in.SessionID)}
		if hooks.Claude == nil {
			// No decision logic in this build: watch mode. Record the call,
			// block nothing, and leave the user's own permission prompts as is.
			ev.Mode = "monitor"
			eng.Emit(ev)
			return hooks.ClaudeOutput(hooks.Decision{}), nil
		}
		rule := eng.RuleFor("claude-code")
		d := hooks.Claude(rule, in)
		ev.Mode = string(rule.Mode)
		if d.Approve {
			d = askApproval(ctx, eng, cp(), c, pausedCall{
				agent: "claude-code", session: in.SessionID, tool: in.ToolName, cwd: in.Cwd,
				summary: approvalSummary(in), action: claudeAction(in),
			}, d, &ev)
			eng.Emit(ev)
			return hooks.ClaudeOutput(d), nil
		}
		if t := reportType(d); t != "" {
			ev.Type, ev.Severity = t, severity(t)
			if d.Rule != "" {
				ev.Rule = d.Rule
			}
			ev.Message = d.Reason
			if d.Target != "" && !strings.Contains(d.Reason, d.Target) {
				ev.Message += " (" + d.Target + ")"
			}
		}
		eng.Emit(ev)
		return hooks.ClaudeOutput(d), nil
	}
}

// pausedCall is an agent tool call that needs approval, independent of the
// agent's hook format.
type pausedCall struct {
	agent, session, tool, cwd, summary string
	action                             action.Action
}

// askApproval turns an Approve decision into allow or deny: it files the
// request with the control plane (which notifies the approvers), waits as
// long as the hook process allows, and lets the call run only on an
// approval. Anything else denies, with a message that tells the agent what
// happened and what to do next. ev is updated to record the outcome.
func askApproval(ctx context.Context, eng *engine.Engine, cp *cpclient.Client, c api.HookCall, p pausedCall, d hooks.Decision, ev *event.Event) hooks.Decision {
	ev.Rule = d.Rule
	deny := func(t event.Type, sev, why string) hooks.Decision {
		ev.Type, ev.Severity, ev.Message = t, sev, why
		return hooks.Decision{Deny: true, Reason: why, Kind: d.Kind, Target: d.Target, Rule: d.Rule}
	}
	if cp == nil {
		return deny(event.Blocked, "high", "Blocked by Effigent: "+d.Reason+", and this machine is not connected to the Effigent "+
			"control plane, so no approval can be requested. Ask your IT team.")
	}
	ap := eng.Approvals()
	// Leave the hook process time to receive the answer.
	wait := min(time.Duration(ap.Wait())*time.Second, c.Budget-10*time.Second)
	wait = max(wait, 0)
	actx := action.Context{OrgID: cp.State.Tenant, EndpointID: cp.State.EndpointID, SessionID: p.session,
		AgentType: p.agent, OSUser: c.OSUser}
	res, err := cp.RequestApproval(ctx, cpclient.ApprovalRequest{
		Fingerprint: action.Fingerprint(actx, p.action), Agent: p.agent, SessionID: p.session, Tool: p.tool,
		Summary: redact.String(p.summary), Cwd: p.cwd, Rule: d.Rule, Reason: d.Reason, OSUser: c.OSUser,
		TTLMinutes: ap.TTL(), WaitSeconds: int(wait / time.Second),
	})
	if err != nil {
		if ctx.Err() != nil {
			return deny(event.ApprovalPending, "medium", "Effigent: the approval wait was cancelled.")
		}
		return deny(event.Blocked, "high", "Blocked by Effigent: "+d.Reason+", and the approval request could not be sent ("+
			err.Error()+"). Try again in a minute, or ask your IT team.")
	}
	switch res.State {
	case "approved":
		who := res.DecidedByName
		if who == "" {
			who = "an approver"
		}
		ev.Type, ev.Severity, ev.Message = event.Approved, "info", "approved by "+who+" ("+res.ID+")"
		if res.Note != "" {
			ev.Message += ": " + res.Note
		}
		return hooks.Decision{} // say nothing: the user's own permission prompts still apply
	case "denied":
		why := "Effigent: an approver denied this action (request " + res.ID
		if res.DecidedByName != "" {
			why += ", by " + res.DecidedByName
		}
		why += ")"
		if res.Note != "" {
			why += ": " + res.Note
		}
		return deny(event.ApprovalDenied, "high", why+". Do not retry it; ask the user how to proceed.")
	case "expired":
		return deny(event.ApprovalDenied, "medium", "Effigent: approval request "+res.ID+" expired before anyone decided. "+
			"Running the same command again asks again.")
	}
	sent := "It is waiting in the Effigent console"
	if len(res.Notified) > 0 {
		sent = "The approvers were notified (" + strings.Join(res.Notified, ", ") + ")"
	}
	return deny(event.ApprovalPending, "medium", "Effigent: "+d.Reason+", so it has NOT run yet. Approval request "+res.ID+
		" is pending. "+sent+". Tell the user it is waiting for approval; once they confirm it was approved, run exactly "+
		"the same command again (any change makes it a new request).")
}

// approvalSummary is what approvers see: the usual one-line summary, or the
// tool's arguments when it has no single telling field (MCP tools: repo,
// title, body…). Redacted before it leaves the machine.
func approvalSummary(in hooks.ClaudeInput) string {
	s := hooks.Summary(in)
	if s == in.ToolName && len(in.ToolInput) > 0 {
		if b, err := json.Marshal(in.ToolInput); err == nil {
			if len(b) > 800 {
				b = append(b[:800], "…"...)
			}
			s += " " + string(b)
		}
	}
	return s
}

// claudeAction is the normalized action of a Claude Code tool call; its
// fingerprint binds an approval to exactly this call.
func claudeAction(in hooks.ClaudeInput) action.Action {
	str := func(k string) string { v, _ := in.ToolInput[k].(string); return v }
	a := action.Action{Tool: in.ToolName, Cwd: in.Cwd, Class: action.ToolCall}
	switch in.ToolName {
	case "Bash":
		a.Class, a.Command = action.Exec, str("command")
	case "Read", "Grep", "Glob", "LS", "NotebookRead":
		a.Class = action.FileRead
	case "Write", "Edit", "MultiEdit", "NotebookEdit":
		a.Class = action.FileWrite
	case "WebFetch":
		a.Class, a.URL = action.Network, str("url")
	default:
		if strings.HasPrefix(in.ToolName, "mcp__") {
			a.Class = action.MCPCall
		}
	}
	for _, k := range []string{"file_path", "notebook_path", "path"} {
		if v := str(k); v != "" {
			a.Paths = append(a.Paths, v)
		}
	}
	// Every other input field counts too (an approved Edit must not become
	// a different edit, an MCP call a different call).
	if raw, err := json.Marshal(in.ToolInput); err == nil && a.Command == "" {
		a.Command = in.ToolName + " " + string(raw)
	}
	return a
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func reportType(d hooks.Decision) event.Type {
	switch d.Report {
	case "blocked":
		return event.Blocked
	case "would_block":
		return event.WouldBlock
	case "file_open":
		return event.FileOpen
	}
	if d.Deny {
		return event.Blocked
	}
	return ""
}

func severity(t event.Type) string {
	switch t {
	case event.Blocked:
		return "high"
	case event.WouldBlock, event.FileOpen:
		return "medium"
	}
	return "info"
}

// hookCmd implements `effigentd hook claude`, the command Claude Code runs
// before each tool call. It forwards the payload to the local daemon and
// prints its answer. If the daemon can't answer, it denies: an agent must not
// get a free pass because effigentd was stopped.
func hookCmd(args []string) {
	if len(args) < 1 || args[0] != "claude" {
		fmt.Fprintln(os.Stderr, "usage: effigentd hook claude   (reads Claude Code's PreToolUse JSON on stdin)")
		os.Exit(2)
	}
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
	if err != nil {
		os.Stdout.Write(hooks.FailClosed("the hook input could not be read"))
		return
	}
	addr := os.Getenv("EFFIGENT_API")
	if addr == "" {
		addr = "127.0.0.1:7777"
	}
	// Long enough for an approval wait (policy approvals.wait_seconds, max
	// 90s); install-hooks gives the hook more than this.
	const budget = 100 * time.Second
	c := &http.Client{Timeout: budget}
	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/hook/claude", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Effigent-Hook-Budget", fmt.Sprint(int(budget/time.Second)))
	if u, err := user.Current(); err == nil {
		req.Header.Set("X-Effigent-OS-User", u.Username)
	}
	res, err := c.Do(req)
	if err != nil {
		os.Stdout.Write(hooks.FailClosed("effigentd is not running on this machine"))
		return
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil || res.StatusCode != http.StatusOK || !json.Valid(out) {
		os.Stdout.Write(hooks.FailClosed("effigentd could not decide this action"))
		return
	}
	os.Stdout.Write(out)
}
