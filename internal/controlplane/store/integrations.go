package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- API keys ----

type APIKey struct {
	ID         string     `json:"id"`
	Tenant     string     `json:"-"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Scopes     []string   `json:"scopes"`
	CreatedBy  string     `json:"created_by"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	Revoked    bool       `json:"revoked"`
	Key        string     `json:"key,omitempty"` // only when just created
}

const apiKeyCols = `id, tenant_ref, name, prefix, scopes, created_by, created_at, expires_at, last_used_at, revoked_at is not null`

func scanAPIKey(r pgx.Row) (APIKey, error) {
	var k APIKey
	err := r.Scan(&k.ID, &k.Tenant, &k.Name, &k.Prefix, &k.Scopes, &k.CreatedBy, &k.CreatedAt, &k.ExpiresAt, &k.LastUsedAt, &k.Revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return k, ErrNotFound
	}
	return k, err
}

// CreateAPIKey stores a new key and returns it with the secret (shown once).
func (s *Store) CreateAPIKey(ctx context.Context, tenant, name, by string, scopes []string, expires *time.Time) (APIKey, error) {
	secret := randomToken("efk_")
	k, err := scanAPIKey(s.db.QueryRow(ctx, `insert into cp.api_keys (tenant_ref, name, prefix, key_hash, scopes, created_by, expires_at)
		values ($1, $2, $3, $4, $5, $6, $7) returning `+apiKeyCols, tenant, name, secret[:12], hash(secret), scopes, by, expires))
	k.Key = secret
	return k, err
}

// AuthAPIKey finds a live key by its secret, and records its use (at most
// once a minute, so a busy automation doesn't write on every request).
func (s *Store) AuthAPIKey(ctx context.Context, secret string) (APIKey, error) {
	k, err := scanAPIKey(s.db.QueryRow(ctx, `select `+apiKeyCols+` from cp.api_keys
		where key_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`, hash(secret)))
	if err != nil {
		return k, err
	}
	if k.LastUsedAt == nil || time.Since(*k.LastUsedAt) > time.Minute {
		_, _ = s.db.Exec(ctx, `update cp.api_keys set last_used_at = now() where id = $1`, k.ID)
	}
	return k, nil
}

func (s *Store) ListAPIKeys(ctx context.Context, tenant string) ([]APIKey, error) {
	rows, err := s.db.Query(ctx, `select `+apiKeyCols+` from cp.api_keys where tenant_ref = $1 order by created_at desc`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIKey{}
	for rows.Next() {
		k, err := scanAPIKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) RevokeAPIKey(ctx context.Context, tenant, id string) error {
	t, err := s.db.Exec(ctx, `update cp.api_keys set revoked_at = now() where tenant_ref = $1 and id::text = $2 and revoked_at is null`, tenant, id)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// ---- webhooks ----

type Webhook struct {
	ID            string     `json:"id"`
	Tenant        string     `json:"-"`
	Name          string     `json:"name"`
	URL           string     `json:"-"` // may carry the receiver's token: never returned
	Secret        string     `json:"-"`
	Events        []string   `json:"events"`
	Enabled       bool       `json:"enabled"`
	CreatedBy     string     `json:"created_by"`
	CreatedAt     time.Time  `json:"created_at"`
	LastStatus    *int       `json:"last_status"`
	LastError     string     `json:"last_error"`
	LastAttemptAt *time.Time `json:"last_attempt_at"`
	Dropped       int64      `json:"dropped"`
}

const webhookCols = `id, tenant_ref, name, url, secret, events, enabled, created_by, created_at, last_status, last_error, last_attempt_at, dropped`

func scanWebhook(r pgx.Row) (Webhook, error) {
	var h Webhook
	err := r.Scan(&h.ID, &h.Tenant, &h.Name, &h.URL, &h.Secret, &h.Events, &h.Enabled, &h.CreatedBy, &h.CreatedAt,
		&h.LastStatus, &h.LastError, &h.LastAttemptAt, &h.Dropped)
	if errors.Is(err, pgx.ErrNoRows) {
		return h, ErrNotFound
	}
	return h, err
}

func (s *Store) CreateWebhook(ctx context.Context, tenant, name, url string, events []string, by string) (Webhook, error) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return scanWebhook(s.db.QueryRow(ctx, `insert into cp.webhooks (tenant_ref, name, url, secret, events, created_by)
		values ($1, $2, $3, $4, $5, $6) returning `+webhookCols, tenant, name, url, "whsec_"+hex.EncodeToString(b), events, by))
}

func (s *Store) ListWebhooks(ctx context.Context, tenant string) ([]Webhook, error) {
	rows, err := s.db.Query(ctx, `select `+webhookCols+` from cp.webhooks where tenant_ref = $1 order by created_at`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Webhook{}
	for rows.Next() {
		h, err := scanWebhook(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *Store) GetWebhook(ctx context.Context, tenant, id string) (Webhook, error) {
	return scanWebhook(s.db.QueryRow(ctx, `select `+webhookCols+` from cp.webhooks where tenant_ref = $1 and id::text = $2`, tenant, id))
}

func (s *Store) DeleteWebhook(ctx context.Context, tenant, id string) error {
	t, err := s.db.Exec(ctx, `delete from cp.webhooks where tenant_ref = $1 and id::text = $2`, tenant, id)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Store) AddWebhookDropped(ctx context.Context, id string, n int) error {
	_, err := s.db.Exec(ctx, `update cp.webhooks set dropped = dropped + $2 where id = $1`, id, n)
	return err
}

// ---- deliveries ----

type Delivery struct {
	ID          int64      `json:"id"`
	WebhookID   string     `json:"webhook_id"`
	EventID     string     `json:"event_id"`
	EventType   string     `json:"event_type"`
	Body        string     `json:"-"`
	Attempts    int        `json:"attempts"`
	State       string     `json:"state"`
	LastStatus  *int       `json:"last_status"`
	LastError   string     `json:"last_error"`
	CreatedAt   time.Time  `json:"created_at"`
	DeliveredAt *time.Time `json:"delivered_at"`
	// for the worker
	URL, Secret string `json:"-"`
}

// EnqueueDelivery queues one event for one webhook.
func (s *Store) EnqueueDelivery(ctx context.Context, webhookID, eventID, eventType, body string) error {
	_, err := s.db.Exec(ctx, `insert into cp.webhook_deliveries (webhook_id, event_id, event_type, body) values ($1, $2, $3, $4)`,
		webhookID, eventID, eventType, body)
	return err
}

// ClaimDeliveries locks up to n due deliveries for this worker and pushes
// their next attempt out by lease, so a crashed worker's rows come back.
func (s *Store) ClaimDeliveries(ctx context.Context, n int, lease time.Duration) ([]Delivery, error) {
	rows, err := s.db.Query(ctx, `update cp.webhook_deliveries d set next_attempt_at = now() + $2 * interval '1 second'
		from cp.webhooks h
		where d.webhook_id = h.id and d.id in (
			select id from cp.webhook_deliveries where state = 'pending' and next_attempt_at <= now()
			order by next_attempt_at limit $1 for update skip locked)
		returning d.id, d.webhook_id, d.event_id, d.event_type, d.body, d.attempts, h.url, h.secret`, n, int64(lease.Seconds()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.WebhookID, &d.EventID, &d.EventType, &d.Body, &d.Attempts, &d.URL, &d.Secret); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// FinishDelivery records an attempt: delivered, retry at next, or failed
// (next == nil and not delivered). The webhook's last_* fields follow.
func (s *Store) FinishDelivery(ctx context.Context, d Delivery, status int, errText string, delivered bool, next *time.Time) error {
	state := "pending"
	switch {
	case delivered:
		state = "delivered"
	case next == nil:
		state = "failed"
	}
	var st *int
	if status > 0 {
		st = &status
	}
	nextAt := time.Now()
	if next != nil {
		nextAt = *next
	}
	if _, err := s.db.Exec(ctx, `update cp.webhook_deliveries set attempts = attempts + 1, state = $2, last_status = $3, last_error = $4,
		next_attempt_at = $5, delivered_at = case when $2 = 'delivered' then now() else null end where id = $1`,
		d.ID, state, st, errText, nextAt); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `update cp.webhooks set last_status = $2, last_error = $3, last_attempt_at = now() where id = $1`,
		d.WebhookID, st, errText)
	return err
}

// ListDeliveries returns a webhook's recent deliveries, newest first.
func (s *Store) ListDeliveries(ctx context.Context, tenant, webhookID string, limit int) ([]Delivery, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.Query(ctx, `select d.id, d.webhook_id, d.event_id, d.event_type, d.attempts, d.state, d.last_status, d.last_error,
		d.created_at, d.delivered_at from cp.webhook_deliveries d join cp.webhooks h on h.id = d.webhook_id
		where h.tenant_ref = $1 and h.id::text = $2 order by d.id desc limit $3`, tenant, webhookID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.WebhookID, &d.EventID, &d.EventType, &d.Attempts, &d.State, &d.LastStatus, &d.LastError,
			&d.CreatedAt, &d.DeliveredAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
