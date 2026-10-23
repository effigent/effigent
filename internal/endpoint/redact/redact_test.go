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
		`mysql -e "CREATE USER app IDENTIFIED BY 'pw-12345'"`:  "IDENTIFIED BY [REDACTED:sql-password]",
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

// A heredoc body is part of the command text the hook and the kernel report,
// so the same rules mask it: tokens, passwords, keys and the workspace's masks.
func TestRedactsHeredocBodies(t *testing.T) {
	defer Configure(nil, false)
	if err := Configure([]Rule{{"customer", `(?i)acme-?corp`}}, false); err != nil {
		t.Fatal(err)
	}
	ghp := "ghp_" + "Zq8RkT3vW1yX6bN0mP4sL7dF2gH5jK9cV3xQ"
	stripe := "sk_" + "live_" + "51Hx9aQ2eZvKYlo2C8r7Tq3bN" // split so secret scanners skip this fake key
	cmd := "cat > .env <<EOF\n" +
		"GITHUB_TOKEN=" + ghp + "\n" +
		"DB_PASSWORD=Tr0ub4dor-horse-staple\n" +
		"STRIPE_SECRET_KEY=" + stripe + "\n" +
		"LOG_LEVEL=debug\n" +
		"EOF\n" +
		"cat > config.yml <<-'YAML'\n" +
		"\tdatabase:\n" +
		"\t  password: hunter2-prod-db\n" +
		"\t  client: acme-corp\n" +
		"\tYAML\n" +
		"cat > deploy.pem <<KEY\n" +
		"-----BEGIN RSA PRIVATE KEY-----\n" +
		"MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n" +
		"VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK\n" +
		"-----END RSA PRIVATE KEY-----\n" +
		"KEY\n" +
		"psql \"$URL\" <<<\"ALTER USER app WITH PASSWORD 'n0t-in-the-logs'\"\n"
	out := String(cmd)
	for _, secret := range []string{ghp, "Tr0ub4dor-horse-staple", stripe, "hunter2-prod-db",
		"acme-corp", "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun", "n0t-in-the-logs"} {
		if strings.Contains(out, secret) {
			t.Errorf("%q left in:\n%s", secret, out)
		}
	}
	// targeted, not blanket: the commands, delimiters and harmless lines stay
	for _, keep := range []string{"cat > .env <<EOF", "LOG_LEVEL=debug", "cat > config.yml <<-'YAML'", "\tYAML\n",
		"cat > deploy.pem <<KEY", "\nKEY\n", "[REDACTED:customer]", "[REDACTED:private-key]"} {
		if !strings.Contains(out, keep) {
			t.Errorf("%q missing from:\n%s", keep, out)
		}
	}
}
