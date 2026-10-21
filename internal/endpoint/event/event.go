// Package event is the platform-neutral event model. Sensors (Tetragon on
// Linux, eslogger on macOS) translate their native events into these, and
// sinks (stdout, file, HTTP backend) only ever see these.
package event

import "time"

type Type string

const (
	AgentStart Type = "agent_start" // a new agent (or orphan MCP server) was detected
	AgentExit  Type = "agent_exit"
	Exec       Type = "exec"        // a process ran inside an agent's tree
	Exit       Type = "exit"        // a non-root process inside an agent's tree exited
	FileOpen   Type = "file_open"   // a sensitive file was opened
	Connect    Type = "connect"     // an outbound TCP connection
	Blocked    Type = "blocked"     // the kernel denied an action
	WouldBlock Type = "would_block" // the policy matched, but the agent runs in monitor/learn mode
	PolicyLoad Type = "policy"      // a per-agent policy was applied/removed (operational)

	// Approval flow (agent hooks): a tool call matched an approval list.
	ApprovalPending Type = "approval_pending" // asked an approver; the call did not run (yet)
	Approved        Type = "approved"         // an approver allowed it; the call ran
	ApprovalDenied  Type = "approval_denied"  // an approver denied it, or the request expired

	// ToolResult is how a tool call ended, from the agent's post-tool hook
	// (Outcome; ToolUseID or Target + SessionID tie it to the call's event).
	ToolResult Type = "tool_result"

	// The daemon itself: stopped on a signal / service stop (Target = the
	// signal, Rule = how it was run, OSUser = who, when knowable), or found
	// at start that the previous run ended without one (crash, kill -9, power).
	DaemonStop           Type = "daemon_stop"
	DaemonUncleanRestart Type = "daemon_unclean_restart"
)

// Proc identifies one process. ExecID is stable across pid reuse (Tetragon).
type Proc struct {
	PID    uint32 `json:"pid"`
	ExecID string `json:"exec_id,omitempty"`
	Binary string `json:"binary,omitempty"`
	Args   string `json:"args,omitempty"`
	CWD    string `json:"cwd,omitempty"`
	UID    uint32 `json:"uid"`
}

// Raw is what a sensor emits before the engine attributes it to an agent.
type Raw struct {
	Time      time.Time
	Node      string
	Kind      Type // Exec, Exit, FileOpen, Connect, Blocked, WouldBlock
	Process   Proc
	Parent    Proc
	Ancestors []Proc // nearest first
	Policy    string // policy that produced this event (kprobe/lsm events)
	Target    string // exec'd binary, opened file, or "ip:port"
	Container string
}

// Event is what goes to sinks.
type Event struct {
	Time      time.Time `json:"time"`
	Node      string    `json:"node,omitempty"`
	Type      Type      `json:"type"`
	Severity  string    `json:"severity"` // info | medium | high
	Agent     string    `json:"agent,omitempty"`
	AgentPID  uint32    `json:"agent_pid,omitempty"`
	Mode      string    `json:"mode,omitempty"`
	Via       string    `json:"via,omitempty"`  // nearest MCP server in the chain, e.g. "mcp:github"
	Kind      string    `json:"kind,omitempty"` // agent | mcp | tool
	Process   *Proc     `json:"process,omitempty"`
	Target    string    `json:"target,omitempty"`
	Rule      string    `json:"rule,omitempty"`
	Container string    `json:"container,omitempty"`
	Message   string    `json:"message,omitempty"`

	// Who is behind the action (best effort, all optional; older effigentd
	// builds don't send them). Used by the control plane's people mapping.
	OSUser         string `json:"os_user,omitempty"`         // OS user of the agent (hook caller, or the kernel uid's name)
	SessionID      string `json:"session_id,omitempty"`      // the agent's full session id (hooks)
	GitEmail       string `json:"git_email,omitempty"`       // git user.email for that user in the working directory
	Model          string `json:"model,omitempty"`           // model the agent reported in its hook payload, if any
	TranscriptPath string `json:"transcript_path,omitempty"` // the agent's transcript file (hooks), a path only

	// What the tool call does, as the agent hook read it (hooks only).
	Actions []Action `json:"actions,omitempty"`
	// AgentEnv is the agent's identity-related environment, on a hook
	// session's first event: cloud profile names, model API hosts, which
	// API keys are set (never their values). Reported by the hook process.
	AgentEnv map[string]string `json:"agent_env,omitempty"`

	// ToolUseID is the agent's id for the tool call (Claude Code, Codex,
	// Cursor preToolUse), on the call's event and on its tool_result.
	ToolUseID string `json:"tool_use_id,omitempty"`
	// Outcome is how the call ended (tool_result events only).
	Outcome *Outcome `json:"outcome,omitempty"`
}

// Outcome is how a tool call ended, as the agent's post-tool hook reported
// it. Never the tool's output: only its status, exit code, duration and the
// first line of an error (redacted, capped).
type Outcome struct {
	// Status: ok | error | interrupted | timeout | denied, or done when the
	// call finished and the agent doesn't say whether it succeeded (Codex
	// shell commands).
	Status   string `json:"status"`
	ExitCode *int   `json:"exit_code,omitempty"`
	// DurationMS is the agent's own measure when it sends one; otherwise the
	// time since the call's pre-tool hook (DurationApprox: it then includes
	// permission prompts and approval waits).
	DurationMS     int64  `json:"duration_ms,omitempty"`
	DurationApprox bool   `json:"duration_approx,omitempty"`
	Error          string `json:"error,omitempty"`
	FailureType    string `json:"failure_type,omitempty"` // the agent's failure class (Cursor: error, timeout, permission_denied)
}

// Action is one thing a command or tool call does beyond running a program:
// a push to a protected branch, a destructive SQL statement, a package
// install, a cloud deletion… (policy.ActionKinds).
type Action struct {
	Kind   string            `json:"kind"`
	Target string            `json:"target,omitempty"` // branch, statement, package, path, cloud operation
	Attrs  map[string]string `json:"attrs,omitempty"`  // aws_profile, aws_account, kube_context, db_host, registry, …
	Envs   []string          `json:"envs,omitempty"`   // environments its target belongs to (prod)
	In     string            `json:"in,omitempty"`     // the script or package.json script it was found in
}
