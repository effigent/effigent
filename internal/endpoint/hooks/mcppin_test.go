package hooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func noSystemMCP(t *testing.T) {
	m, g := claudeManagedMCP, geminiSystemSettings
	claudeManagedMCP, geminiSystemSettings = filepath.Join(t.TempDir(), "none.json"), filepath.Join(t.TempDir(), "none.json")
	t.Cleanup(func() { claudeManagedMCP, geminiSystemSettings = m, g })
}

func fpOf(t *testing.T, in ClaudeInput, name string) (string, string) {
	t.Helper()
	for _, s := range MCPServers(in) {
		if strings.EqualFold(s.Name, name) {
			return s.Fingerprint, s.Source
		}
	}
	t.Fatalf("%s not listed: %+v", name, MCPServers(in))
	return "", ""
}

func TestMCPFingerprint(t *testing.T) {
	a := defOf("x", map[string]any{"command": "npx", "args": []any{"-y", "@acme/mcp@1.2.0"}, "env": map[string]any{"B": "1", "A": "secret"}})
	b := defOf("x", map[string]any{"command": "npx", "args": []any{"-y", "@acme/mcp@1.2.0"}, "env": map[string]any{"A": "other", "B": "2"}})
	if a.fingerprint() != b.fingerprint() {
		t.Error("env values or order changed the fingerprint")
	}
	for _, m := range []map[string]any{
		{"command": "npx", "args": []any{"-y", "@acme/mcp@1.3.0"}, "env": map[string]any{"A": "", "B": ""}},
		{"command": "npx", "args": []any{"-y", "@acme/mcp@1.2.0"}, "env": map[string]any{"A": "", "B": "", "C": ""}},
		{"command": "bunx", "args": []any{"-y", "@acme/mcp@1.2.0"}, "env": map[string]any{"A": "", "B": ""}},
	} {
		if defOf("x", m).fingerprint() == a.fingerprint() {
			t.Errorf("%v: same fingerprint", m)
		}
	}
	u1 := defOf("r", map[string]any{"type": "http", "url": "https://mcp.example.com/mcp", "headers": map[string]any{"Authorization": "Bearer x"}})
	u2 := defOf("r", map[string]any{"url": "https://mcp.example.com/mcp", "headers": map[string]any{"Authorization": "Bearer y"}})
	if u1.fingerprint() != u2.fingerprint() || u1.Transport != "remote" {
		t.Error("remote: header values or the declared type changed it")
	}
	if defOf("r", map[string]any{"url": "https://evil.example.com/mcp"}).fingerprint() == u2.fingerprint() {
		t.Error("another URL, same fingerprint")
	}
}

func TestMCPScopes(t *testing.T) {
	noSystemMCP(t)
	home, proj := t.TempDir(), t.TempDir()
	cwd := filepath.Join(proj, "sub")
	os.MkdirAll(cwd, 0o755)
	writeFile(t, filepath.Join(home, ".claude.json"), `{"mcpServers":{"github":{"command":"user-gh"},"Linear":{"type":"http","url":"https://mcp.linear.app/mcp"}},
		"projects":{"`+proj+`":{"mcpServers":{"db":{"command":"local-db"}}},"/elsewhere":{"mcpServers":{"github":{"command":"other"}}}}}`)
	writeFile(t, filepath.Join(proj, ".mcp.json"), `{"mcpServers":{"github":{"command":"project-gh"},"db":{"command":"project-db"}}}`)
	in := ClaudeInput{Agent: "claude-code", Home: home, Cwd: cwd}
	for name, want := range map[string]string{"github": "project", "db": "local", "linear": "user"} {
		if _, src := fpOf(t, in, name); src != want {
			t.Errorf("claude %s: from %s, want %s", name, src, want)
		}
	}
	if d, _, _ := lookupMCP(in, "github"); d.Command != "project-gh" {
		t.Errorf("claude github: %+v", d)
	}
	// managed-mcp.json takes over
	claudeManagedMCP = filepath.Join(t.TempDir(), "managed-mcp.json")
	writeFile(t, claudeManagedMCP, `{"mcpServers":{"github":{"command":"managed-gh"}}}`)
	if d, s, ok := lookupMCP(in, "github"); !ok || d.Command != "managed-gh" || s.source != "managed" {
		t.Errorf("managed: %+v %s", d, s.source)
	}
	if _, _, ok := lookupMCP(in, "linear"); ok {
		t.Error("managed MCP is exclusive")
	}
	claudeManagedMCP = filepath.Join(t.TempDir(), "none.json")

	// Codex: project config over user config, CODEX_HOME
	writeFile(t, filepath.Join(home, ".codex", "config.toml"), "[mcp_servers.docs]\ncommand = \"user-docs\"\n[mcp_servers.gh]\nurl = \"https://api.githubcopilot.com/mcp/\"\nbearer_token_env_var = \"GH_TOKEN\"\n")
	writeFile(t, filepath.Join(proj, ".codex", "config.toml"), "[mcp_servers.docs]\ncommand = \"project-docs\"\nargs = [\"--x\"]\nenv_vars = [\"DOCS_KEY\"]\n")
	cin := ClaudeInput{Agent: "codex", Home: home, Cwd: cwd}
	if d, s, ok := lookupMCP(cin, "docs"); !ok || d.Command != "project-docs" || s.source != "project" || strings.Join(d.Env, ",") != "DOCS_KEY" {
		t.Errorf("codex docs: %+v %s", d, s.source)
	}
	if d, _, ok := lookupMCP(cin, "gh"); !ok || d.Transport != "remote" || strings.Join(d.Env, ",") != "GH_TOKEN" {
		t.Errorf("codex gh: %+v", d)
	}
	alt := t.TempDir()
	writeFile(t, filepath.Join(alt, "config.toml"), "[mcp_servers.gh]\ncommand = \"alt\"\n")
	cin.Env = map[string]string{"CODEX_HOME": alt}
	if d, _, _ := lookupMCP(cin, "gh"); d.Command != "alt" {
		t.Errorf("CODEX_HOME: %+v", d)
	}

	// Gemini: system settings win, then project, then user
	writeFile(t, filepath.Join(home, ".gemini", "settings.json"), `{"mcpServers":{"fs":{"command":"user-fs"},"web":{"httpUrl":"https://w.example.com/mcp"}}}`)
	writeFile(t, filepath.Join(proj, ".gemini", "settings.json"), `{"mcpServers":{"fs":{"command":"project-fs","cwd":"./tools"}}}`)
	gin := ClaudeInput{Agent: "gemini-cli", Home: home, Cwd: cwd}
	if d, _, _ := lookupMCP(gin, "fs"); d.Command != "project-fs" || d.Cwd != "./tools" {
		t.Errorf("gemini fs: %+v", d)
	}
	geminiSystemSettings = filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, geminiSystemSettings, `{"mcpServers":{"fs":{"command":"system-fs"}}}`)
	if d, s, _ := lookupMCP(gin, "fs"); d.Command != "system-fs" || s.source != "system" {
		t.Errorf("gemini system: %+v", d)
	}
	if d, _, _ := lookupMCP(gin, "web"); d.URL != "https://w.example.com/mcp" {
		t.Errorf("gemini httpUrl: %+v", d)
	}

	// Cursor
	writeFile(t, filepath.Join(home, ".cursor", "mcp.json"), `{"mcpServers":{"notion":{"url":"https://mcp.notion.com/mcp"}}}`)
	if _, src := fpOf(t, ClaudeInput{Agent: "cursor-agent", Home: home, Cwd: cwd}, "notion"); src != "user" {
		t.Errorf("cursor: %s", src)
	}

	// no home, no cwd: nothing read
	if l := MCPServers(ClaudeInput{Agent: "claude-code"}); len(l) != 0 {
		t.Errorf("nothing to read: %+v", l)
	}
}

func TestMCPPins(t *testing.T) {
	noSystemMCP(t)
	home, cwd := t.TempDir(), t.TempDir()
	cfg := filepath.Join(home, ".claude.json")
	writeFile(t, cfg, `{"mcpServers":{"github":{"command":"npx","args":["-y","@modelcontextprotocol/server-github@1.0.0"],"env":{"GITHUB_TOKEN":"ghp_x"}}}}`)
	in := ClaudeInput{Agent: "claude-code", Home: home, Cwd: cwd, ToolName: "mcp__github__create_issue", ToolInput: map[string]any{"title": "x"}}
	fp, _ := fpOf(t, in, "github")

	raw := "defaults:\n  mode: denylist\n  actions_deny: [mcp_changed]\nmcp_pins:\n  GitHub: sha256:" + strings.ToUpper(fp) + "\n  other: [" + strings.Repeat("a", 64) + ", " + strings.Repeat("b", 64) + "]\n"
	p, err := policy.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	rule := p.RuleFor("claude-code")
	if got := rule.MCPPins["github"]; len(got) != 1 || got[0] != fp || len(rule.MCPPins["other"]) != 2 {
		t.Fatalf("pins: %+v", rule.MCPPins)
	}
	if d := EvaluateClaude(rule, in); d.Deny || has(d, "mcp_changed") {
		t.Errorf("pinned definition: %+v", d)
	}
	// the package version moved
	writeFile(t, cfg, `{"mcpServers":{"github":{"command":"npx","args":["-y","@modelcontextprotocol/server-github@1.0.1"],"env":{"GITHUB_TOKEN":"ghp_x"}}}}`)
	d := EvaluateClaude(rule, in)
	if !d.Deny || !has(d, "mcp_changed") || !strings.Contains(d.Reason, "github") || !strings.Contains(d.Reason, "npx") {
		t.Errorf("changed definition: %+v", d)
	}
	// another server (not pinned) is not checked
	if d := EvaluateClaude(rule, ClaudeInput{Agent: "claude-code", Home: home, Cwd: cwd, ToolName: "mcp__linear__list"}); has(d, "mcp_changed") {
		t.Errorf("unpinned: %+v", d.Actions)
	}
	// pinned but not in any config the user can read
	if d := EvaluateClaude(rule, ClaudeInput{Agent: "claude-code", Home: t.TempDir(), Cwd: cwd, ToolName: "mcp__github__x"}); !d.Deny ||
		d.Actions[0].Attrs["fingerprint"] != "unknown" {
		t.Errorf("not found: %+v", d)
	}
	for _, bad := range []string{"mcp_pins:\n  x: nothex\n", "mcp_pins:\n  \"gh*\": " + fp + "\n", "mcp_pins:\n  x: []\n", "mcp_pins:\n  x: {a: b}\n"} {
		if _, err := policy.Parse([]byte("defaults:\n  mode: denylist\n" + bad)); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}
