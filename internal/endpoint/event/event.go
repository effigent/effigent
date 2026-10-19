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
}
