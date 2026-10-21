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
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/api"
	"github.com/effigent/effigent/internal/endpoint/cpclient"
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/gateway"
	"github.com/effigent/effigent/internal/endpoint/hooks"
	"github.com/effigent/effigent/internal/endpoint/ident"
	"github.com/effigent/effigent/internal/endpoint/redact"
	"github.com/effigent/effigent/internal/shared/action"
)

// hookAgent is one agent's hook format.
type hookAgent struct {
	name       string // policy agent name, e.g. "claude-code"
	label      string
	parse      func([]byte) (hooks.Call, error)
	output     func(hooks.Decision) []byte
	failClosed func(string) []byte
	slim       func([]byte) []byte // drops bulky fields the daemon never reads (nil: send as is)
}

// hookAgents is keyed by the name in `effigentd hook <name>` and POST /hook/{name}.
var hookAgents = map[string]hookAgent{
	"claude": {name: "claude-code", label: "Claude Code", output: hooks.ClaudeOutput, failClosed: hooks.FailClosed,
		parse: func(b []byte) (hooks.Call, error) {
			var in hooks.ClaudeInput
			err := json.Unmarshal(b, &in)
			return hooks.FromClaude(in), err
		}},
	// Codex answers like Claude Code: its PreToolUse accepts the same deny JSON.
	"codex":  {name: "codex", label: "Codex", parse: hooks.ParseCodex, output: hooks.ClaudeOutput, failClosed: hooks.FailClosed},
	"gemini": {name: "gemini-cli", label: "Gemini CLI", parse: hooks.ParseGemini, output: hooks.GeminiOutput, failClosed: hooks.GeminiFailClosed},
	// Cursor's IDE and CLI share hooks.json and send no field that tells them apart: one policy agent.
	"cursor": {name: "cursor-agent", label: "Cursor", parse: hooks.ParseCursor, output: hooks.CursorOutput, failClosed: hooks.CursorFailClosed,
		slim: hooks.CursorSlim},
}

// hookHandler answers POST /hook/{agent} on the local API. cp is nil when
// the machine isn't enrolled (approvals then can't be asked for).
// sess joins hook sessions with the model gateway's; gatewayAddr is where
// the gateway listens ("" when it's off).
func hookHandler(eng *engine.Engine, cp func() *cpclient.Client, sess *sessions, gatewayAddr string) func(ctx context.Context, c api.HookCall) ([]byte, error) {
	var mu sync.Mutex
	seen := map[string]time.Time{}  // agent/session id -> last call
	sessions := hooks.NewSessions() // session rules (exfil_sequence, untrusted_then_risky)
	calls := hooks.NewCalls()       // when each call started, for outcomes without a duration
	return func(ctx context.Context, c api.HookCall) ([]byte, error) {
		ag, ok := hookAgents[c.Agent]
		if !ok {
			return nil, fmt.Errorf("unknown agent hook %q", c.Agent)
		}
		if c.Result {
			return hookResult(eng, ag, c, calls)
		}
		call, err := ag.parse(c.Payload)
		if err != nil {
			return ag.failClosed("the hook input could not be read"), nil
		}
		if call.Skip {
			return ag.output(hooks.Decision{}), nil
		}
		who := hookIdentity(c)
		env := hooks.CleanAgentEnv(c.Env)
		home, uid, uidKnown := "", 0, false
		if c.OSUser != "" {
			home, uid, uidKnown = ident.Default.Account(c.OSUser)
			// The user name is the hook process's claim: claiming root must
			// not let the daemon read root-only files on the agent's behalf.
			uidKnown = uidKnown && uid != 0
		}
		in := call.Orig
		sess.hook(ag.name, in.SessionID, gateway.Identity{OSUser: who.osUser, GitEmail: who.gitEmail})
		via := sess.viaGateway(ag.name, in.SessionID)
		for i := range call.Canon {
			call.Canon[i].Agent, call.Canon[i].Env, call.Canon[i].Home = ag.name, env, home
			call.Canon[i].UID, call.Canon[i].UIDKnown = uid, uidKnown
			call.Canon[i].ViaGateway = via
		}
		// There is no kernel to report agents starting, so a session's first
		// tool call stands in for it (the console counts agents from these).
		mu.Lock()
		key := ag.name + "/" + in.SessionID
		_, known := seen[key]
		seen[key] = time.Now()
		for id, t := range seen {
			if time.Since(t) > 24*time.Hour {
				delete(seen, id)
			}
		}
		mu.Unlock()
		if !known && in.SessionID != "" {
			start := event.Event{Time: time.Now(), Type: event.AgentStart, Severity: "info", Agent: ag.name,
				Kind: "agent", Target: in.Cwd, Rule: "hook", Message: ag.label + " session " + short(in.SessionID), AgentEnv: env}
			if len(call.Canon) > 0 {
				// the MCP servers its configs define, with the fingerprints mcp_pins takes
				c0 := call.Canon[0]
				c0.Cwd = in.Cwd
				start.MCPServers = hooks.MCPServers(c0)
			}
			eng.Emit(who.on(start))
		}
		// One event per tool call, so the console sees everything the agent
		// did; a policy match makes it blocked / would_block / file_open.
		ev := who.on(event.Event{Time: time.Now(), Type: event.Exec, Severity: "info", Agent: ag.name,
			Kind: "tool", Target: call.Summary(), Rule: "hook", Message: "session " + short(in.SessionID), ToolUseID: cut(in.ToolUseID, 200)})
		if in.SessionID != "" {
			calls.Start(key, ev.ToolUseID, ev.Target)
		}
		if hooks.Claude == nil {
			// No decision logic in this build: watch mode. Record the call,
			// block nothing, and leave the user's own permission prompts as is.
			ev.Mode = "monitor"
			eng.Emit(ev)
			return ag.output(hooks.Decision{}), nil
		}
		rule := eng.RuleFor(ag.name)
		hist := sessions.History(key)
		for i := range call.Canon {
			call.Canon[i].History = hist
		}
		rule.GatewayAddr = gatewayAddr
		d := hooks.EvaluateCall(hooks.Claude, rule, call)
		ev.Mode = string(rule.Mode)
		ev.Actions = d.Actions // redacted with the rest of the event (engine.scrub)
		if d.Approve {
			seenBy := d.Seen
			d = askApproval(ctx, eng, cp(), c, pausedCall{
				agent: ag.name, session: in.SessionID, tool: in.ToolName, cwd: in.Cwd,
				summary: approvalSummary(call), action: callAction(call),
			}, d, &ev)
			sessions.Record(key, seenBy, !d.Deny)
			eng.Emit(ev)
			return ag.output(d), nil
		}
		sessions.Record(key, d.Seen, !d.Deny)
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
		return ag.output(d), nil
	}
}

// hookResult records how a tool call ended (a post-tool hook) as a
// tool_result event. The payload carries no output: the hook process
// replaced it with the outcome (hooks.ReduceResult).
func hookResult(eng *engine.Engine, ag hookAgent, c api.HookCall, calls *hooks.Calls) ([]byte, error) {
	r, err := hooks.ParseResult(c.Agent, c.Payload)
	if err != nil {
		return nil, err
	}
	session, summary, o := r.Call.Orig.SessionID, r.Call.Summary(), r.Outcome
	if session != "" {
		if d, ok := calls.Finish(ag.name+"/"+session, r.ToolUseID, summary); ok && o.DurationMS == 0 {
			o.DurationMS, o.DurationApprox = max(d.Milliseconds(), 1), true
		}
	}
	eng.Emit(hookIdentity(c).on(event.Event{Time: time.Now(), Type: event.ToolResult, Severity: "info", Agent: ag.name,
		Kind: "tool", Target: summary, Rule: "hook", ToolUseID: r.ToolUseID, Outcome: &o, Message: hooks.ResultMessage(o)}))
	return []byte("{}"), nil
}

func cut(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// identity is who is behind a hook call, copied onto its events.
type identity struct{ osUser, session, gitEmail, model, transcript string }

func hookIdentity(c api.HookCall) identity {
	m := hooks.Meta(c.Payload)
	return identity{osUser: c.OSUser, session: m.SessionID, gitEmail: ident.Default.GitEmail(c.OSUser, m.Cwd),
		model: m.Model, transcript: m.TranscriptPath}
}

func (w identity) on(ev event.Event) event.Event {
	ev.OSUser, ev.SessionID, ev.GitEmail, ev.Model, ev.TranscriptPath = w.osUser, w.session, w.gitEmail, w.model, w.transcript
	return ev
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
		Summary: redact.String(p.summary), Cwd: p.cwd, Rule: d.Rule, Reason: redact.String(d.Reason), OSUser: c.OSUser,
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
func approvalSummary(c hooks.Call) string {
	s := c.Summary()
	if in := c.Canon[0]; len(c.Canon) == 1 && s == in.ToolName && len(in.ToolInput) > 0 {
		if b, err := json.Marshal(in.ToolInput); err == nil {
			if len(b) > 800 {
				b = append(b[:800], "…"...)
			}
			s += " " + string(b)
		}
	}
	return s
}

// callAction is the action an approval binds to: the canonical call, with the
// agent's own tool name and full input when they differ (a Codex patch, a
// Gemini fetch prompt), so an approved call can't turn into another one.
func callAction(c hooks.Call) action.Action {
	a := claudeAction(c.Canon[0])
	if len(c.Canon) > 1 || c.Orig.ToolName != c.Canon[0].ToolName {
		a.Tool = c.Orig.ToolName
		if b, err := json.Marshal(c.Orig.ToolInput); err == nil {
			a.Command = c.Orig.ToolName + " " + string(b)
		}
		a.Paths = nil
		for _, in := range c.Canon {
			if p, _ := in.ToolInput["file_path"].(string); p != "" {
				a.Paths = append(a.Paths, p)
			}
		}
	}
	return a
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
	if len(args) < 1 || hookAgents[args[0]].parse == nil {
		fmt.Fprintln(os.Stderr, "usage: effigentd hook claude|codex|gemini|cursor   (reads the agent's pre-tool hook JSON on stdin)")
		os.Exit(2)
	}
	ag := hookAgents[args[0]]
	// Cursor sends the whole file it is about to read (slim drops it), and
	// post-tool events carry the tool's output (ReduceResult drops it).
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, 64<<20))
	if err != nil {
		os.Stdout.Write(ag.failClosed("the hook input could not be read"))
		return
	}
	addr := os.Getenv("EFFIGENT_API")
	if addr == "" {
		addr = "127.0.0.1:7777"
	}
	if hooks.IsResult(payload) {
		hookResultCmd(args[0], addr, payload)
		return
	}
	if ag.slim != nil {
		payload = ag.slim(payload)
	} else if len(payload) > 1<<20 {
		payload = payload[:1<<20] // as before: a call too big to read fails closed
	}
	// How long the agent lets this hook run is the agent's setting, not ours:
	// Claude Code reads it when a session starts (older installs set 30s) and
	// treats a timeout as a block. Stay well inside the smallest common limit;
	// the daemon waits at most budget-10s for an approver, and a later
	// retry of the same call picks up an approval given after that.
	const budget = 28 * time.Second
	c := &http.Client{Timeout: budget}
	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/hook/"+args[0], bytes.NewReader(payload))
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
	res, err := c.Do(req)
	if err != nil {
		os.Stdout.Write(ag.failClosed("effigentd is not running on this machine"))
		return
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil || res.StatusCode != http.StatusOK || !json.Valid(out) {
		os.Stdout.Write(ag.failClosed("effigentd could not decide this action"))
		return
	}
	os.Stdout.Write(out)
}

// hookResultCmd handles a post-tool event: it reports how the call ended and
// never affects the agent. It prints nothing the agent acts on and exits 0
// whatever happens (daemon down, slow, an older daemon without the route).
func hookResultCmd(agent, addr string, payload []byte) {
	defer os.Stdout.Write(hooks.ResultOutput(agent))
	body, ok := hooks.ReduceResult(agent, payload)
	if !ok {
		return
	}
	c := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodPost, "http://"+addr+"/hook/"+agent+"/result", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if u, err := user.Current(); err == nil {
		req.Header.Set("X-Effigent-OS-User", u.Username)
	}
	if res, err := c.Do(req); err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		res.Body.Close()
	}
}
