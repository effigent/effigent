package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

type AuditEntry struct {
	Seq       int64           `json:"seq"`
	At        time.Time       `json:"at"`
	Actor     string          `json:"actor"`
	ActorVia  string          `json:"actor_via"`
	ActorRole string          `json:"actor_role"`
	Action    string          `json:"action"`
	Target    string          `json:"target"`
	Details   json.RawMessage `json:"details"`
	IP        string          `json:"ip"`
	PrevHash  string          `json:"prev_hash"`
	Hash      string          `json:"hash"`
}

// auditHash covers everything about an entry except its own hash and seq.
// Time is truncated to microseconds, which is what Postgres stores.
func auditHash(tenant string, e AuditEntry) string {
	canon, _ := json.Marshal([]any{tenant, e.At.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano),
		e.Actor, e.ActorVia, e.ActorRole, e.Action, e.Target, string(e.Details), e.IP, e.PrevHash})
	sum := sha256.Sum256(canon)
	return hex.EncodeToString(sum[:])
}

const genesis = "genesis"

// AppendAudit adds an entry to the tenant's chain. A per-tenant advisory lock
// serializes appends so the chain never forks.
func (s *Store) AppendAudit(ctx context.Context, tenant string, e AuditEntry) error {
	if len(e.Details) == 0 {
		e.Details = json.RawMessage(`{}`)
	}
	// Normalize JSON so the hash matches what jsonb gives back on read.
	var v any
	if json.Unmarshal(e.Details, &v) == nil {
		e.Details, _ = json.Marshal(v)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtext('cp.audit:' || $1))`, tenant); err != nil {
		return err
	}
	e.PrevHash = genesis
	err = tx.QueryRow(ctx, `select hash from cp.audit_log where tenant_ref = $1 order by seq desc limit 1`, tenant).Scan(&e.PrevHash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	e.At = time.Now().UTC().Truncate(time.Microsecond)
	e.Hash = auditHash(tenant, e)
	if _, err := tx.Exec(ctx, `insert into cp.audit_log (tenant_ref, at, actor, actor_via, actor_role, action, target, details, ip, prev_hash, hash)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		tenant, e.At, e.Actor, e.ActorVia, e.ActorRole, e.Action, e.Target, e.Details, e.IP, e.PrevHash, e.Hash); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scanAudit(rows pgx.Rows) ([]AuditEntry, error) {
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		var details []byte
		if err := rows.Scan(&e.Seq, &e.At, &e.Actor, &e.ActorVia, &e.ActorRole, &e.Action, &e.Target, &details, &e.IP, &e.PrevHash, &e.Hash); err != nil {
			return nil, err
		}
		var v any
		_ = json.Unmarshal(details, &v)
		e.Details, _ = json.Marshal(v)
		out = append(out, e)
	}
	return out, rows.Err()
}

const auditCols = `seq, at, actor, actor_via, actor_role, action, target, details, ip, prev_hash, hash`

// ListAudit returns the newest entries first, optionally filtered by action prefix or actor.
func (s *Store) ListAudit(ctx context.Context, tenant string, limit int, actionPrefix, actor string) ([]AuditEntry, error) {
	rows, err := s.db.Query(ctx, `select `+auditCols+` from cp.audit_log
		where tenant_ref = $1 and ($3 = '' or action like $3 || '%') and ($4 = '' or actor = $4)
		order by seq desc limit $2`, tenant, limit, actionPrefix, actor)
	if err != nil {
		return nil, err
	}
	return scanAudit(rows)
}

type AuditVerification struct {
	OK       bool   `json:"ok"`
	Entries  int    `json:"entries"`
	BrokenAt int64  `json:"broken_at,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Head     string `json:"head,omitempty"`
}

// VerifyAudit recomputes the whole chain for a tenant.
func (s *Store) VerifyAudit(ctx context.Context, tenant string) (AuditVerification, error) {
	rows, err := s.db.Query(ctx, `select `+auditCols+` from cp.audit_log where tenant_ref = $1 order by seq`, tenant)
	if err != nil {
		return AuditVerification{}, err
	}
	all, err := scanAudit(rows)
	if err != nil {
		return AuditVerification{}, err
	}
	prev := genesis
	for _, e := range all {
		if e.PrevHash != prev {
			return AuditVerification{Entries: len(all), BrokenAt: e.Seq, Reason: "entry does not link to the one before it (an entry was removed or reordered)"}, nil
		}
		if auditHash(tenant, e) != e.Hash {
			return AuditVerification{Entries: len(all), BrokenAt: e.Seq, Reason: fmt.Sprintf("entry %d content does not match its hash (it was modified)", e.Seq)}, nil
		}
		prev = e.Hash
	}
	return AuditVerification{OK: true, Entries: len(all), Head: prev}, nil
}
