package hooks

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// Secret-named variables are forwarded by name only: their values never
// reach the header the hook sends, the daemon's copy or the event.
func TestAgentEnvSecretNames(t *testing.T) {
	values := []string{"hunter2-db-pass", "sk_live_51Hstripe", "npm-auth-tok-123", "pk-private-xyz", "gho_credfile", "s3cr3t-value"}
	environ := []string{"DB_PASSWORD=" + values[0], "STRIPE_API_KEY=" + values[1], "npm_config__authToken=" + values[2],
		"SIGNING_PRIVATE_KEY=" + values[3], "MY_CREDENTIALS=" + values[4], "APP_SECRET=" + values[5], "HOME=/home/grok-bot", "EDITOR=vim"}
	env := AgentEnv(environ)
	for _, k := range []string{"DB_PASSWORD", "STRIPE_API_KEY", "npm_config__authToken", "SIGNING_PRIVATE_KEY", "MY_CREDENTIALS", "APP_SECRET"} {
		if env[k] != "set" {
			t.Errorf("%s = %q, want set", k, env[k])
		}
	}
	if _, ok := env["EDITOR"]; ok {
		t.Errorf("non-secret forwarded: %v", env)
	}

	// A hook that sends the values anyway: the daemon keeps only "set".
	sent := map[string]string{}
	for _, kv := range environ {
		k, v, _ := strings.Cut(kv, "=")
		sent[k] = v
	}
	clean := CleanAgentEnv(sent)
	if clean["DB_PASSWORD"] != "set" || clean["npm_config__authToken"] != "set" {
		t.Errorf("clean: %v", clean)
	}
	ev := event.Event{Type: "agent_start", AgentEnv: clean}
	for _, out := range []any{env, clean, ev} {
		b, _ := json.Marshal(out)
		for _, v := range values {
			if strings.Contains(string(b), v) {
				t.Errorf("value %q leaked: %s", v, b)
			}
		}
	}

	// Capped: a huge environment can't flood the header.
	var many []string
	for i := range 200 {
		many = append(many, fmt.Sprintf("X%d_TOKEN=v", i))
	}
	if n := len(AgentEnv(many)); n != maxSecretEnv {
		t.Errorf("cap: %d names", n)
	}
}
