package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Directory answers "who is this person in the workspace": the console role
// of the member with a verified email address. Approvals decided outside the
// console (Slack) use it to apply the console's rule — admins and
// security_admins decide.
type Directory interface {
	// MemberRole returns the role ("admin", "security_admin", "member", …)
	// of the tenant's member with this verified email, or "" for none.
	MemberRole(ctx context.Context, tenant, email string) (string, error)
}

// ClerkDirectory reads organization memberships from Clerk's Backend API
// (CLERK_SECRET_KEY). A personal workspace ("user:<id>") has one member, its
// owner, who is an admin.
type ClerkDirectory struct {
	SecretKey string
	BaseURL   string // default https://api.clerk.com
	HTTP      *http.Client

	mu     sync.Mutex
	cache  map[string]dirEntry
	emails map[string]userEntry // Clerk user id → verified emails
}

type userEntry struct {
	emails []string
	at     time.Time
}

// UserEmails returns a console user's verified emails, so the requester
// rule can recognise a person who signs in with an address the approver
// group doesn't list.
func (d *ClerkDirectory) UserEmails(ctx context.Context, tenant, userID string) ([]string, error) {
	d.mu.Lock()
	e, ok := d.emails[userID]
	d.mu.Unlock()
	if ok && time.Since(e.at) <= directoryTTL {
		return e.emails, nil
	}
	var u clerkUser
	if err := d.get(ctx, "/v1/users/"+url.PathEscape(userID), nil, &u); err != nil {
		return nil, err
	}
	e = userEntry{emails: u.verifiedEmails(), at: time.Now()}
	d.mu.Lock()
	if d.emails == nil {
		d.emails = map[string]userEntry{}
	}
	d.emails[userID] = e
	d.mu.Unlock()
	return e.emails, nil
}

type dirEntry struct {
	roles map[string]string // lower-case email → role
	at    time.Time
}

const directoryTTL = 2 * time.Minute

func (d *ClerkDirectory) MemberRole(ctx context.Context, tenant, email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	d.mu.Lock()
	e, ok := d.cache[tenant]
	d.mu.Unlock()
	if !ok || time.Since(e.at) > directoryTTL {
		roles, err := d.load(ctx, tenant)
		if err != nil {
			return "", err
		}
		e = dirEntry{roles: roles, at: time.Now()}
		d.mu.Lock()
		if d.cache == nil {
			d.cache = map[string]dirEntry{}
		}
		d.cache[tenant] = e
		d.mu.Unlock()
	}
	return e.roles[email], nil
}

type clerkUser struct {
	ID             string `json:"id"`
	EmailAddresses []struct {
		Email        string `json:"email_address"`
		Verification *struct {
			Status string `json:"status"`
		} `json:"verification"`
	} `json:"email_addresses"`
}

func (u clerkUser) verifiedEmails() []string {
	var out []string
	for _, e := range u.EmailAddresses {
		if e.Verification != nil && e.Verification.Status == "verified" {
			out = append(out, strings.ToLower(e.Email))
		}
	}
	return out
}

func (d *ClerkDirectory) load(ctx context.Context, tenant string) (map[string]string, error) {
	roles := map[string]string{}
	kind, id, _ := strings.Cut(tenant, ":")
	switch kind {
	case "user":
		var u clerkUser
		if err := d.get(ctx, "/v1/users/"+url.PathEscape(id), nil, &u); err != nil {
			return nil, err
		}
		for _, e := range u.verifiedEmails() {
			roles[e] = "admin"
		}
		return roles, nil
	case "org":
	default:
		return nil, fmt.Errorf("unknown tenant %q", tenant)
	}
	byUser := map[string]string{}
	for offset := 0; ; offset += 100 {
		var page struct {
			Data []struct {
				Role           string `json:"role"`
				PublicUserData struct {
					UserID string `json:"user_id"`
				} `json:"public_user_data"`
			} `json:"data"`
			Total int `json:"total_count"`
		}
		q := url.Values{"limit": {"100"}, "offset": {fmt.Sprint(offset)}}
		if err := d.get(ctx, "/v1/organizations/"+url.PathEscape(id)+"/memberships", q, &page); err != nil {
			return nil, err
		}
		for _, m := range page.Data {
			byUser[m.PublicUserData.UserID] = strings.TrimPrefix(m.Role, "org:")
		}
		if len(page.Data) < 100 || offset+100 >= page.Total || offset >= 2000 {
			break
		}
	}
	ids := make([]string, 0, len(byUser))
	for u := range byUser {
		ids = append(ids, u)
	}
	for i := 0; i < len(ids); i += 100 {
		q := url.Values{"limit": {"100"}}
		for _, u := range ids[i:min(i+100, len(ids))] {
			q.Add("user_id", u)
		}
		var users []clerkUser
		if err := d.get(ctx, "/v1/users", q, &users); err != nil {
			return nil, err
		}
		for _, u := range users {
			for _, e := range u.verifiedEmails() {
				roles[e] = byUser[u.ID]
			}
		}
	}
	return roles, nil
}

func (d *ClerkDirectory) get(ctx context.Context, path string, q url.Values, out any) error {
	base := d.BaseURL
	if base == "" {
		base = "https://api.clerk.com"
	}
	u := strings.TrimSuffix(base, "/") + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Authorization", "Bearer "+d.SecretKey)
	c := d.HTTP
	if c == nil {
		c = &http.Client{Timeout: 10 * time.Second}
	}
	res, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("clerk: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("clerk %s answered %d", path, res.StatusCode)
	}
	return json.Unmarshal(raw, out)
}
