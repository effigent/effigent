package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Approval states. "used" is an approval the endpoint has acted on: each
// approval lets exactly one tool call through.
const (
	ApprovalPending  = "pending"
	ApprovalApproved = "approved"
	ApprovalDenied   = "denied"
	ApprovalExpired  = "expired"
	ApprovalUsed     = "used"
)

// ErrAlreadyDecided is returned when deciding a request that is no longer pending.
var ErrAlreadyDecided = errors.New("this request was already decided or has expired")

type Approval struct {
	ID            string          `json:"id"`
	Tenant        string          `json:"-"`
	EndpointID    string          `json:"endpoint_id"`
	Fingerprint   string          `json:"fingerprint"`
	Agent         string          `json:"agent"`
	SessionID     string          `json:"session_id"`
	Tool          string          `json:"tool"`
	Summary       string          `json:"summary"`
	Cwd           string          `json:"cwd"`
	Rule          string          `json:"rule"`
	Reason        string          `json:"reason"`
	Hostname      string          `json:"hostname"`
	OSUser        string          `json:"os_user"`
	State         string          `json:"state"`
	RequestedAt   time.Time       `json:"requested_at"`
	ExpiresAt     time.Time       `json:"expires_at"`
	DecidedAt     *time.Time      `json:"decided_at"`
	DecidedBy     string          `json:"decided_by"`
	DecidedByName string          `json:"decided_by_name"`
	Note          string          `json:"note"`
	UsedAt        *time.Time      `json:"used_at"`
	Notified      json.RawMessage `json:"notified,omitempty"`
	GroupID       string          `json:"group_id"` // the approver group it was routed to ("" = workspace admins)
	RouteID       string          `json:"route_id"` // the routing rule that matched
}

const approvalCols = `id, tenant_ref, endpoint_id, fingerprint, agent, session_id, tool, summary, cwd, rule, reason,
  hostname, os_user, state, requested_at, expires_at, decided_at, decided_by, decided_by_name, note, used_at, notified, group_id, route_id`

func scanApproval(r pgx.Row) (Approval, error) {
	var a Approval
	err := r.Scan(&a.ID, &a.Tenant, &a.EndpointID, &a.Fingerprint, &a.Agent, &a.SessionID, &a.Tool, &a.Summary, &a.Cwd,
		&a.Rule, &a.Reason, &a.Hostname, &a.OSUser, &a.State, &a.RequestedAt, &a.ExpiresAt, &a.DecidedAt, &a.DecidedBy,
		&a.DecidedByName, &a.Note, &a.UsedAt, &a.Notified, &a.GroupID, &a.RouteID)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

func newApprovalID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "apr_" + hex.EncodeToString(b)
}

// RequestApproval files a request for one action, or returns the one already
// open for the same machine and fingerprint:
//   - approved and not yet used: it is consumed now (State "used" means
//     "go ahead" to the caller) — each approval lets one call through;
//   - pending: returned as is (no new request, no new notification);
//   - denied while the original request would still be open: returned, so a
//     retry doesn't re-ask the approvers;
//   - otherwise a new pending request; created is true.
func (s *Store) RequestApproval(ctx context.Context, a Approval, ttl time.Duration) (Approval, bool, error) {
	out, created, err := s.requestApproval(ctx, a, ttl)
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		// The same call arrived twice at once and the other one filed the
		// request first: use that one.
		return s.requestApproval(ctx, a, ttl)
	}
	return out, created, err
}

func (s *Store) requestApproval(ctx context.Context, a Approval, ttl time.Duration) (out Approval, created bool, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return out, false, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `update cp.approvals set state = 'expired'
		where tenant_ref = $1 and endpoint_id = $2 and fingerprint = $3 and state in ('pending', 'approved') and expires_at <= now()`,
		a.Tenant, a.EndpointID, a.Fingerprint); err != nil {
		return out, false, err
	}
	out, err = scanApproval(tx.QueryRow(ctx, `select `+approvalCols+` from cp.approvals
		where tenant_ref = $1 and endpoint_id = $2 and fingerprint = $3 and state in ('pending', 'approved') for update`,
		a.Tenant, a.EndpointID, a.Fingerprint))
	switch {
	case err == nil && out.State == ApprovalApproved:
		out, err = scanApproval(tx.QueryRow(ctx, `update cp.approvals set state = 'used', used_at = now()
			where id = $1 returning `+approvalCols, out.ID))
		if err != nil {
			return out, false, err
		}
		return out, false, tx.Commit(ctx)
	case err == nil:
		return out, false, tx.Commit(ctx)
	case !errors.Is(err, ErrNotFound):
		return out, false, err
	}
	out, err = scanApproval(tx.QueryRow(ctx, `select `+approvalCols+` from cp.approvals
		where tenant_ref = $1 and endpoint_id = $2 and fingerprint = $3 and state = 'denied' and expires_at > now()
		order by decided_at desc limit 1`, a.Tenant, a.EndpointID, a.Fingerprint))
	if err == nil {
		return out, false, tx.Commit(ctx)
	} else if !errors.Is(err, ErrNotFound) {
		return out, false, err
	}
	out, err = scanApproval(tx.QueryRow(ctx, `insert into cp.approvals
		(id, tenant_ref, endpoint_id, fingerprint, agent, session_id, tool, summary, cwd, rule, reason, hostname, os_user, expires_at)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + $14 * interval '1 second') returning `+approvalCols,
		newApprovalID(), a.Tenant, a.EndpointID, a.Fingerprint, a.Agent, a.SessionID, a.Tool, a.Summary, a.Cwd, a.Rule,
		a.Reason, a.Hostname, a.OSUser, int64(ttl.Seconds())))
	if err != nil {
		return out, false, err
	}
	return out, true, tx.Commit(ctx)
}

// ConsumeApproval turns an endpoint's approved request into "used" (the
// endpoint is letting the call through now). It returns the request in its
// current state; only an approved one changes.
func (s *Store) ConsumeApproval(ctx context.Context, endpointID, id string) (Approval, error) {
	a, err := scanApproval(s.db.QueryRow(ctx, `update cp.approvals set state = 'used', used_at = now()
		where id = $1 and endpoint_id = $2 and state = 'approved' and expires_at > now() returning `+approvalCols, id, endpointID))
	if err == nil || !errors.Is(err, ErrNotFound) {
		return a, err
	}
	return s.endpointApproval(ctx, endpointID, id)
}

// endpointApproval reads one request of an endpoint, expiring it if due.
func (s *Store) endpointApproval(ctx context.Context, endpointID, id string) (Approval, error) {
	if _, err := s.db.Exec(ctx, `update cp.approvals set state = 'expired'
		where id = $1 and state in ('pending', 'approved') and expires_at <= now()`, id); err != nil {
		return Approval{}, err
	}
	return scanApproval(s.db.QueryRow(ctx, `select `+approvalCols+` from cp.approvals where id = $1 and endpoint_id = $2`, id, endpointID))
}

// SetApprovalRoute records who a new request was routed to.
func (s *Store) SetApprovalRoute(ctx context.Context, id, groupID, routeID string) error {
	_, err := s.db.Exec(ctx, `update cp.approvals set group_id = $2, route_id = $3 where id = $1`, id, groupID, routeID)
	return err
}

// ---- routing ----

// RoutingConfig says who decides what: approver groups and ordered rules.
type RoutingConfig struct {
	Groups       []ApproverGroup `json:"groups"`
	Routes       []ApprovalRoute `json:"routes"`
	DefaultGroup string          `json:"default_group"` // requests no rule matches ("" = workspace admins)
	UpdatedBy    string          `json:"updated_by,omitempty"`
	UpdatedAt    *time.Time      `json:"updated_at,omitempty"`
}

type ApproverGroup struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
	Members     []GroupMember `json:"members"`
}

// GroupMember is a workspace member (Clerk user id) with their email for notifications.
type GroupMember struct {
	UserID string `json:"user_id"`
	Email  string `json:"email"`
	Name   string `json:"name,omitempty"`
}

// ApprovalRoute sends matching requests to a group. Empty lists match anything.
type ApprovalRoute struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Kinds    []string `json:"kinds"`    // command, website, tool, file
	Patterns []string `json:"patterns"` // any: case-insensitive text in the action or reason, * = wildcard
	Machines []string `json:"machines"` // hostnames
	Agents   []string `json:"agents"`
	GroupID  string   `json:"group_id"`
}

func (c RoutingConfig) Group(id string) *ApproverGroup {
	for i := range c.Groups {
		if c.Groups[i].ID == id {
			return &c.Groups[i]
		}
	}
	return nil
}

func (s *Store) GetRouting(ctx context.Context, tenant string) (RoutingConfig, error) {
	var c RoutingConfig
	var raw []byte
	var by string
	var at time.Time
	err := s.db.QueryRow(ctx, `select config, updated_by, updated_at from cp.approval_routing where tenant_ref = $1`, tenant).Scan(&raw, &by, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoutingConfig{Groups: []ApproverGroup{}, Routes: []ApprovalRoute{}}, nil
	} else if err != nil {
		return c, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	if c.Groups == nil {
		c.Groups = []ApproverGroup{}
	}
	if c.Routes == nil {
		c.Routes = []ApprovalRoute{}
	}
	c.UpdatedBy, c.UpdatedAt = by, &at
	return c, nil
}

func (s *Store) PutRouting(ctx context.Context, tenant, by string, c RoutingConfig) error {
	c.UpdatedBy, c.UpdatedAt = "", nil
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `insert into cp.approval_routing (tenant_ref, config, updated_by, updated_at) values ($1, $2, $3, now())
		on conflict (tenant_ref) do update set config = $2, updated_by = $3, updated_at = now()`, tenant, raw, by)
	return err
}

// SetApprovalNotified records how the request was announced.
func (s *Store) SetApprovalNotified(ctx context.Context, id string, notified json.RawMessage) error {
	_, err := s.db.Exec(ctx, `update cp.approvals set notified = $2 where id = $1`, id, notified)
	return err
}

// ListApprovals returns a tenant's requests, newest first. state "" lists all;
// "open" lists pending ones.
func (s *Store) ListApprovals(ctx context.Context, tenant, state string, limit int) ([]Approval, error) {
	if _, err := s.db.Exec(ctx, `update cp.approvals set state = 'expired'
		where tenant_ref = $1 and state in ('pending', 'approved') and expires_at <= now()`, tenant); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `select ` + approvalCols + ` from cp.approvals where tenant_ref = $1`
	args := []any{tenant}
	if state != "" {
		q += ` and state = $2`
		args = append(args, state)
	}
	q += ` order by requested_at desc limit ` + strconv.Itoa(limit)
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Approval{}
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DecideApproval approves or denies a pending request. An approval stays
// usable for at least useWindow, so a late approval isn't lost to the
// request's own expiry.
func (s *Store) DecideApproval(ctx context.Context, tenant, id string, approve bool, by, byName, note string, useWindow time.Duration) (Approval, error) {
	state := ApprovalDenied
	if approve {
		state = ApprovalApproved
	}
	a, err := scanApproval(s.db.QueryRow(ctx, `update cp.approvals
		set state = $3, decided_at = now(), decided_by = $4, decided_by_name = $5, note = $6,
		    expires_at = case when $3 = 'approved' then greatest(expires_at, now() + $7 * interval '1 second') else expires_at end
		where tenant_ref = $1 and id = $2 and state = 'pending' and expires_at > now() returning `+approvalCols,
		tenant, id, state, by, byName, note, int64(useWindow.Seconds())))
	if errors.Is(err, ErrNotFound) {
		if _, gerr := s.GetApproval(ctx, tenant, id); gerr != nil {
			return a, gerr
		}
		return a, ErrAlreadyDecided
	}
	return a, err
}

func (s *Store) GetApproval(ctx context.Context, tenant, id string) (Approval, error) {
	return scanApproval(s.db.QueryRow(ctx, `select `+approvalCols+` from cp.approvals where tenant_ref = $1 and id = $2`, tenant, id))
}

// ---- notification settings ----

type NotificationSettings struct {
	SlackWebhook string    `json:"-"`
	Emails       []string  `json:"emails"`
	UpdatedBy    string    `json:"updated_by"`
	UpdatedAt    time.Time `json:"updated_at"`
	SlackApp     SlackApp  `json:"-"`
}

// SlackApp is a tenant's connected Slack app. The token and secret are sealed
// by the server before they reach the store.
type SlackApp struct {
	BotTokenEnc      string
	SigningSecretEnc string
	Channel          string // channel id the bot posts to
	TeamID, TeamName string
	// Approvers: "members" (default) — the Slack user's email must belong to an
	// Effigent admin / security_admin; "workspace" — anyone in the connected
	// Slack workspace may decide (their identity is still recorded).
	Approvers string
}

func (a SlackApp) Connected() bool {
	return a.BotTokenEnc != "" && a.SigningSecretEnc != "" && a.TeamID != ""
}

func (s *Store) GetNotificationSettings(ctx context.Context, tenant string) (NotificationSettings, error) {
	var n NotificationSettings
	a := &n.SlackApp
	err := s.db.QueryRow(ctx, `select slack_webhook, emails, updated_by, updated_at,
		slack_bot_token_enc, slack_signing_secret_enc, slack_channel, slack_team_id, slack_team_name, slack_approvers
		from cp.notification_settings where tenant_ref = $1`,
		tenant).Scan(&n.SlackWebhook, &n.Emails, &n.UpdatedBy, &n.UpdatedAt,
		&a.BotTokenEnc, &a.SigningSecretEnc, &a.Channel, &a.TeamID, &a.TeamName, &a.Approvers)
	if errors.Is(err, pgx.ErrNoRows) {
		return NotificationSettings{Emails: []string{}, SlackApp: SlackApp{Approvers: "members"}}, nil
	}
	return n, err
}

func (s *Store) PutNotificationSettings(ctx context.Context, tenant string, n NotificationSettings) error {
	if n.Emails == nil {
		n.Emails = []string{}
	}
	if n.SlackApp.Approvers == "" {
		n.SlackApp.Approvers = "members"
	}
	a := n.SlackApp
	_, err := s.db.Exec(ctx, `insert into cp.notification_settings (tenant_ref, slack_webhook, emails, updated_by, updated_at,
			slack_bot_token_enc, slack_signing_secret_enc, slack_channel, slack_team_id, slack_team_name, slack_approvers)
		values ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10)
		on conflict (tenant_ref) do update set slack_webhook = $2, emails = $3, updated_by = $4, updated_at = now(),
			slack_bot_token_enc = $5, slack_signing_secret_enc = $6, slack_channel = $7, slack_team_id = $8,
			slack_team_name = $9, slack_approvers = $10`,
		tenant, n.SlackWebhook, n.Emails, n.UpdatedBy, a.BotTokenEnc, a.SigningSecretEnc, a.Channel, a.TeamID, a.TeamName, a.Approvers)
	return err
}
