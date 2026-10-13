// Package policy holds the central policy document and its evaluator. The
// control plane and every endpoint run the same evaluator, so a simulated
// decision and an enforced one agree.
package policy

import (
	"time"

	"github.com/effigent/effigent/internal/shared/action"
)

type Decision string

const (
	Allow           Decision = "allow"
	Deny            Decision = "deny"
	RequireApproval Decision = "require_approval"
)

// Selector picks the identities a policy or rule applies to.
// An empty list means "any".
type Selector struct {
	AgentTypes []string `json:"agent_types,omitempty"`
	Users      []string `json:"users,omitempty"`
	Teams      []string `json:"teams,omitempty"`
	Endpoints  []string `json:"endpoints,omitempty"`
	OSUsers    []string `json:"os_users,omitempty"`
}

// Target picks actions. All non-empty fields must match; inside a list any
// entry may match. String patterns: exact text, a trailing "*" for a prefix,
// or a path glob where "**" spans directories.
type Target struct {
	Classes    []action.Class `json:"classes,omitempty"`
	Tools      []string       `json:"tools,omitempty"`
	Binaries   []string       `json:"binaries,omitempty"`
	Commands   []string       `json:"commands,omitempty"`
	Paths      []string       `json:"paths,omitempty"`
	Hosts      []string       `json:"hosts,omitempty"` // "github.com", "*.github.com", "10.0.0.0/8"
	Ports      []int          `json:"ports,omitempty"`
	MCPServers []string       `json:"mcp_servers,omitempty"`
	MCPTools   []string       `json:"mcp_tools,omitempty"`
}

// Approval says who may approve a require_approval match and for how long a
// request stays open.
type Approval struct {
	Users         []string `json:"users,omitempty"`
	Teams         []string `json:"teams,omitempty"`
	Roles         []string `json:"roles,omitempty"`
	ResourceOwner bool     `json:"resource_owner,omitempty"`
	Fallback      string   `json:"fallback,omitempty"` // team or role used when no reviewer resolves
	TTLSeconds    int      `json:"ttl_seconds,omitempty"`
}

type Rule struct {
	ID          string     `json:"id"`
	Description string     `json:"description,omitempty"`
	Priority    int        `json:"priority"`
	Who         Selector   `json:"who,omitempty"`
	What        Target     `json:"what"`
	Decision    Decision   `json:"decision"`
	Approval    *Approval  `json:"approval,omitempty"`
	ValidUntil  *time.Time `json:"valid_until,omitempty"` // time-limited exception
	Disabled    bool       `json:"disabled,omitempty"`
}

type Policy struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Version  int      `json:"version"`
	Priority int      `json:"priority"`
	Scope    Selector `json:"scope,omitempty"`
	Default  Decision `json:"default"` // when no rule in this policy matches
	Rules    []Rule   `json:"rules"`
	Enabled  bool     `json:"enabled"`
}

// Subject is who is acting, as the evaluator sees it.
type Subject struct {
	AgentType  string
	UserID     string
	UserEmail  string
	Teams      []string
	EndpointID string
	Hostname   string
	OSUser     string
}

// Result explains a decision (FR-18, FR-19).
type Result struct {
	Decision      Decision  `json:"decision"`
	PolicyID      string    `json:"policy_id,omitempty"`
	PolicyVersion int       `json:"policy_version,omitempty"`
	RuleID        string    `json:"rule_id,omitempty"`
	Reason        string    `json:"reason"`
	Approval      *Approval `json:"approval,omitempty"`
}
