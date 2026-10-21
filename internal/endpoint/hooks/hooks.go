// Package hooks is effigentd's side of an agent's pre-tool hook: the agent
// asks before each tool call, effigentd answers allow or deny from the
// endpoint policy, and reports the decision as an event. Used where effigentd
// can't enforce in the kernel (macOS), and as an extra layer elsewhere.
package hooks

import (
	"encoding/json"
	"errors"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

// Decision is the answer for one tool call.
type Decision struct {
	Deny bool `json:"deny"`
	// Approve: the call matched an approval list in an enforcing mode. The
	// daemon asks an approver and turns this into allow or deny.
	Approve bool   `json:"approve,omitempty"`
	Reason  string `json:"reason,omitempty"` // shown to the agent when denied
	// Report is "blocked", "would_block", "file_open", "approval", or "" (nothing notable).
	Report string `json:"report,omitempty"`
	Kind   string `json:"kind,omitempty"`   // exec | file_open | connect | tool
	Target string `json:"target,omitempty"` // e.g. "exec /usr/bin/curl", "/work/.env"
	Rule   string `json:"rule,omitempty"`   // the policy list that matched, e.g. "exec_deny"
	// Actions is what the call does (git, SQL, packages, cloud, files…),
	// whether or not a policy list matched.
	Actions []event.Action `json:"actions,omitempty"`
	// Seen is what the call adds to its session's history if it runs
	// (session rules; the daemon records it).
	Seen Seen `json:"-"`
}

// ClaudeInput is the part of Claude Code's PreToolUse payload effigentd uses.
type ClaudeInput struct {
	SessionID string         `json:"session_id"`
	Cwd       string         `json:"cwd"`
	ToolName  string         `json:"tool_name"`
	ToolInput map[string]any `json:"tool_input"`
	ToolUseID string         `json:"tool_use_id"`

	// Set by the daemon, not the agent: who runs the agent and with which
	// identity-related environment (see AgentEnvNames).
	Agent string            `json:"-"` // policy agent name, e.g. "claude-code"
	Env   map[string]string `json:"-"`
	Home  string            `json:"-"` // the OS user's home directory
	// UID is the OS user's uid when UIDKnown: files the hook reads to
	// understand a command (scripts, .sql files, configs) are read only if
	// that user could read them; unknown means world-readable files only.
	UID      int  `json:"-"`
	UIDKnown bool `json:"-"`
	// History is what earlier calls of this session did (session rules);
	// nil when the call has no session.
	History *History `json:"-"`
}

// ClaudeEvaluator decides a Claude Code tool call under the agent's rule.
// It is the plug-in point for the decision logic (see CLAUDE.md, "macOS").
type ClaudeEvaluator func(rule policy.Rule, in ClaudeInput) Decision

// Claude is the registered decision logic (EvaluateClaude); nil means watch mode.
var Claude ClaudeEvaluator

// ErrNoEvaluator is returned when this build has no decision logic for the agent.
var ErrNoEvaluator = errors.New("this effigentd build has no hook decision logic for this agent")

// ClaudeOutput renders a Decision in Claude Code's PreToolUse output format:
// "deny" stops the call and shows Reason to the model.
//
// When the call is not denied we say nothing ("{}"): an explicit "allow"
// would skip the user's own permission prompts, and effigentd must only ever
// add restrictions, never remove them.
func ClaudeOutput(d Decision) []byte {
	if !d.Deny {
		return []byte("{}")
	}
	out := map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":            "PreToolUse",
		"permissionDecision":       "deny",
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

// Summary describes a tool call for its event, e.g.
// "Bash: git status", "Read: /work/.env", "WebFetch: https://…".
func Summary(in ClaudeInput) string {
	for _, k := range []string{"command", "file_path", "notebook_path", "url", "pattern", "query"} {
		if v, ok := in.ToolInput[k].(string); ok && v != "" {
			if len(v) > 300 {
				v = v[:300] + "…"
			}
			return in.ToolName + ": " + v
		}
	}
	return in.ToolName
}
