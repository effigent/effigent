package engine

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/endpoint/redact"
)

// The policy's masks (a customer name, PII) reach every field that names a
// place or a target before the event leaves the engine: what a sink sends is
// the JSON below, so that is what is checked.
func TestScrubMasksPathsAttrsAndEnv(t *testing.T) {
	pol, err := policy.Parse([]byte(`
redact:
  pii: true
  patterns:
    - name: customer
      pattern: "(?i)acme-?corp"
`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = redact.Configure(nil, false) })
	var got []event.Event
	e := New(pol, nil, nil, func(ev event.Event) { got = append(got, ev) }, t.Logf, false)

	fp := "3f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f"
	attrs := map[string]string{"aws_profile": "acme-corp-prod", "db_host": "db.acmecorp.internal",
		"kube_context": "arn:aws:eks:us-east-1:123456789012:cluster/acme-corp", "fingerprint": fp, "db_file": "/srv/dana.levi@example.com.db"}
	env := map[string]string{"AWS_PROFILE": "acme-corp-admin", "ANTHROPIC_API_KEY": "set",
		"DATABASE_URL": "postgres://app:s3cretpw@db.internal/app"}
	ev := event.Event{Time: time.Now(), Type: event.Exec, Severity: "info", Agent: "grok-bot", Kind: "tool",
		Process: &event.Proc{PID: 7, Binary: "/home/dana/AcmeCorp/bin/tool", Args: "tool --client acme-corp", CWD: "/home/dana/clients/acme-corp/api"},
		Target:  "psql -h db.acmecorp.internal", Message: "session 1", TranscriptPath: "/home/dana/.claude/projects/-clients-acme-corp/s.jsonl",
		OSUser: "dana", GitEmail: "dana.levi@example.com", Node: "build-7",
		Actions:  []event.Action{{Kind: "destructive_sql", Target: "DROP TABLE acme_corp_users", Attrs: attrs, In: "scripts/acme-corp-reset.sh"}},
		AgentEnv: env}
	e.Emit(ev)
	if len(got) != 1 {
		t.Fatalf("got %d events", len(got))
	}
	b, _ := json.Marshal(got[0])
	out := string(b)
	for _, leak := range []string{"acme-corp", "AcmeCorp", "acmecorp", "s3cretpw", "dana.levi@example.com.db"} {
		if strings.Contains(strings.ReplaceAll(out, `"git_email":"dana.levi@example.com"`, ""), leak) {
			t.Errorf("%q leaves the machine: %s", leak, out)
		}
	}
	for _, keep := range []string{"[REDACTED:customer]", `"fingerprint":"` + fp + `"`, `"ANTHROPIC_API_KEY":"set"`,
		`"cwd":"/home/dana/clients/[REDACTED:customer]/api"`, "us-east-1:123456789012", `"os_user":"dana"`,
		`"git_email":"dana.levi@example.com"`, `"node":"build-7"`} {
		if !strings.Contains(out, keep) {
			t.Errorf("%q missing: %s", keep, out)
		}
	}
	// the caller's maps and process are untouched (the hook handler still uses them)
	if attrs["aws_profile"] != "acme-corp-prod" || env["AWS_PROFILE"] != "acme-corp-admin" || ev.Process.CWD != "/home/dana/clients/acme-corp/api" {
		t.Error("scrub changed the caller's event")
	}
}
