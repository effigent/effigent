package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/hookstate"
)

// install-gateway writes what hookstate reads back as "on", keeps the rest of
// the files, refuses to replace a base URL that isn't the gateway's, and
// --remove takes out only its own value.
func TestInstallGatewayRoundTrip(t *testing.T) {
	dir := t.TempDir()
	o := hookstate.Options{
		Sensor:       "hooks",
		Claude:       filepath.Join(dir, "claude", "managed-settings.json"),
		Codex:        filepath.Join(dir, "codex", "requirements.toml"),
		Gemini:       filepath.Join(dir, "gemini", "settings.json"),
		Cur:          filepath.Join(dir, "cursor", "hooks.json"),
		CodexManaged: filepath.Join(dir, "codex", "managed_config.toml"),
		GatewayAddr:  "127.0.0.1:7779",
	}
	writeTestFile(t, o.Claude, `{"env":{"DISABLE_TELEMETRY":"1"},"permissions":{"deny":["Read(.env)"]}}`)
	writeTestFile(t, o.CodexManaged, "approval_policy = \"on-request\"\n")
	gw := func(st hookstate.Report, agent string) string {
		if g := st.Agents[agent].Gateway; g != nil {
			return g.State
		}
		return ""
	}
	if st := hookstate.Check(o); gw(st, "claude") != hookstate.GatewayOff || gw(st, "codex") != hookstate.GatewayOff {
		t.Fatalf("before: %+v", st.Agents)
	}
	for i := 0; i < 2; i++ { // twice: idempotent
		if _, err := gatewayClaude(o.Claude, o.GatewayAddr, false); err != nil {
			t.Fatal(err)
		}
		if _, err := gatewayCodex(o.CodexManaged, o.GatewayAddr, false); err != nil {
			t.Fatal(err)
		}
	}
	st := hookstate.Check(o)
	if gw(st, "claude") != hookstate.GatewayOn || gw(st, "codex") != hookstate.GatewayOn {
		t.Fatalf("installed: %+v %+v", st.Agents["claude"].Gateway, st.Agents["codex"].Gateway)
	}
	if u := st.Agents["claude"].Gateway.URL; u != "http://127.0.0.1:7779/anthropic/claude-code" {
		t.Errorf("claude url %q", u)
	}
	if u := st.Agents["codex"].Gateway.URL; u != "http://127.0.0.1:7779/codex/codex" {
		t.Errorf("codex url %q", u)
	}
	b, _ := os.ReadFile(o.Claude)
	if !strings.Contains(string(b), "DISABLE_TELEMETRY") || !strings.Contains(string(b), "Read(.env)") {
		t.Errorf("claude settings lost: %s", b)
	}
	b, _ = os.ReadFile(o.CodexManaged)
	if !strings.Contains(string(b), "approval_policy") {
		t.Errorf("codex defaults lost: %s", b)
	}
	// the daemon's gateway on another port: reported, not "on"
	o2 := o
	o2.GatewayAddr = "127.0.0.1:9999"
	if st := hookstate.Check(o2); gw(st, "claude") != hookstate.GatewayOtherPort {
		t.Errorf("other port: %+v", st.Agents["claude"].Gateway)
	}
	// the daemon's gateway off: the agent is cut off, never "on"
	o2.GatewayAddr = ""
	if st := hookstate.Check(o2); gw(st, "claude") != hookstate.GatewayOtherPort || gw(st, "codex") != hookstate.GatewayOtherPort ||
		!strings.Contains(st.Agents["claude"].Gateway.Detail, "off") {
		t.Errorf("gateway off: %+v %+v", st.Agents["claude"].Gateway, st.Agents["codex"].Gateway)
	}

	if _, err := gatewayClaude(o.Claude, o.GatewayAddr, true); err != nil {
		t.Fatal(err)
	}
	if _, err := gatewayCodex(o.CodexManaged, o.GatewayAddr, true); err != nil {
		t.Fatal(err)
	}
	st = hookstate.Check(o)
	if gw(st, "claude") != hookstate.GatewayOff || gw(st, "codex") != hookstate.GatewayOff {
		t.Fatalf("removed: %+v %+v", st.Agents["claude"].Gateway, st.Agents["codex"].Gateway)
	}
	b, _ = os.ReadFile(o.Claude)
	if !strings.Contains(string(b), "DISABLE_TELEMETRY") || strings.Contains(string(b), "ANTHROPIC_BASE_URL") {
		t.Errorf("claude after remove: %s", b)
	}

	// someone else's proxy is neither replaced nor removed
	writeTestFile(t, o.Claude, `{"env":{"ANTHROPIC_BASE_URL":"https://llm.corp.example"}}`)
	if _, err := gatewayClaude(o.Claude, o.GatewayAddr, false); err == nil {
		t.Error("replaced another base URL")
	}
	if _, err := gatewayClaude(o.Claude, o.GatewayAddr, true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(o.Claude); !strings.Contains(string(b), "llm.corp.example") {
		t.Errorf("removed another base URL: %s", b)
	}
	if st := hookstate.Check(o); gw(st, "claude") != hookstate.GatewayElsewhere {
		t.Errorf("elsewhere: %+v", st.Agents["claude"].Gateway)
	}
	writeTestFile(t, o.CodexManaged, "openai_base_url = \"https://us.api.openai.com/v1\"\n")
	if _, err := gatewayCodex(o.CodexManaged, o.GatewayAddr, false); err == nil {
		t.Error("replaced Codex's base URL")
	}
	// a managed file that held only our value goes away on --remove
	if err := os.Remove(o.CodexManaged); err != nil {
		t.Fatal(err)
	}
	if _, err := gatewayCodex(o.CodexManaged, o.GatewayAddr, false); err != nil {
		t.Fatal(err)
	}
	if _, err := gatewayCodex(o.CodexManaged, o.GatewayAddr, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(o.CodexManaged); !os.IsNotExist(err) {
		t.Errorf("empty managed_config.toml left behind: %v", err)
	}
}
