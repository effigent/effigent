package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/hooks"
)

// hookHandler answers POST /hook/{agent} on the local API.
func hookHandler(eng *engine.Engine) func(agent string, payload []byte) ([]byte, error) {
	return func(agent string, payload []byte) ([]byte, error) {
		if agent != "claude" {
			return nil, fmt.Errorf("unknown agent hook %q", agent)
		}
		var in hooks.ClaudeInput
		if err := json.Unmarshal(payload, &in); err != nil {
			return hooks.FailClosed("the hook input could not be read"), nil
		}
		if hooks.Claude == nil {
			eng.Emit(event.Event{Time: time.Now(), Type: event.Blocked, Severity: "high", Agent: "claude-code",
				Kind: "tool", Target: in.ToolName, Rule: "hook",
				Message: "denied: " + hooks.ErrNoEvaluator.Error()})
			return hooks.FailClosed(hooks.ErrNoEvaluator.Error()), nil
		}
		d := hooks.Claude(eng.RuleFor("claude-code"), in)
		if t := reportType(d); t != "" {
			eng.Emit(event.Event{Time: time.Now(), Type: t, Severity: severity(t), Agent: "claude-code",
				Kind: d.Kind, Target: d.Target, Rule: "hook", Message: d.Reason})
		}
		return hooks.ClaudeOutput(d), nil
	}
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
