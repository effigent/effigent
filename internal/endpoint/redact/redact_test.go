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
