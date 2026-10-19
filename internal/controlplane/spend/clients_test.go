package spend

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var (
	from = time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	to   = time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC)
)

func fake(t *testing.T, check func(*http.Request) bool, routes map[string]func(r *http.Request) any) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !check(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		h, ok := routes[r.Method+" "+r.URL.Path]
		if !ok {
			t.Errorf("unexpected %s %s", r.Method, r.URL)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(h(r))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func body(r *http.Request) map[string]any {
	var m map[string]any
	b, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(b, &m)
	return m
}

func pull(t *testing.T, c Config) Pull {
	t.Helper()
	cl, err := NewClient(c)
	if err != nil {
		t.Fatal(err)
	}
	p, err := cl.Pull(context.Background(), from, to)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func usageOf(p Pull, id string) (u UsageDay) {
	for _, x := range p.Usage {
		if x.Identity == id {
			u.Vendor, u.Identity = x.Vendor, x.Identity
			u.CostCents += x.CostCents
			u.Requests += x.Requests
			u.Tokens += x.Tokens
			u.Estimated = u.Estimated || x.Estimated
		}
	}
	return
}

func TestCursorClient(t *testing.T) {
	day := from.Add(10 * time.Hour).UnixMilli()
	base := fake(t, func(r *http.Request) bool { u, p, ok := r.BasicAuth(); return ok && u == "key_cursor" && p == "" },
		map[string]func(*http.Request) any{
			"GET /teams/members": func(*http.Request) any {
				return map[string]any{"teamMembers": []map[string]any{
					{"id": "user_1", "email": "Dana@Acme.io", "name": "Dana", "role": "member", "isRemoved": false},
					{"id": "user_2", "email": "gone@acme.io", "name": "Gone", "role": "member", "isRemoved": true},
				}}
			},
			"POST /teams/daily-usage-data": func(r *http.Request) any {
				b := body(r)
				if b["page"].(float64) == 1 {
					return map[string]any{"data": []map[string]any{{"email": "dana@acme.io", "date": day, "day": "2026-10-17", "isActive": true, "agentRequests": 7, "chatRequests": 2}},
						"pagination": map[string]any{"hasNextPage": true}}
				}
				return map[string]any{"data": []map[string]any{{"email": "omer@acme.io", "date": day, "isActive": true}}, "pagination": map[string]any{"hasNextPage": false}}
			},
			"POST /teams/filtered-usage-events": func(r *http.Request) any {
				if b := body(r); b["startDate"].(float64) != float64(from.UnixMilli()) || b["pageSize"].(float64) != 1000 {
					t.Errorf("filtered-usage-events body %v", b)
				}
				return map[string]any{"usageEvents": []map[string]any{
					{"timestamp": "1760695200000", "userEmail": "dana@acme.io", "isChargeable": true, "chargedCents": 120.4, "isTokenBasedCall": true, "tokenUsage": map[string]any{"inputTokens": 1000, "outputTokens": 200}},
					{"timestamp": "1760695300000", "userEmail": "dana@acme.io", "isChargeable": true, "chargedCents": 80.2},
					{"timestamp": "1760695300000", "userEmail": "dana@acme.io", "isChargeable": false, "chargedCents": 0},
				}, "pagination": map[string]any{"hasNextPage": false}}
			},
		})
	p := pull(t, Config{Vendor: Cursor, Key: "key_cursor", BaseURL: base})
	if len(p.Seats) != 1 || p.Seats[0].Identity != "dana@acme.io" || p.Seats[0].Plan != "member" {
		t.Fatalf("seats %+v", p.Seats)
	}
	d := usageOf(p, "dana@acme.io")
	if d.Requests != 9 || d.CostCents != 201 || d.Tokens != 1200 {
		t.Fatalf("dana usage %+v", d)
	}
	if o := usageOf(p, "omer@acme.io"); o.Requests != 1 {
		t.Fatalf("active day without counts: %+v", o)
	}
}

func TestAnthropicClient(t *testing.T) {
	ccCalls := 0
	base := fake(t, func(r *http.Request) bool {
		return r.Header.Get("x-api-key") == "sk-ant-admin01-x" && r.Header.Get("anthropic-version") == "2023-06-01"
	}, map[string]func(*http.Request) any{
		"GET /v1/organizations/users": func(r *http.Request) any {
			if r.URL.Query().Get("after_id") == "" {
				return map[string]any{"data": []map[string]any{{"id": "u1", "email": "dana@acme.io", "name": "Dana", "role": "developer", "added_at": "2026-01-02T00:00:00Z"}}, "has_more": true, "last_id": "u1"}
			}
			return map[string]any{"data": []map[string]any{{"id": "u2", "email": "omer@acme.io", "role": "user"}}, "has_more": false}
		},
		"GET /v1/organizations/usage_report/claude_code": func(r *http.Request) any {
			ccCalls++
			if r.URL.Query().Get("starting_at") != "2026-10-17" {
				return map[string]any{"data": []any{}, "has_more": false, "next_page": nil}
			}
			return map[string]any{"data": []map[string]any{
				{"date": "2026-10-17T00:00:00Z", "actor": map[string]any{"type": "user_actor", "email_address": "Dana@acme.io"},
					"core_metrics": map[string]any{"num_sessions": 5},
					"model_breakdown": []map[string]any{
						{"model": "claude-opus-5-5", "tokens": map[string]any{"input": 100000, "output": 35000, "cache_read": 10000, "cache_creation": 5000}, "estimated_cost": map[string]any{"currency": "USD", "amount": 113}},
						{"model": "claude-haiku-5-5", "tokens": map[string]any{"input": 1000, "output": 0}, "estimated_cost": map[string]any{"currency": "USD", "amount": 2}},
					}},
				{"date": "2026-10-17T00:00:00Z", "actor": map[string]any{"type": "api_actor", "api_key_name": "ci-bot"},
					"core_metrics": map[string]any{"num_sessions": 40}, "model_breakdown": []map[string]any{{"estimated_cost": map[string]any{"amount": 900}}}},
			}, "has_more": false, "next_page": nil}
		},
		"GET /v1/organizations/cost_report": func(r *http.Request) any {
			if r.URL.Query().Get("bucket_width") != "1d" {
				t.Errorf("cost_report query %v", r.URL.Query())
			}
			if r.URL.Query().Get("page") == "" {
				return map[string]any{"data": []map[string]any{{"starting_at": "2026-10-17T00:00:00Z", "ending_at": "2026-10-18T00:00:00Z",
					"results": []map[string]any{{"currency": "USD", "amount": "1015.50"}, {"currency": "USD", "amount": "4.5"}}}}, "has_more": true, "next_page": "page_2"}
			}
			return map[string]any{"data": []map[string]any{{"starting_at": "2026-10-18T00:00:00Z", "results": []map[string]any{{"amount": "20"}}}}, "has_more": false}
		},
	})
	p := pull(t, Config{Vendor: Anthropic, Key: "sk-ant-admin01-x", BaseURL: base})
	if len(p.Seats) != 2 || p.Seats[0].AssignedAt == nil {
		t.Fatalf("seats %+v", p.Seats)
	}
	if ccCalls != 2 {
		t.Fatalf("one analytics call per day: %d", ccCalls)
	}
	if d := usageOf(p, "dana@acme.io"); d.CostCents != 115 || d.Requests != 5 || d.Tokens != 151000 || !d.Estimated {
		t.Fatalf("dana %+v", d)
	}
	if k := usageOf(p, "key:ci-bot"); k.CostCents != 900 {
		t.Fatalf("api key actor %+v", k)
	}
	if o := usageOf(p, ""); o.CostCents != 1040 {
		t.Fatalf("org cost (cents, across pages) %+v", o)
	}
}

func TestCopilotClient(t *testing.T) {
	seats := func(n, offset int) []map[string]any {
		var out []map[string]any
		for i := 0; i < n; i++ {
			out = append(out, map[string]any{"created_at": "2026-01-01T00:00:00Z", "last_activity_at": "2026-10-01T10:00:00Z", "plan_type": "unknown",
				"assignee": map[string]any{"login": "User" + string(rune('A'+(offset+i)%26)) + strings.Repeat("x", (offset+i)/26)}})
		}
		return out
	}
	base := fake(t, func(r *http.Request) bool {
		return r.Header.Get("Authorization") == "Bearer ghp_x" && r.Header.Get("X-GitHub-Api-Version") != ""
	}, map[string]func(*http.Request) any{
		"GET /orgs/acme/copilot/billing": func(*http.Request) any {
			return map[string]any{"seat_breakdown": map[string]any{"total": 101}, "plan_type": "enterprise"}
		},
		"GET /orgs/acme/copilot/billing/seats": func(r *http.Request) any {
			if r.URL.Query().Get("page") == "1" {
				return map[string]any{"total_seats": 101, "seats": seats(100, 0)}
			}
			return map[string]any{"total_seats": 101, "seats": append(seats(1, 100), map[string]any{"assignee": nil})}
		},
	})
	p := pull(t, Config{Vendor: Copilot, Key: "ghp_x", Org: "acme", BaseURL: base})
	if len(p.Seats) != 101 || p.Plan != "enterprise" || p.Seats[0].Plan != "enterprise" || p.Seats[0].Identity != "usera" || p.Seats[0].LastActivity == nil {
		t.Fatalf("%d seats, plan %q, first %+v", len(p.Seats), p.Plan, p.Seats[0])
	}
	if _, err := NewClient(Config{Vendor: Copilot, Key: "x", Org: "../evil"}); err == nil {
		t.Fatal("bad org accepted")
	}
}

func TestOpenAIClient(t *testing.T) {
	d1 := from.Unix()
	base := fake(t, func(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer sk-admin-x" }, map[string]func(*http.Request) any{
		"GET /v1/organization/users": func(*http.Request) any {
			return map[string]any{"data": []map[string]any{{"id": "user-1", "email": "noa@acme.io", "name": "Noa", "role": "reader"}}, "has_more": false}
		},
		"GET /v1/organization/costs": func(*http.Request) any {
			return map[string]any{"data": []map[string]any{{"start_time": d1, "results": []map[string]any{{"amount": map[string]any{"value": 12.5, "currency": "usd"}}}}}, "has_more": false}
		},
		"GET /v1/organization/usage/completions": func(r *http.Request) any {
			if r.URL.Query().Get("group_by") != "user_id" {
				t.Errorf("completions query %v", r.URL.Query())
			}
			return map[string]any{"data": []map[string]any{{"start_time": d1, "results": []map[string]any{
				{"user_id": "user-1", "input_tokens": 3000, "output_tokens": 0, "num_model_requests": 10},
				{"user_id": "user-9", "input_tokens": 1000, "output_tokens": 0, "num_model_requests": 2},
			}}}, "has_more": false}
		},
	})
	p := pull(t, Config{Vendor: OpenAI, Key: "sk-admin-x", BaseURL: base})
	if n := usageOf(p, "noa@acme.io"); n.CostCents != 938 || n.Requests != 10 || !n.Estimated { // 1250 × 3/4
		t.Fatalf("noa %+v", n)
	}
	if u := usageOf(p, "openai:user-9"); u.CostCents != 313 {
		t.Fatalf("unknown user %+v", u)
	}
	if o := usageOf(p, ""); o.CostCents != 1250 {
		t.Fatalf("org %+v", o)
	}
}

func TestClientErrors(t *testing.T) {
	base := fake(t, func(*http.Request) bool { return false }, nil)
	cl, _ := NewClient(Config{Vendor: Cursor, Key: "secret-key-123", BaseURL: base})
	_, err := cl.Pull(context.Background(), from, to)
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 401 || !strings.Contains(err.Error(), "admin key") || strings.Contains(err.Error(), "secret-key-123") {
		t.Fatalf("error %v", err)
	}
	if _, err := NewClient(Config{Vendor: Cursor}); err == nil {
		t.Fatal("no key accepted")
	}
	if _, err := NewClient(Config{Vendor: "nope", Key: "k"}); err == nil {
		t.Fatal("unknown vendor accepted")
	}
}
