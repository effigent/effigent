package server

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
)

// TestAuditPaging needs a throwaway Postgres database (see TestCentralPolicyEndToEnd).
func TestAuditPaging(t *testing.T) {
	dsn := os.Getenv("EFFIGENT_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("EFFIGENT_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	st, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	tenant := fmt.Sprintf("org:audit-%d-%d", os.Getpid(), time.Now().UnixNano())
	auth, err := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{tenant}})
	if err != nil {
		t.Fatal(err)
	}
	_, key, _ := ed25519.GenerateKey(nil)
	srv := httptest.NewServer((&Server{Store: st, Key: key, Auth: auth, Logf: t.Logf}).Handler())
	defer srv.Close()

	// 25 entries: policy publishes by a person, approvals by an endpoint, one key creation with odd characters
	for i := range 25 {
		e := store.AuditEntry{Actor: "user_1", ActorVia: "clerk", ActorRole: "admin", Action: "policy.publish", Target: fmt.Sprintf("v%d", i), Details: json.RawMessage(`{"comment":"routine"}`)}
		if i%3 == 0 {
			e = store.AuditEntry{Actor: "endpoint:e1", ActorVia: "endpoint", Action: "approval.request", Target: fmt.Sprintf("apr_%d", i), Details: json.RawMessage(`{"summary":"Bash: git push origin main"}`)}
		}
		if i == 24 {
			e = store.AuditEntry{Actor: "user_1", ActorVia: "clerk", Action: "api_key.create", Target: "key_x", Details: json.RawMessage(`{"name":"100% ci_bot"}`)}
		}
		if err := st.AppendAudit(ctx, tenant, e); err != nil {
			t.Fatal(err)
		}
	}
	type page struct {
		Entries    []store.AuditEntry `json:"entries"`
		Total      int                `json:"total"`
		NextBefore int64              `json:"next_before"`
	}
	get := func(q url.Values) page {
		t.Helper()
		q.Set("paged", "1")
		req, _ := http.NewRequest("GET", srv.URL+"/api/v1/audit?"+q.Encode(), nil)
		req.Header.Set("Authorization", "Bearer t0ken")
		req.Header.Set("X-Effigent-Tenant", tenant)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("%s: HTTP %d", q.Encode(), res.StatusCode)
		}
		var p page
		if err := json.NewDecoder(res.Body).Decode(&p); err != nil {
			t.Fatal(err)
		}
		return p
	}

	// walk every page of 10: 25 entries, newest first, no gaps or repeats
	var seqs []int64
	q := url.Values{"limit": {"10"}}
	for n := 0; ; n++ {
		p := get(q)
		if p.Total != 25 {
			t.Fatalf("total %d", p.Total)
		}
		for _, e := range p.Entries {
			seqs = append(seqs, e.Seq)
		}
		if p.NextBefore == 0 {
			break
		}
		if n > 5 {
			t.Fatal("paging does not end")
		}
		q.Set("before", fmt.Sprint(p.NextBefore))
	}
	if len(seqs) != 25 {
		t.Fatalf("walked %d entries", len(seqs))
	}
	for i := 1; i < len(seqs); i++ {
		if seqs[i] >= seqs[i-1] {
			t.Fatalf("not newest first: %v", seqs)
		}
	}

	if p := get(url.Values{"action": {"approval."}}); p.Total != 8 || p.Entries[0].Action != "approval.request" {
		t.Fatalf("action filter: %d", p.Total)
	}
	if p := get(url.Values{"action": {"approval.,api_key."}}); p.Total != 9 {
		t.Fatalf("two prefixes: %d", p.Total)
	}
	if p := get(url.Values{"via": {"endpoint"}}); p.Total != 8 {
		t.Fatalf("via filter: %d", p.Total)
	}
	if p := get(url.Values{"q": {"git push"}}); p.Total != 8 {
		t.Fatalf("search in details: %d", p.Total)
	}
	if p := get(url.Values{"q": {"100%"}}); p.Total != 1 || p.Entries[0].Target != "key_x" {
		t.Fatalf("literal %%: %d", p.Total)
	}
	if p := get(url.Values{"q": {"ci_"}}); p.Total != 1 {
		t.Fatalf("literal _: %d", p.Total)
	}
	if p := get(url.Values{"since": {time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}}); p.Total != 0 || len(p.Entries) != 0 {
		t.Fatalf("since: %d", p.Total)
	}
	if p := get(url.Values{"until": {time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, "limit": {"100"}}); p.Total != 25 || p.NextBefore != 0 {
		t.Fatalf("until: %d next %d", p.Total, p.NextBefore)
	}
}
