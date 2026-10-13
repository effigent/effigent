package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/hooks"
)

// hookHandler answers POST /hook/{agent} on the local API.
func hookHandler(eng *engine.Engine) func(agent string, payload []byte) ([]byte, error) {
	var mu sync.Mutex
	seen := map[string]time.Time{} // Claude Code session id -> last call
	return func(agent string, payload []byte) ([]byte, error) {
		if agent != "claude" {
			return nil, fmt.Errorf("unknown agent hook %q", agent)
		}
		var in hooks.ClaudeInput
		if err := json.Unmarshal(payload, &in); err != nil {
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
		if hooks.Claude == nil {
			// No decision logic in this build: watch mode. Record the call,
			// block nothing, and leave the user's own permission prompts as is.
			eng.Emit(event.Event{Time: time.Now(), Type: event.Exec, Severity: "info", Agent: "claude-code",
				Kind: "tool", Target: hooks.Summary(in), Rule: "hook", Mode: "monitor",
				Message: "session " + short(in.SessionID)})
			return hooks.ClaudeOutput(hooks.Decision{}), nil
		}
		d := hooks.Claude(eng.RuleFor("claude-code"), in)
		if t := reportType(d); t != "" {
			eng.Emit(event.Event{Time: time.Now(), Type: t, Severity: severity(t), Agent: "claude-code",
				Kind: d.Kind, Target: d.Target, Rule: "hook", Message: d.Reason})
		}
		return hooks.ClaudeOutput(d), nil
	}
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
	c := &http.Client{Timeout: 10 * time.Second}
	res, err := c.Post("http://"+addr+"/hook/claude", "application/json", bytes.NewReader(payload))
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
