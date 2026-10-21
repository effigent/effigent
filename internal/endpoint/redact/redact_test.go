package redact

import (
	"strings"
	"testing"
)

func TestRedactsKeyInArgs(t *testing.T) {
	in := `deploytool --api-key=8f14e45fceea167a5a36dedd4bea2543 --region eu-west-1`
	out := String(in)
	if strings.Contains(out, "8f14e45fceea167a5a36dedd4bea2543") || !strings.Contains(out, "[REDACTED:") {
		t.Fatalf("key not redacted: %s", out)
	}
	if !strings.Contains(out, "--region eu-west-1") {
		t.Fatalf("non-secret text changed: %s", out)
	}
}

func TestLeavesOrdinaryCommandsAlone(t *testing.T) {
	for _, in := range []string{"ls -la /work", "git status", "npm install express", "/usr/bin/curl -s https://example.com"} {
		if out := String(in); out != in {
			t.Fatalf("changed %q to %q", in, out)
		}
	}
}

func TestRedactsWhatGitleaksMisses(t *testing.T) {
	cases := map[string]string{
		`GITHUB_TOKEN=abc123def456 gh pr list`:                 "GITHUB_TOKEN=[REDACTED:",
		`DB_PASSWORD="hunter2!!" ./migrate`:                    "DB_PASSWORD=[REDACTED:",
		`psql postgres://app:s3cretpw@db.internal/app`:         "postgres://app:[REDACTED:url-password]@db.internal/app",
		`mysql -u root -pSuperSecret app`:                      "-p[REDACTED:",
		`tool --password hunter22 --user x`:                    "--password [REDACTED:",
		`curl -H "Authorization: Bearer abcdefghijklmnop1234"`: "Bearer [REDACTED:",
		"key: -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END": "[REDACTED:private-key]",
	}
	for in, want := range cases {
		if out := String(in); !strings.Contains(out, want) {
			t.Errorf("%q -> %q, want %q", in, out, want)
		}
	}
	for _, in := range []string{`export TOKEN=$GITHUB_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS=/etc/key.json app`, `git commit --author="A <a@b.c>"`, `cd $(pwd)`} {
		if out := String(in); out != in {
			t.Errorf("changed %q to %q", in, out)
		}
	}
}

func TestConfigure(t *testing.T) {
	defer Configure(nil, false)
	if err := Configure([]Rule{{"customer-id", `CUST-[0-9]{6}`}}, true); err != nil {
		t.Fatal(err)
	}
	out := String("refund CUST-123456 for jane@acme.com")
	if !strings.Contains(out, "[REDACTED:customer-id]") || !strings.Contains(out, "[REDACTED:email]") {
		t.Errorf("masks: %s", out)
	}
	if err := Configure([]Rule{{"bad", `(`}}, false); err == nil {
		t.Error("invalid pattern accepted")
	}
	if !strings.Contains(String("CUST-123456"), "REDACTED") {
		t.Error("an invalid set replaced the previous one")
	}
	if err := Configure([]Rule{{"empty", `x*`}}, false); err == nil {
		t.Error("pattern matching empty text accepted")
	}
}
