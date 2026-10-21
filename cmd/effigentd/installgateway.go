package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/gateway"
	"github.com/effigent/effigent/internal/endpoint/hookstate"
	"github.com/pelletier/go-toml/v2"
)

// installGatewayCmd implements `effigentd install-gateway`: points each
// agent's machine-wide config at effigentd's model gateway (--remove takes it
// out again), keeping everything else in the files.
//
// The gateway is fail-closed by construction: an agent pointed at it can't
// reach its model while effigentd is stopped. That is the same posture as the
// hooks' onFailure: block; `install-gateway --remove` is the way back.
func installGatewayCmd(args []string) {
	fs := flag.NewFlagSet("install-gateway", flag.ExitOnError)
	agents := fs.String("agents", "claude", "agents to point at the gateway (comma-separated: claude, codex)")
	addr := fs.String("addr", gateway.DefaultAddr, "the gateway's address (effigentd -gateway)")
	claudeFile := fs.String("file", hookstate.ClaudeFile(), "Claude Code managed settings file")
	codexFile := fs.String("codex-file", hookstate.CodexManagedFile(), "Codex managed configuration file")
	remove := fs.Bool("remove", false, "point the agents back at their providers")
	_ = fs.Parse(args)

	failed := false
	for _, a := range strings.Split(*agents, ",") {
		var msg string
		var err error
		switch a = strings.TrimSpace(a); a {
		case "claude":
			msg, err = gatewayClaude(*claudeFile, *addr, *remove)
		case "codex":
			msg, err = gatewayCodex(*codexFile, *addr, *remove)
		case "gemini":
			err = fmt.Errorf("not supported: Gemini CLI takes its base URL (GOOGLE_GEMINI_BASE_URL) only from the environment, and only with a Gemini API key")
		case "cursor":
			err = fmt.Errorf("not supported: Cursor sends its model calls from Cursor's servers, which can't reach this machine's gateway")
		case "":
			continue
		default:
			err = fmt.Errorf("unknown agent %q (claude, codex)", a)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "effigentd: %s: %v\n", a, err)
			failed = true
			continue
		}
		fmt.Println(msg)
	}
	if failed {
		os.Exit(1)
	}
}

// ---- Claude Code: managed-settings.json env.ANTHROPIC_BASE_URL ----

func gatewayClaude(file, addr string, remove bool) (string, error) {
	settings, err := readJSON(file)
	if err != nil {
		return "", err
	}
	env, _ := settings["env"].(map[string]any)
	if env == nil {
		env = map[string]any{}
	}
	cur, _ := env["ANTHROPIC_BASE_URL"].(string)
	if remove {
		if cur == "" || !hookstate.IsGatewayURL(cur, "") {
			return "Claude Code was not pointed at the gateway (" + file + ")", nil
		}
		delete(env, "ANTHROPIC_BASE_URL")
	} else {
		if cur != "" && !hookstate.IsGatewayURL(cur, "") {
			return "", fmt.Errorf("%s already sets ANTHROPIC_BASE_URL to %s; remove it first if the gateway should replace it", file, cur)
		}
		env["ANTHROPIC_BASE_URL"] = hookstate.GatewayURL(addr, "anthropic", "claude-code")
	}
	setOrDelete(settings, "env", env)
	if err := writeJSON(file, settings); err != nil {
		return "", err
	}
	if remove {
		return "Claude Code talks to its provider directly again (" + file + ")", nil
	}
	return "Claude Code sends its model calls through effigentd's gateway at " + addr + " (" + file +
		"; Bedrock / Vertex setups bypass it)", nil
}

// ---- Codex: managed_config.toml openai_base_url ----

// gatewayCodex sets the built-in OpenAI provider's base URL in Codex's
// managed defaults, which Codex applies over the user's config.toml and
// --config flags at every start. Both sign-ins use it: the gateway sends
// ChatGPT sign-ins to the Codex backend and API keys to api.openai.com/v1.
func gatewayCodex(file, addr string, remove bool) (string, error) {
	if file == "" {
		return "", fmt.Errorf("Codex has no machine-wide managed_config.toml on this OS; pass --codex-file (a user's ~/.codex/managed_config.toml)")
	}
	cfg := map[string]any{}
	b, err := os.ReadFile(file)
	switch {
	case err == nil && len(b) > 0:
		if err := toml.Unmarshal(b, &cfg); err != nil {
			return "", fmt.Errorf("%s is not valid TOML (%v); fix or move it first", file, err)
		}
	case err != nil && !errors.Is(err, os.ErrNotExist):
		return "", err
	}
	cur, _ := cfg["openai_base_url"].(string)
	if remove {
		if cur == "" || !hookstate.IsGatewayURL(cur, "") {
			return "Codex was not pointed at the gateway (" + file + ")", nil
		}
		delete(cfg, "openai_base_url")
	} else {
		if cur != "" && !hookstate.IsGatewayURL(cur, "") {
			return "", fmt.Errorf("%s already sets openai_base_url to %s; remove it first if the gateway should replace it", file, cur)
		}
		cfg["openai_base_url"] = hookstate.GatewayURL(addr, "codex", "codex")
	}
	if len(b) > 0 { // rewriting drops comments: keep the admin's original once
		if _, err := os.Stat(file + ".effigent-backup"); errors.Is(err, os.ErrNotExist) {
			_ = os.WriteFile(file+".effigent-backup", b, 0o644)
		}
	}
	if remove && len(cfg) == 0 {
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	} else {
		out, err := toml.Marshal(cfg)
		if err != nil {
			return "", err
		}
		if err := writeFile(file, out); err != nil {
			return "", err
		}
	}
	if remove {
		return "Codex talks to OpenAI directly again (" + file + "; from its next start)", nil
	}
	msg := "Codex sends its model calls through effigentd's gateway at " + addr + " (" + file + "; from its next start"
	if p, _ := cfg["model_provider"].(string); p != "" && p != "openai" {
		msg += "; but model_provider = " + p + " there, which the base URL doesn't cover"
	}
	return msg + ")", nil
}
