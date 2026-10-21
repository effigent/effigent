package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// PolicySettings are a tenant's rules for changing policy.
type PolicySettings struct {
	// ChangeApproval: every change that would publish a policy version is a
	// proposal another admin must approve.
	ChangeApproval bool       `json:"policy_change_approval"`
	UpdatedBy      string     `json:"updated_by,omitempty"`
	UpdatedAt      *time.Time `json:"updated_at,omitempty"`
}

func (s *Store) GetPolicySettings(ctx context.Context, tenant string) (PolicySettings, error) {
	var p PolicySettings
	var at time.Time
	err := s.db.QueryRow(ctx, `select policy_change_approval, updated_by, updated_at from cp.policy_settings where tenant_ref = $1`, tenant).
		Scan(&p.ChangeApproval, &p.UpdatedBy, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return PolicySettings{}, nil
	}
	if err == nil {
		p.UpdatedAt = &at
	}
	return p, err
}

func (s *Store) PutPolicySettings(ctx context.Context, tenant string, p PolicySettings, by string) error {
	_, err := s.db.Exec(ctx, `insert into cp.policy_settings (tenant_ref, policy_change_approval, updated_by) values ($1, $2, $3)
		on conflict (tenant_ref) do update set policy_change_approval = $2, updated_by = $3, updated_at = now()`, tenant, p.ChangeApproval, by)
	return err
}

// Proposal states.
const (
	ProposalPending    = "pending"
	ProposalApproved   = "approved"
	ProposalRejected   = "rejected"
	ProposalSuperseded = "superseded"
	ProposalWithdrawn  = "withdrawn"
)

// ErrProposalClosed: the proposal was already decided, withdrawn or superseded.
var ErrProposalClosed = errors.New("this proposal is no longer pending")

// Proposal is a policy change waiting for a second admin.
type Proposal struct {
	ID          string          `json:"id"`
	Tenant      string          `json:"-"`
	Kind        string          `json:"kind"` // policy | exception.create | exception.delete | endpoint.owner | settings
	Payload     json.RawMessage `json:"payload"`
	Summary     string          `json:"summary"`
	BaseVersion int64           `json:"base_version"`
	Author      string          `json:"author"`
	AuthorName  string          `json:"author_name"`
	AuthorVia   string          `json:"author_via"`
	AuthorOwner string          `json:"author_owner,omitempty"` // an API key author: who created the key
	State       string          `json:"state"`
	DecidedBy   string          `json:"decided_by,omitempty"`
	DecidedName string          `json:"decided_by_name,omitempty"`
	Note        string          `json:"note,omitempty"`
	Version     int64           `json:"version,omitempty"` // published when applied
	CreatedAt   time.Time       `json:"created_at"`
	DecidedAt   *time.Time      `json:"decided_at,omitempty"`
}

const proposalCols = `id, tenant_ref, kind, payload, summary, base_version, author, author_name, author_via, author_owner, state,
	decided_by, decided_name, note, version, created_at, decided_at`

func scanProposal(r pgx.Row) (Proposal, error) {
	var p Proposal
	err := r.Scan(&p.ID, &p.Tenant, &p.Kind, &p.Payload, &p.Summary, &p.BaseVersion, &p.Author, &p.AuthorName, &p.AuthorVia, &p.AuthorOwner, &p.State,
		&p.DecidedBy, &p.DecidedName, &p.Note, &p.Version, &p.CreatedAt, &p.DecidedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

func (s *Store) CreateProposal(ctx context.Context, p Proposal) (Proposal, error) {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	p.ID = "prp_" + hex.EncodeToString(b)
	return scanProposal(s.db.QueryRow(ctx, `insert into cp.policy_proposals (id, tenant_ref, kind, payload, summary, base_version, author, author_name, author_via, author_owner)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning `+proposalCols,
		p.ID, p.Tenant, p.Kind, p.Payload, p.Summary, p.BaseVersion, p.Author, p.AuthorName, p.AuthorVia, p.AuthorOwner))
}

func (s *Store) GetProposal(ctx context.Context, tenant, id string) (Proposal, error) {
	return scanProposal(s.db.QueryRow(ctx, `select `+proposalCols+` from cp.policy_proposals where tenant_ref = $1 and id = $2`, tenant, id))
}

// ListProposals returns the newest proposals, pending ones first; state ""
// = any.
func (s *Store) ListProposals(ctx context.Context, tenant, state string, limit int) ([]Proposal, error) {
	rows, err := s.db.Query(ctx, `select `+proposalCols+` from cp.policy_proposals where tenant_ref = $1 and ($2 = '' or state = $2)
		order by (state = 'pending') desc, created_at desc limit $3`, tenant, state, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Proposal{}
	for rows.Next() {
		p, err := scanProposal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// CloseProposal moves a pending proposal to state (approved, rejected,
// superseded, withdrawn). Approving claims it: only one caller wins, so a
// change is applied once even when two admins click at the same time.
func (s *Store) CloseProposal(ctx context.Context, tenant, id, state, by, name, note string) (Proposal, error) {
	p, err := scanProposal(s.db.QueryRow(ctx, `update cp.policy_proposals set state = $3, decided_by = $4, decided_name = $5, note = $6, decided_at = now()
		where tenant_ref = $1 and id = $2 and state = 'pending' returning `+proposalCols, tenant, id, state, by, name, note))
	if errors.Is(err, ErrNotFound) {
		if _, err := s.GetProposal(ctx, tenant, id); err != nil {
			return p, err
		}
		return p, ErrProposalClosed
	}
	return p, err
}

// ReopenProposal puts a claimed proposal back when applying it failed.
func (s *Store) ReopenProposal(ctx context.Context, tenant, id string) error {
	_, err := s.db.Exec(ctx, `update cp.policy_proposals set state = 'pending', decided_by = '', decided_name = '', note = '', decided_at = null
		where tenant_ref = $1 and id = $2 and state = 'approved' and version = 0`, tenant, id)
	return err
}

// ProposalApplied records the version an approved proposal published.
func (s *Store) ProposalApplied(ctx context.Context, tenant, id string, version int64) error {
	_, err := s.db.Exec(ctx, `update cp.policy_proposals set version = $3 where tenant_ref = $1 and id = $2`, tenant, id, version)
	return err
}
