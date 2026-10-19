package spend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Vendor clients. Each turns a vendor's admin API into Seats and UsageDays
// for a window. Field names follow the vendors' public docs (October 2026);
// they are exercised against httptest fakes, not the live APIs.

// Pull is what one sync brings back.
type Pull struct {
	Seats []Seat
	Usage []UsageDay
	Plan  string   // the company plan, when the vendor says (Copilot: business / enterprise)
	Notes []string // partial results (a page limit hit, an endpoint refused)
}

// Client pulls one vendor's data for [from, to).
type Client interface {
	Pull(ctx context.Context, from, to time.Time) (Pull, error)
}

// Config configures a vendor client.
type Config struct {
	Vendor  string
	Key     string // the admin API key / token (never logged)
	Org     string // GitHub organisation (Copilot)
	BaseURL string // tests point it at a fake; "" = the vendor's API
	HTTP    *http.Client
}

// DefaultBaseURL is each vendor's API.
var DefaultBaseURL = map[string]string{
	Cursor: "https://api.cursor.com", Anthropic: "https://api.anthropic.com",
	Copilot: "https://api.github.com", OpenAI: "https://api.openai.com",
}

const (
	maxPages     = 200
	maxBodyBytes = 32 << 20
	userAgent    = "Effigent/1.0 (+https://effigent.ai)"
)

// NewClient returns the client for c.Vendor.
func NewClient(c Config) (Client, error) {
	if strings.TrimSpace(c.Key) == "" {
		return nil, errors.New("no API key")
	}
	if c.BaseURL == "" {
		c.BaseURL = DefaultBaseURL[c.Vendor]
	}
	c.BaseURL = strings.TrimSuffix(c.BaseURL, "/")
	if c.HTTP == nil {
		c.HTTP = &http.Client{Timeout: 60 * time.Second}
	}
	h := &httpc{cfg: c}
	switch c.Vendor {
	case Cursor:
		return &cursorClient{h}, nil
	case Anthropic:
		return &anthropicClient{h}, nil
	case Copilot:
		if !validGitHubOrg(c.Org) {
			return nil, errors.New("set the GitHub organisation (e.g. acme)")
		}
		return &copilotClient{h}, nil
	case OpenAI:
		return &openaiClient{h}, nil
	}
	return nil, fmt.Errorf("unknown vendor %q", c.Vendor)
}

func validGitHubOrg(s string) bool {
	if s == "" || len(s) > 39 {
		return false
	}
	for _, r := range s {
		if !(r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
}

// ValidGitHubOrg reports whether s looks like a GitHub organisation login.
func ValidGitHubOrg(s string) bool { return validGitHubOrg(s) }

type httpc struct{ cfg Config }

// StatusError is a vendor's non-2xx answer.
type StatusError struct {
	Vendor string
	Status int
	Body   string
}

func (e *StatusError) Error() string {
	hint := ""
	switch e.Status {
	case http.StatusUnauthorized, http.StatusForbidden:
		hint = " — check the key and that it is an admin key"
	case http.StatusTooManyRequests:
		hint = " — rate limited, try again later"
	}
	return fmt.Sprintf("%s API answered %d%s: %s", VendorLabel[e.Vendor], e.Status, hint, e.Body)
}

func (h *httpc) do(ctx context.Context, method, path string, q url.Values, body any, out any) error {
	u := h.cfg.BaseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	switch h.cfg.Vendor {
	case Cursor:
		req.SetBasicAuth(h.cfg.Key, "")
	case Anthropic:
		req.Header.Set("x-api-key", h.cfg.Key)
		req.Header.Set("anthropic-version", "2023-06-01")
	case Copilot:
		req.Header.Set("Authorization", "Bearer "+h.cfg.Key)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	case OpenAI:
		req.Header.Set("Authorization", "Bearer "+h.cfg.Key)
	}
	res, err := h.cfg.HTTP.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // the URL is ours; keep the message short
		}
		return fmt.Errorf("%s API: %w", VendorLabel[h.cfg.Vendor], err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxBodyBytes))
	if err != nil {
		return err
	}
	if res.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(raw))
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		return &StatusError{Vendor: h.cfg.Vendor, Status: res.StatusCode, Body: strings.ReplaceAll(msg, h.cfg.Key, "[key]")}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s API: unexpected response from %s: %v", VendorLabel[h.cfg.Vendor], path, err)
	}
	return nil
}

// flexNumber reads a JSON number or a numeric string ("123.45").
type flexNumber float64

func (f *flexNumber) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	*f = flexNumber(v)
	return err
}

// flexTime reads RFC 3339, a date, or epoch milliseconds (number or string).
type flexTime struct{ time.Time }

func (t *flexTime) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		return nil
	}
	if ms, err := strconv.ParseInt(s, 10, 64); err == nil {
		if ms < 1e11 { // seconds
			ms *= 1000
		}
		t.Time = time.UnixMilli(ms).UTC()
		return nil
	}
	for _, l := range []string{time.RFC3339Nano, "2006-01-02"} {
		if v, err := time.Parse(l, s); err == nil {
			t.Time = v.UTC()
			return nil
		}
	}
	return fmt.Errorf("bad time %q", s)
}

func (t flexTime) ptr() *time.Time {
	if t.IsZero() {
		return nil
	}
	v := t.Time
	return &v
}

type usageKey struct {
	id  string
	day time.Time
}

// usageAcc sums usage per identity and day, keeping first-seen order.
type usageAcc struct {
	vendor string
	rows   map[usageKey]*UsageDay
	order  []usageKey
}

func newAcc(vendor string) *usageAcc {
	return &usageAcc{vendor: vendor, rows: map[usageKey]*UsageDay{}}
}

func (a *usageAcc) at(id string, day time.Time) *UsageDay {
	k := usageKey{strings.ToLower(strings.TrimSpace(id)), Day(day)}
	if r := a.rows[k]; r != nil {
		return r
	}
	r := &UsageDay{Vendor: a.vendor, Day: k.day, Identity: k.id, Source: "api"}
	a.rows[k] = r
	a.order = append(a.order, k)
	return r
}

func (a *usageAcc) list() []UsageDay {
	out := make([]UsageDay, 0, len(a.order))
	for _, k := range a.order {
		out = append(out, *a.rows[k])
	}
	return out
}

func cents(v float64) int64 { return int64(math.Round(v)) }

// ---- Cursor (Admin API, Basic auth with the key as the user) ----

type cursorClient struct{ h *httpc }

func (c *cursorClient) Pull(ctx context.Context, from, to time.Time) (Pull, error) {
	var p Pull
	var members struct {
		TeamMembers []struct {
			Email     string `json:"email"`
			Name      string `json:"name"`
			Role      string `json:"role"`
			IsRemoved bool   `json:"isRemoved"`
		} `json:"teamMembers"`
	}
	if err := c.h.do(ctx, http.MethodGet, "/teams/members", nil, nil, &members); err != nil {
		return p, err
	}
	for _, m := range members.TeamMembers {
		if m.IsRemoved || m.Email == "" {
			continue
		}
		p.Seats = append(p.Seats, Seat{Vendor: Cursor, Identity: strings.ToLower(m.Email), Name: m.Name, Plan: m.Role, Source: "api"})
	}
	acc := newAcc(Cursor)
	// daily activity: at most 30 days per request
	if to.Sub(from) > 30*24*time.Hour {
		from = to.Add(-30 * 24 * time.Hour)
	}
	for page := 1; page <= maxPages; page++ {
		var r struct {
			Data []struct {
				Email             string   `json:"email"`
				Date              flexTime `json:"date"`
				IsActive          bool     `json:"isActive"`
				ComposerRequests  int64    `json:"composerRequests"`
				ChatRequests      int64    `json:"chatRequests"`
				AgentRequests     int64    `json:"agentRequests"`
				CmdkUsages        int64    `json:"cmdkUsages"`
				TotalTabsAccepted int64    `json:"totalTabsAccepted"`
				TotalApplies      int64    `json:"totalApplies"`
				BugbotUsages      int64    `json:"bugbotUsages"`
			} `json:"data"`
			Pagination *struct {
				HasNextPage bool `json:"hasNextPage"`
			} `json:"pagination"`
		}
		body := map[string]any{"startDate": from.UnixMilli(), "endDate": to.UnixMilli(), "page": page, "pageSize": 500}
		if err := c.h.do(ctx, http.MethodPost, "/teams/daily-usage-data", nil, body, &r); err != nil {
			return p, err
		}
		for _, d := range r.Data {
			if d.Email == "" || d.Date.IsZero() {
				continue
			}
			n := d.ComposerRequests + d.ChatRequests + d.AgentRequests + d.CmdkUsages + d.TotalTabsAccepted + d.TotalApplies + d.BugbotUsages
			if n == 0 && d.IsActive {
				n = 1
			}
			if n > 0 {
				acc.at(d.Email, d.Date.Time).Requests += n
			}
		}
		if r.Pagination == nil || !r.Pagination.HasNextPage {
			break
		}
		if page == maxPages {
			p.Notes = append(p.Notes, "Cursor daily usage: page limit reached; activity may be incomplete")
		}
	}
	// what each person was charged (usage-based requests)
	for page := 1; page <= maxPages; page++ {
		var r struct {
			UsageEvents []struct {
				Timestamp    flexTime   `json:"timestamp"`
				UserEmail    string     `json:"userEmail"`
				IsChargeable bool       `json:"isChargeable"`
				ChargedCents flexNumber `json:"chargedCents"`
				TokenUsage   *struct {
					InputTokens  int64 `json:"inputTokens"`
					OutputTokens int64 `json:"outputTokens"`
				} `json:"tokenUsage"`
			} `json:"usageEvents"`
			Pagination struct {
				HasNextPage bool `json:"hasNextPage"`
			} `json:"pagination"`
		}
		body := map[string]any{"startDate": from.UnixMilli(), "endDate": to.UnixMilli(), "page": page, "pageSize": 1000}
		if err := c.h.do(ctx, http.MethodPost, "/teams/filtered-usage-events", nil, body, &r); err != nil {
			return p, err
		}
		dayCents := map[usageKey]float64{}
		for _, e := range r.UsageEvents {
			if e.UserEmail == "" || e.Timestamp.IsZero() {
				continue
			}
			row := acc.at(e.UserEmail, e.Timestamp.Time)
			if e.TokenUsage != nil {
				row.Tokens += e.TokenUsage.InputTokens + e.TokenUsage.OutputTokens
			}
			if e.IsChargeable || e.ChargedCents > 0 {
				dayCents[usageKey{row.Identity, row.Day}] += float64(e.ChargedCents)
			}
		}
		for k, v := range dayCents {
			acc.rows[k].CostCents += cents(v)
		}
		if !r.Pagination.HasNextPage {
			break
		}
		if page == maxPages {
			p.Notes = append(p.Notes, "Cursor usage events: page limit reached; costs may be incomplete")
		}
	}
	p.Usage = acc.list()
	return p, nil
}

// ---- Anthropic (Admin API: users, Claude Code Analytics, cost report) ----

type anthropicClient struct{ h *httpc }

func (c *anthropicClient) Pull(ctx context.Context, from, to time.Time) (Pull, error) {
	var p Pull
	after := ""
	for page := 0; page < maxPages; page++ {
		q := url.Values{"limit": {"100"}}
		if after != "" {
			q.Set("after_id", after)
		}
		var r struct {
			Data []struct {
				Email   string   `json:"email"`
				Name    string   `json:"name"`
				Role    string   `json:"role"`
				AddedAt flexTime `json:"added_at"`
			} `json:"data"`
			HasMore bool   `json:"has_more"`
			LastID  string `json:"last_id"`
		}
		if err := c.h.do(ctx, http.MethodGet, "/v1/organizations/users", q, nil, &r); err != nil {
			return p, err
		}
		for _, u := range r.Data {
			if u.Email != "" {
				p.Seats = append(p.Seats, Seat{Vendor: Anthropic, Identity: strings.ToLower(u.Email), Name: u.Name, Plan: u.Role, AssignedAt: u.AddedAt.ptr(), Source: "api"})
			}
		}
		if !r.HasMore || r.LastID == "" {
			break
		}
		after = r.LastID
	}

	acc := newAcc(Anthropic)
	// Claude Code Analytics: one day per request, per user (estimated cost in cents)
	for d := Day(from); d.Before(to); d = d.AddDate(0, 0, 1) {
		next := ""
		for page := 0; page < maxPages; page++ {
			q := url.Values{"starting_at": {d.Format("2006-01-02")}, "limit": {"1000"}}
			if next != "" {
				q.Set("page", next)
			}
			var r struct {
				Data []struct {
					Actor struct {
						Type         string `json:"type"`
						EmailAddress string `json:"email_address"`
						APIKeyName   string `json:"api_key_name"`
					} `json:"actor"`
					CoreMetrics struct {
						NumSessions int64 `json:"num_sessions"`
					} `json:"core_metrics"`
					ModelBreakdown []struct {
						Tokens struct {
							Input         int64 `json:"input"`
							Output        int64 `json:"output"`
							CacheRead     int64 `json:"cache_read"`
							CacheCreation int64 `json:"cache_creation"`
						} `json:"tokens"`
						EstimatedCost struct {
							Amount flexNumber `json:"amount"`
						} `json:"estimated_cost"`
					} `json:"model_breakdown"`
				} `json:"data"`
				HasMore  bool    `json:"has_more"`
				NextPage *string `json:"next_page"`
			}
			if err := c.h.do(ctx, http.MethodGet, "/v1/organizations/usage_report/claude_code", q, nil, &r); err != nil {
				return p, err
			}
			for _, x := range r.Data {
				id := strings.ToLower(x.Actor.EmailAddress)
				if x.Actor.Type == "api_actor" || id == "" {
					if x.Actor.APIKeyName == "" {
						continue
					}
					id = "key:" + x.Actor.APIKeyName
				}
				row := acc.at(id, d)
				row.Estimated = true
				row.Requests += x.CoreMetrics.NumSessions
				var c float64
				for _, m := range x.ModelBreakdown {
					row.Tokens += m.Tokens.Input + m.Tokens.Output + m.Tokens.CacheRead + m.Tokens.CacheCreation
					c += float64(m.EstimatedCost.Amount)
				}
				row.CostCents += cents(c)
			}
			if !r.HasMore || r.NextPage == nil || *r.NextPage == "" {
				break
			}
			next = *r.NextPage
		}
	}
	// the organisation's billed cost per day (decimal strings, in cents)
	next := ""
	for page := 0; page < maxPages; page++ {
		q := url.Values{"starting_at": {Day(from).Format(time.RFC3339)}, "ending_at": {Day(to).AddDate(0, 0, 1).Format(time.RFC3339)}, "bucket_width": {"1d"}, "limit": {"31"}}
		if next != "" {
			q.Set("page", next)
		}
		var r struct {
			Data []struct {
				StartingAt flexTime `json:"starting_at"`
				Results    []struct {
					Amount flexNumber `json:"amount"`
				} `json:"results"`
			} `json:"data"`
			HasMore  bool    `json:"has_more"`
			NextPage *string `json:"next_page"`
		}
		if err := c.h.do(ctx, http.MethodGet, "/v1/organizations/cost_report", q, nil, &r); err != nil {
			return p, err
		}
		for _, b := range r.Data {
			var c float64
			for _, x := range b.Results {
				c += float64(x.Amount)
			}
			acc.at("", b.StartingAt.Time).CostCents += cents(c)
		}
		if !r.HasMore || r.NextPage == nil || *r.NextPage == "" {
			break
		}
		next = *r.NextPage
	}
	p.Usage = acc.list()
	return p, nil
}

// ---- GitHub Copilot (seats with last activity; no usage cost) ----

type copilotClient struct{ h *httpc }

func (c *copilotClient) Pull(ctx context.Context, from, to time.Time) (Pull, error) {
	var p Pull
	org := "/orgs/" + url.PathEscape(c.h.cfg.Org)
	var billing struct {
		PlanType string `json:"plan_type"`
	}
	if err := c.h.do(ctx, http.MethodGet, org+"/copilot/billing", nil, nil, &billing); err != nil {
		return p, err
	}
	p.Plan = billing.PlanType
	for page := 1; page <= maxPages; page++ {
		var r struct {
			TotalSeats int `json:"total_seats"`
			Seats      []struct {
				CreatedAt      flexTime `json:"created_at"`
				LastActivityAt flexTime `json:"last_activity_at"`
				PlanType       string   `json:"plan_type"`
				Assignee       *struct {
					Login string `json:"login"`
				} `json:"assignee"`
			} `json:"seats"`
		}
		q := url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}}
		if err := c.h.do(ctx, http.MethodGet, org+"/copilot/billing/seats", q, nil, &r); err != nil {
			return p, err
		}
		for _, s := range r.Seats {
			if s.Assignee == nil || s.Assignee.Login == "" {
				continue
			}
			plan := s.PlanType
			if plan == "" || plan == "unknown" {
				plan = billing.PlanType
			}
			p.Seats = append(p.Seats, Seat{Vendor: Copilot, Identity: strings.ToLower(s.Assignee.Login), Plan: plan,
				AssignedAt: s.CreatedAt.ptr(), LastActivity: s.LastActivityAt.ptr(), Source: "api"})
		}
		if len(r.Seats) < 100 || len(p.Seats) >= r.TotalSeats {
			break
		}
	}
	return p, nil
}

// ---- OpenAI (Admin API: users, costs, completions usage by user) ----

type openaiClient struct{ h *httpc }

func (c *openaiClient) Pull(ctx context.Context, from, to time.Time) (Pull, error) {
	var p Pull
	emails := map[string]string{}
	after := ""
	for page := 0; page < maxPages; page++ {
		q := url.Values{"limit": {"100"}}
		if after != "" {
			q.Set("after", after)
		}
		var r struct {
			Data []struct {
				ID      string   `json:"id"`
				Email   string   `json:"email"`
				Name    string   `json:"name"`
				Role    string   `json:"role"`
				AddedAt flexTime `json:"added_at"`
			} `json:"data"`
			HasMore bool   `json:"has_more"`
			LastID  string `json:"last_id"`
		}
		if err := c.h.do(ctx, http.MethodGet, "/v1/organization/users", q, nil, &r); err != nil {
			return p, err
		}
		for _, u := range r.Data {
			if u.Email == "" {
				continue
			}
			emails[u.ID] = strings.ToLower(u.Email)
			p.Seats = append(p.Seats, Seat{Vendor: OpenAI, Identity: strings.ToLower(u.Email), Name: u.Name, Plan: u.Role, AssignedAt: u.AddedAt.ptr(), Source: "api"})
		}
		if !r.HasMore || r.LastID == "" {
			break
		}
		after = r.LastID
	}
	window := url.Values{"start_time": {strconv.FormatInt(Day(from).Unix(), 10)}, "end_time": {strconv.FormatInt(to.Unix(), 10)},
		"bucket_width": {"1d"}, "limit": {"31"}}
	type bucket struct {
		StartTime flexTime `json:"start_time"`
		Results   []struct {
			Amount *struct {
				Value flexNumber `json:"value"`
			} `json:"amount"`
			UserID           string `json:"user_id"`
			InputTokens      int64  `json:"input_tokens"`
			OutputTokens     int64  `json:"output_tokens"`
			NumModelRequests int64  `json:"num_model_requests"`
		} `json:"results"`
	}
	pages := func(path string, extra url.Values, each func(bucket)) error {
		next := ""
		for page := 0; page < maxPages; page++ {
			q := url.Values{}
			for k, v := range window {
				q[k] = v
			}
			for k, v := range extra {
				q[k] = v
			}
			if next != "" {
				q.Set("page", next)
			}
			var r struct {
				Data     []bucket `json:"data"`
				HasMore  bool     `json:"has_more"`
				NextPage *string  `json:"next_page"`
			}
			if err := c.h.do(ctx, http.MethodGet, path, q, nil, &r); err != nil {
				return err
			}
			for _, b := range r.Data {
				each(b)
			}
			if !r.HasMore || r.NextPage == nil || *r.NextPage == "" {
				return nil
			}
			next = *r.NextPage
		}
		return nil
	}
	acc := newAcc(OpenAI)
	orgCents := map[time.Time]float64{}
	err := pages("/v1/organization/costs", nil, func(b bucket) {
		for _, x := range b.Results {
			if x.Amount != nil {
				orgCents[Day(b.StartTime.Time)] += float64(x.Amount.Value) * 100 // dollars
			}
		}
	})
	if err != nil {
		return p, err
	}
	dayTokens := map[time.Time]int64{}
	err = pages("/v1/organization/usage/completions", url.Values{"group_by": {"user_id"}}, func(b bucket) {
		for _, x := range b.Results {
			if x.UserID == "" {
				continue
			}
			id := emails[x.UserID]
			if id == "" {
				id = "openai:" + x.UserID
			}
			row := acc.at(id, b.StartTime.Time)
			row.Requests += x.NumModelRequests
			row.Tokens += x.InputTokens + x.OutputTokens
			dayTokens[row.Day] += x.InputTokens + x.OutputTokens
		}
	})
	if err != nil {
		return p, err
	}
	// The cost API isn't per user: attribute each day's cost by token share.
	for _, k := range acc.order {
		r := acc.rows[k]
		if t := dayTokens[r.Day]; t > 0 && r.Tokens > 0 {
			r.CostCents = cents(orgCents[r.Day] * float64(r.Tokens) / float64(t))
			r.Estimated = true
		}
	}
	for d, c := range orgCents {
		acc.at("", d).CostCents = cents(c)
	}
	p.Usage = acc.list()
	return p, nil
}
