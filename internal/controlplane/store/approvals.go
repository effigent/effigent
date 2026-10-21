package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
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
	// How it is decided, fixed when it is filed (migration 012).
	ApprovalsRequired int       `json:"approvals_required"` // different people who must approve
	ExcludeRequester  bool      `json:"exclude_requester"`  // the requester may not approve it
	RequireTicket     bool      `json:"require_ticket"`     // approving needs a ticket reference
	Requester         Requester `json:"requester"`
	SlackRef          string    `json:"-"`     // "channel:ts" of the Slack app's message
	Votes             []Vote    `json:"votes"` // in the order they were cast
}

// Requester is who asked, as resolved when the request was filed: the
// machine's owner and the people its OS user, hostname or git email are
// mapped to (cp.people), with the other emails those people go by.
type Requester struct {
	UserIDs []string `json:"user_ids"` // console user ids (an owner set as a user id)
	Emails  []string `json:"emails"`   // lower case
	Label   string   `json:"label"`    // how the console names them
}

// Matches reports whether a person (console user id and/or emails) is the requester.
func (q Requester) Matches(userID string, emails []string) bool {
	if userID != "" && slices.Contains(q.UserIDs, userID) {
		return true
	}
	for _, e := range emails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" && slices.Contains(q.Emails, e) {
			return true
		}
	}
	return false
}

// Merge adds another resolution of the requester (the one made at decision time).
func (q Requester) Merge(o Requester) Requester {
	out := Requester{UserIDs: slices.Clone(q.UserIDs), Emails: slices.Clone(q.Emails), Label: cmpStr(q.Label, o.Label)}
	for _, u := range o.UserIDs {
		if !slices.Contains(out.UserIDs, u) {
			out.UserIDs = append(out.UserIDs, u)
		}
	}
	for _, e := range o.Emails {
		if !slices.Contains(out.Emails, e) {
			out.Emails = append(out.Emails, e)
		}
	}
	return out
}

// Vote is one person's decision on a request.
type Vote struct {
	Voter         string    `json:"voter"`   // console user id, link:email:<addr>, slack:<team>:<user>, apikey:<id>
	UserID        string    `json:"user_id"` // the console user, when known
	Emails        []string  `json:"emails"`
	Name          string    `json:"name"`
	Via           string    `json:"via"`      // console | api-key | email | slack
	Decision      string    `json:"decision"` // approve | deny
	Note          string    `json:"note"`
	Ticket        string    `json:"ticket"`
	TicketURL     string    `json:"ticket_url,omitempty"` // filled in by the server from the tenant's template
	AdminOverride bool      `json:"admin_override"`
	At            time.Time `json:"at"`
}

// SamePerson reports whether two votes come from one person: the same voter,
// console user or an email in common (one person may decide from the
// console, an email link and Slack).
func (v Vote) SamePerson(o Vote) bool {
	if v.Voter == o.Voter || (v.UserID != "" && v.UserID == o.UserID) {
		return true
	}
	for _, e := range v.Emails {
		if slices.ContainsFunc(o.Emails, func(x string) bool { return strings.EqualFold(x, e) }) {
			return true
		}
	}
	return false
}

// Approvals counts the approve votes.
func (a Approval) Approvals() int {
	n := 0
	for _, v := range a.Votes {
		if v.Decision == "approve" {
			n++
		}
	}
	return n
}

// ErrAlreadyVoted: this person already decided the request.
var ErrAlreadyVoted = errors.New("you already approved this request; it needs another approver")

const approvalCols = `id, tenant_ref, endpoint_id, fingerprint, agent, session_id, tool, summary, cwd, rule, reason,
  hostname, os_user, state, requested_at, expires_at, decided_at, decided_by, decided_by_name, note, used_at, notified, group_id, route_id,
  approvals_required, exclude_requester, require_ticket, requester, slack_ref`

func scanApproval(r pgx.Row) (Approval, error) {
	var a Approval
	err := r.Scan(&a.ID, &a.Tenant, &a.EndpointID, &a.Fingerprint, &a.Agent, &a.SessionID, &a.Tool, &a.Summary, &a.Cwd,
		&a.Rule, &a.Reason, &a.Hostname, &a.OSUser, &a.State, &a.RequestedAt, &a.ExpiresAt, &a.DecidedAt, &a.DecidedBy,
		&a.DecidedByName, &a.Note, &a.UsedAt, &a.Notified, &a.GroupID, &a.RouteID,
		&a.ApprovalsRequired, &a.ExcludeRequester, &a.RequireTicket, &a.Requester, &a.SlackRef)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrNotFound
	}
	if a.Requester.UserIDs == nil {
		a.Requester.UserIDs = []string{}
	}
	if a.Requester.Emails == nil {
		a.Requester.Emails = []string{}
	}
	a.Votes = []Vote{}
	return a, err
}

const voteCols = `approval_id, voter, voter_user_id, voter_emails, voter_name, via, decision, note, ticket, admin_override, at`

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// withVotes fills in the votes of the given requests.
func withVotes(ctx context.Context, q querier, as []Approval) error {
	if len(as) == 0 {
		return nil
	}
	idx := map[string]int{}
	ids := make([]string, 0, len(as))
	for i := range as {
		idx[as[i].ID] = i
		ids = append(ids, as[i].ID)
	}
	rows, err := q.Query(ctx, `select `+voteCols+` from cp.approval_votes where approval_id = any($1) order by at, voter`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var v Vote
		if err := rows.Scan(&id, &v.Voter, &v.UserID, &v.Emails, &v.Name, &v.Via, &v.Decision, &v.Note, &v.Ticket, &v.AdminOverride, &v.At); err != nil {
			return err
		}
		if i, ok := idx[id]; ok {
			as[i].Votes = append(as[i].Votes, v)
		}
	}
	return rows.Err()
}

// withVotesOne is withVotes for one request read with err.
func withVotesOne(ctx context.Context, q querier, a Approval, err error) (Approval, error) {
	if err != nil {
		return a, err
	}
	as := []Approval{a}
	err = withVotes(ctx, q, as)
	return as[0], err
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
		out, created, err = s.requestApproval(ctx, a, ttl)
	}
	if err == nil && !created {
		out, err = withVotesOne(ctx, s.db, out, nil) // a pending request may carry a first approval
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
	a, err := scanApproval(s.db.QueryRow(ctx, `select `+approvalCols+` from cp.approvals where id = $1 and endpoint_id = $2`, id, endpointID))
	return withVotesOne(ctx, s.db, a, err)
}

// ApprovalFiling is how a new request is decided: who it was routed to and
// the rules of that route, and who asked.
type ApprovalFiling struct {
	GroupID, RouteID  string
	ApprovalsRequired int
	ExcludeRequester  bool
	RequireTicket     bool
	Requester         Requester
}

// SetApprovalFiling records how a new request is decided.
func (s *Store) SetApprovalFiling(ctx context.Context, id string, f ApprovalFiling) error {
	if f.Requester.UserIDs == nil {
		f.Requester.UserIDs = []string{}
	}
	if f.Requester.Emails == nil {
		f.Requester.Emails = []string{}
	}
	_, err := s.db.Exec(ctx, `update cp.approvals set group_id = $2, route_id = $3, approvals_required = $4, exclude_requester = $5,
		require_ticket = $6, requester = $7 where id = $1`,
		id, f.GroupID, f.RouteID, max(f.ApprovalsRequired, 1), f.ExcludeRequester, f.RequireTicket, f.Requester)
	return err
}

// SetApprovalSlackRef records the Slack app's message for a request ("channel:ts").
func (s *Store) SetApprovalSlackRef(ctx context.Context, id, ref string) error {
	_, err := s.db.Exec(ctx, `update cp.approvals set slack_ref = $2 where id = $1`, id, ref)
	return err
}

// GitEmailsSeen lists the git emails effigentd reported for an OS user on a
// machine since a day (cp.agent_activity_daily).
func (s *Store) GitEmailsSeen(ctx context.Context, tenant, endpointID, osUser string, since time.Time) ([]string, error) {
	rows, err := s.db.Query(ctx, `select distinct lower(git_email) from cp.agent_activity_daily
		where tenant_ref = $1 and endpoint_id::text = $2 and ($3 = '' or os_user = lower($3)) and git_email <> '' and day >= $4::date`,
		tenant, endpointID, osUser, since.UTC().Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ---- routing ----

// RoutingConfig says who decides what: approver groups and ordered rules.
type RoutingConfig struct {
	Groups       []ApproverGroup `json:"groups"`
	Routes       []ApprovalRoute `json:"routes"`
	DefaultGroup string          `json:"default_group"` // requests no rule matches ("" = workspace admins)
	DefaultRules ApprovalRules   `json:"default_rules"` // how those requests are decided
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
	ApprovalRules
}

// ApprovalRules say how a routed request is decided.
type ApprovalRules struct {
	ApprovalsRequired int `json:"approvals_required"` // 1 (default) or 2 different people
	// ExcludeRequester: the people behind the request may not approve it,
	// admins included. Missing (configs from before it existed) = true.
	ExcludeRequester *bool `json:"exclude_requester,omitempty"`
	RequireTicket    bool  `json:"require_ticket"` // approving needs a ticket reference
}

// Required is the number of different people who must approve.
func (r ApprovalRules) Required() int { return min(max(r.ApprovalsRequired, 1), 2) }

// Excludes reports whether the requester is kept from approving.
func (r ApprovalRules) Excludes() bool { return r.ExcludeRequester == nil || *r.ExcludeRequester }

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
	out := []Approval{}
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, withVotes(ctx, s.db, out)
}

// VoteApproval records one person's decision on a pending request, in one
// transaction with the request locked: a deny decides it (denied); an
// approve decides it once approvals_required different people approved
// (approved), else it stays pending. An approval stays usable for at least
// useWindow, so a late approval isn't lost to the request's own expiry.
// final reports whether this vote decided the request.
func (s *Store) VoteApproval(ctx context.Context, tenant, id string, v Vote, useWindow time.Duration) (a Approval, final bool, err error) {
	if v.Decision != "approve" && v.Decision != "deny" {
		return a, false, errors.New("decision must be approve or deny")
	}
	if v.Emails == nil {
		v.Emails = []string{}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return a, false, err
	}
	defer tx.Rollback(ctx)
	a, err = scanApproval(tx.QueryRow(ctx, `select `+approvalCols+` from cp.approvals
		where tenant_ref = $1 and id = $2 for update`, tenant, id))
	if a, err = withVotesOne(ctx, tx, a, err); err != nil {
		return a, false, err
	}
	if a.State != ApprovalPending || !a.ExpiresAt.After(time.Now()) {
		return a, false, ErrAlreadyDecided
	}
	for _, o := range a.Votes {
		if o.SamePerson(v) {
			return a, false, ErrAlreadyVoted
		}
	}
	if err := tx.QueryRow(ctx, `insert into cp.approval_votes (approval_id, tenant_ref, voter, voter_user_id, voter_emails, voter_name, via,
			decision, note, ticket, admin_override) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning at`,
		a.ID, tenant, v.Voter, v.UserID, v.Emails, v.Name, v.Via, v.Decision, v.Note, v.Ticket, v.AdminOverride).Scan(&v.At); err != nil {
		return a, false, err
	}
	a.Votes = append(a.Votes, v)
	state := ApprovalPending
	switch {
	case v.Decision == "deny":
		state = ApprovalDenied
	case a.Approvals() >= max(a.ApprovalsRequired, 1):
		state = ApprovalApproved
	}
	if state != ApprovalPending {
		// the request names everyone who approved; a deny names the one who denied
		var names, notes []string
		for _, x := range a.Votes {
			if x.Decision == v.Decision {
				names = append(names, x.Name)
				if x.Note != "" {
					notes = append(notes, x.Note)
				}
			}
		}
		if v.Decision == "deny" {
			names, notes = []string{v.Name}, nil
			if v.Note != "" {
				notes = []string{v.Note}
			}
		}
		votes := a.Votes
		a, err = scanApproval(tx.QueryRow(ctx, `update cp.approvals
			set state = $2, decided_at = now(), decided_by = $3, decided_by_name = $4, note = $5,
			    expires_at = case when $2 = 'approved' then greatest(expires_at, now() + $6 * interval '1 second') else expires_at end
			where id = $1 returning `+approvalCols,
			a.ID, state, v.Voter, strings.Join(names, " and "), strings.Join(notes, "; "), int64(useWindow.Seconds())))
		if err != nil {
			return a, false, err
		}
		a.Votes = votes
	}
	return a, state != ApprovalPending, tx.Commit(ctx)
}

func (s *Store) GetApproval(ctx context.Context, tenant, id string) (Approval, error) {
	a, err := scanApproval(s.db.QueryRow(ctx, `select `+approvalCols+` from cp.approvals where tenant_ref = $1 and id = $2`, tenant, id))
	return withVotesOne(ctx, s.db, a, err)
}

// ---- notification settings ----

type NotificationSettings struct {
	SlackWebhook string    `json:"-"`
	Emails       []string  `json:"emails"`
	UpdatedBy    string    `json:"updated_by"`
	UpdatedAt    time.Time `json:"updated_at"`
	SlackApp     SlackApp  `json:"-"`
	// TicketURLTemplate turns ticket keys on votes into links: https://acme.atlassian.net/browse/{key}
	TicketURLTemplate string `json:"ticket_url_template"`
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
		slack_bot_token_enc, slack_signing_secret_enc, slack_channel, slack_team_id, slack_team_name, slack_approvers, ticket_url_template
		from cp.notification_settings where tenant_ref = $1`,
		tenant).Scan(&n.SlackWebhook, &n.Emails, &n.UpdatedBy, &n.UpdatedAt,
		&a.BotTokenEnc, &a.SigningSecretEnc, &a.Channel, &a.TeamID, &a.TeamName, &a.Approvers, &n.TicketURLTemplate)
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
			slack_bot_token_enc, slack_signing_secret_enc, slack_channel, slack_team_id, slack_team_name, slack_approvers, ticket_url_template)
		values ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10, $11)
		on conflict (tenant_ref) do update set slack_webhook = $2, emails = $3, updated_by = $4, updated_at = now(),
			slack_bot_token_enc = $5, slack_signing_secret_enc = $6, slack_channel = $7, slack_team_id = $8,
			slack_team_name = $9, slack_approvers = $10, ticket_url_template = $11`,
		tenant, n.SlackWebhook, n.Emails, n.UpdatedBy, a.BotTokenEnc, a.SigningSecretEnc, a.Channel, a.TeamID, a.TeamName, a.Approvers, n.TicketURLTemplate)
	return err
}
