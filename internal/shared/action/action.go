// Package action is the normalized, agent-independent representation of one
// thing an agent tries to do (PRD §10.4 Action, §10.5 state machine). Hooks,
// kernel events and the control plane all speak this shape, and approvals bind
// to its fingerprint (FR-32): change the command, target, arguments, session or
// identity and the fingerprint changes, so the approval no longer applies.
package action

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

// Class is the action category policies select on.
type Class string

const (
	Exec      Class = "exec"       // run a program / shell command
	FileRead  Class = "file_read"  // read a file
	FileWrite Class = "file_write" // create/modify/delete a file
	Network   Class = "network"    // outbound connection / HTTP fetch
	MCPCall   Class = "mcp_call"   // call a tool on an MCP server
	ToolCall  Class = "tool_call"  // any other agent tool (agent-specific)
)

var Classes = []Class{Exec, FileRead, FileWrite, Network, MCPCall, ToolCall}

// Action is what is being attempted. Fields that don't apply stay empty.
type Action struct {
	Class     Class    `json:"class"`
	Tool      string   `json:"tool,omitempty"`       // agent tool name, e.g. "Bash", "Edit", "mcp__github__create_pr"
	Command   string   `json:"command,omitempty"`    // full shell command line (Exec)
	Binary    string   `json:"binary,omitempty"`     // resolved program path (kernel exec) or first word of Command
	Paths     []string `json:"paths,omitempty"`      // files touched (absolute when known)
	Host      string   `json:"host,omitempty"`       // destination host or IP (Network)
	Port      int      `json:"port,omitempty"`       //
	URL       string   `json:"url,omitempty"`        // full URL for fetches
	MCPServer string   `json:"mcp_server,omitempty"` //
	MCPTool   string   `json:"mcp_tool,omitempty"`   //
	Cwd       string   `json:"cwd,omitempty"`        //
	// Input is the agent's raw tool input, redacted before it leaves the
	// endpoint. It is for display and simulation, never for matching.
	Input json.RawMessage `json:"input,omitempty"`
}

// Context is who/where the action happens. Part of the fingerprint.
type Context struct {
	OrgID      string `json:"org_id"`
	EndpointID string `json:"endpoint_id"`
	SessionID  string `json:"session_id"`
	AgentType  string `json:"agent_type"`
	OSUser     string `json:"os_user,omitempty"`
	UserID     string `json:"user_id,omitempty"` // console user (Clerk) the endpoint/OS user maps to
}

// Fingerprint is a stable hash over the context and every matching-relevant
// field of the action (not Input, which is redacted and display-only).
// Values are hashed as-is, so secrets in a command still change the
// fingerprint without being stored.
func Fingerprint(ctx Context, a Action) string {
	paths := append([]string(nil), a.Paths...)
	sort.Strings(paths)
	canon := struct {
		V   int      `json:"v"`
		Org string   `json:"org"`
		Ep  string   `json:"ep"`
		Ses string   `json:"ses"`
		Agt string   `json:"agt"`
		Usr string   `json:"usr"`
		Cls Class    `json:"cls"`
		Tl  string   `json:"tl"`
		Cmd string   `json:"cmd"`
		Bin string   `json:"bin"`
		Pth []string `json:"pth"`
		Hst string   `json:"hst"`
		Prt int      `json:"prt"`
		URL string   `json:"url"`
		Srv string   `json:"srv"`
		MTl string   `json:"mtl"`
		Cwd string   `json:"cwd"`
	}{1, ctx.OrgID, ctx.EndpointID, ctx.SessionID, ctx.AgentType, firstNonEmpty(ctx.UserID, ctx.OSUser),
		a.Class, a.Tool, strings.TrimSpace(a.Command), a.Binary, paths, strings.ToLower(a.Host), a.Port, a.URL,
		a.MCPServer, a.MCPTool, a.Cwd}
	b, _ := json.Marshal(canon)
	sum := sha256.Sum256(b)
	return "fp1:" + hex.EncodeToString(sum[:])
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

// State is the §10.5 action state machine.
type State string

const (
	Observed  State = "observed"
	Evaluated State = "evaluated"
	Allowed   State = "allowed"
	Denied    State = "denied"
	Paused    State = "paused"

	ApprovalPending State = "approval_pending"
	Approved        State = "approved"
	Revalidated     State = "revalidated"
	Resumed         State = "resumed"
	Completed       State = "completed"
	Failed          State = "failed"

	Expired              State = "expired"
	Cancelled            State = "cancelled"
	ApprovalDenied       State = "approval_denied"
	RevalidationFailed   State = "revalidation_failed"
	EnforcementFailed    State = "enforcement_failed"
	AttributionUncertain State = "attribution_uncertain"
	Unsupported          State = "unsupported"
	OutcomeUnknown       State = "outcome_unknown"
)

// transitions lists the legal next states. Terminal states have none.
var transitions = map[State][]State{
	Observed:        {Evaluated, AttributionUncertain, Unsupported},
	Evaluated:       {Allowed, Denied, Paused, Unsupported},
	Allowed:         {Completed, Failed, OutcomeUnknown},
	Denied:          {EnforcementFailed}, // a deny that turned out not to hold
	Paused:          {ApprovalPending, Denied, Cancelled},
	ApprovalPending: {Approved, ApprovalDenied, Expired, Cancelled},
	Approved:        {Revalidated, RevalidationFailed, Expired, Cancelled},
	Revalidated:     {Resumed, Expired},
	Resumed:         {Completed, Failed, OutcomeUnknown},
}

// CanTransition reports whether from → to is a legal step.
func CanTransition(from, to State) bool {
	for _, s := range transitions[from] {
		if s == to {
			return true
		}
	}
	return false
}

// Terminal reports whether no further transition is possible.
func Terminal(s State) bool { return len(transitions[s]) == 0 }
