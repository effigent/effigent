package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClerkDirectory(t *testing.T) {
	calls := 0
	clerk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer sk_test_x" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/organizations/org_1/memberships":
			w.Write([]byte(`{"data":[{"role":"org:admin","public_user_data":{"user_id":"user_a"}},
				{"role":"org:security_admin","public_user_data":{"user_id":"user_s"}},
				{"role":"org:member","public_user_data":{"user_id":"user_m"}}],"total_count":3}`))
		case r.URL.Path == "/v1/users" && len(r.URL.Query()["user_id"]) == 3:
			w.Write([]byte(`[{"id":"user_a","email_addresses":[{"email_address":"Ada@Acme.io","verification":{"status":"verified"}}]},
				{"id":"user_s","email_addresses":[{"email_address":"sec@acme.io","verification":{"status":"verified"}},
					{"email_address":"unverified@acme.io","verification":{"status":"unverified"}}]},
				{"id":"user_m","email_addresses":[{"email_address":"dev@acme.io","verification":{"status":"verified"}}]}]`))
		case r.URL.Path == "/v1/users/user_solo":
			w.Write([]byte(`{"id":"user_solo","email_addresses":[{"email_address":"solo@me.io","verification":{"status":"verified"}}]}`))
		default:
			t.Errorf("unexpected Clerk call %s", r.URL)
			w.WriteHeader(404)
		}
	}))
	defer clerk.Close()
	d := &ClerkDirectory{SecretKey: "sk_test_x", BaseURL: clerk.URL}
	ctx := context.Background()
	for email, want := range map[string]string{"ada@acme.io": "admin", "SEC@acme.io": "security_admin", "dev@acme.io": "member",
		"unverified@acme.io": "", "stranger@x.io": ""} {
		if got, err := d.MemberRole(ctx, "org:org_1", email); err != nil || got != want {
			t.Fatalf("%s: %q %v, want %q", email, got, err, want)
		}
	}
	if calls != 2 {
		t.Fatalf("directory not cached: %d calls", calls)
	}
	if got, _ := d.MemberRole(ctx, "user:user_solo", "solo@me.io"); got != "admin" {
		t.Fatalf("personal workspace owner: %q", got)
	}
	bad := &ClerkDirectory{SecretKey: "wrong", BaseURL: clerk.URL}
	if _, err := bad.MemberRole(ctx, "org:org_1", "ada@acme.io"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("bad key: %v", err)
	}
}
