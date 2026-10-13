// Package hooks is effigentd's side of an agent's pre-tool hook: the agent
// asks before each tool call, effigentd answers allow or deny from the
// endpoint policy, and reports the decision as an event. Used where effigentd
// can't enforce in the kernel (macOS), and as an extra layer elsewhere.
package hooks

import (
	"encoding/json"
	"errors"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

// Decision is the answer for one tool call.
type Decision struct {
	Deny   bool   `json:"deny"`
	Reason string `json:"reason,omitempty"` // shown to the agent when denied
	// Report is "blocked", "would_block", "file_open", or "" (nothing notable).
	Report string `json:"report,omitempty"`
	Kind   string `json:"kind,omitempty"`   // exec | file_open | connect | tool
	Target string `json:"target,omitempty"` // e.g. "exec /usr/bin/curl", "/work/.env"
}

// ClaudeInput is the part of Claude Code's PreToolUse payload effigentd uses.
type ClaudeInput struct {
	SessionID string         `json:"session_id"`
	Cwd       string         `json:"cwd"`
	ToolName  string         `json:"tool_name"`
	ToolInput map[string]any `json:"tool_input"`
	ToolUseID string         `json:"tool_use_id"`
}

// ClaudeEvaluator decides a Claude Code tool call under the agent's rule.
// It is the plug-in point for the decision logic (see CLAUDE.md, "macOS").
type ClaudeEvaluator func(rule policy.Rule, in ClaudeInput) Decision

// Claude is nil until a decision implementation is registered.
var Claude ClaudeEvaluator

// ErrNoEvaluator is returned when this build has no decision logic for the agent.
var ErrNoEvaluator = errors.New("this effigentd build has no hook decision logic for this agent")

// ClaudeOutput renders a Decision in Claude Code's PreToolUse output format.
// "allow" defers to the user's own permission rules; "deny" stops the call
// and shows Reason to the model.
func ClaudeOutput(d Decision) []byte {
	decision := "allow"
	if d.Deny {
		decision = "deny"
	}
	out := map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":            "PreToolUse",
		"permissionDecision":       decision,
		"permissionDecisionReason": d.Reason,
	}}
	b, _ := json.Marshal(out)
	return b
}

// FailClosed is what the hook prints when it can't get a decision.
func FailClosed(why string) []byte {
	return ClaudeOutput(Decision{Deny: true,
		Reason: "Blocked by Effigent: " + why + ". Ask your IT team, or check: effigentd status"})
}
