package hooks

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/hookstate"
	"github.com/effigent/effigent/internal/endpoint/peer"
	"github.com/pelletier/go-toml/v2"
)

// MCP server pinning (policy mcp_pins). A server's fingerprint is the sha256
// of its definition in the agent's MCP config: transport, command, args,
// cwd, URL, and the names (never the values) of its env vars and headers.
// The configs, in the order each agent applies them (checked 2026-10-21):
//   - Claude Code (https://code.claude.com/docs/en/mcp, /managed-mcp):
//     managed-mcp.json (exclusive when deployed), then ~/.claude.json
//     projects[<project>].mcpServers (local), .mcp.json (project),
//     ~/.claude.json mcpServers (user)
//   - Codex (https://learn.chatgpt.com/docs/extend/mcp): [mcp_servers.<name>]
//     in the project's .codex/config.toml, then $CODEX_HOME/config.toml
//     (~/.codex/config.toml)
//   - Gemini CLI (docs/tools/mcp-server.md): system settings.json, then the
//     project's .gemini/settings.json, then ~/.gemini/settings.json
//   - Cursor: the project's .cursor/mcp.json, then ~/.cursor/mcp.json
//
// It tells when the definition changed (another package, command, URL or
// argument), not when a remote server changes what it does or which tools
// it lists behind the same URL, nor what a package resolves to on disk.

// mcpDef is one server definition, reduced to what its fingerprint covers.
type mcpDef struct {
	Name      string // as the config spells it
	Transport string // stdio | remote
	Command   string
	Args      []string
	Cwd       string
	URL       string
	Env       []string // names
	Headers   []string // names
}

func (d mcpDef) fingerprint() string {
	b, _ := json.Marshal(struct {
		T string   `json:"t"`
		C string   `json:"c,omitempty"`
		A []string `json:"a,omitempty"`
		D string   `json:"d,omitempty"`
		U string   `json:"u,omitempty"`
		E []string `json:"e,omitempty"`
		H []string `json:"h,omitempty"`
	}{d.Transport, d.Command, d.Args, d.Cwd, d.URL, d.Env, d.Headers})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// defOf reads one entry of mcpServers (JSON) or [mcp_servers.<name>] (Codex TOML).
func defOf(name string, m map[string]any) mcpDef {
	s := func(k string) string { v, _ := m[k].(string); return strings.TrimSpace(v) }
	keys := func(k string) []string {
		mm, _ := m[k].(map[string]any)
		out := make([]string, 0, len(mm))
		for n := range mm {
			out = append(out, n)
		}
		return out
	}
	d := mcpDef{Name: name, Command: s("command"), Cwd: s("cwd")}
	for _, k := range []string{"url", "httpUrl", "tcp"} {
		if d.URL = s(k); d.URL != "" {
			break
		}
	}
	if l, ok := m["args"].([]any); ok {
		for _, a := range l {
			if v, ok := a.(string); ok {
				d.Args = append(d.Args, v)
			}
		}
	}
	d.Env = keys("env")
	if l, ok := m["env_vars"].([]any); ok { // Codex: variables passed through
		for _, v := range l {
			if n, ok := v.(string); ok {
				d.Env = append(d.Env, n)
			}
		}
	}
	if v := s("bearer_token_env_var"); v != "" {
		d.Env = append(d.Env, v)
	}
	d.Headers = append(append(keys("headers"), keys("http_headers")...), keys("env_http_headers")...)
	d.Env, d.Headers = sortedSet(d.Env), sortedSet(d.Headers)
	d.Transport = "remote"
	if d.Command != "" {
		d.Transport = "stdio"
	}
	return d
}

func sortedSet(l []string) []string {
	if len(l) == 0 {
		return nil
	}
	sort.Strings(l)
	return slices.Compact(l)
}

// ---- config files (read as the agent's user, parsed once per version) ----

const maxMCPConfig = 32 << 20 // ~/.claude.json keeps every project's history

type mcpFile struct {
	mod  time.Time
	size int64
	// stable: written well before it was read, so a same-size edit within
	// the file system's mtime granularity can't hide behind the cache
	stable bool
	top    map[string]mcpDef            // by lowercase name
	proj   map[string]map[string]mcpDef // ~/.claude.json projects[path]
}

var (
	mcpCacheMu sync.Mutex
	mcpCache   = map[string]*mcpFile{}
)

func loadMCPFile(in ClaudeInput, p string) *mcpFile {
	if p == "" {
		return nil
	}
	f, err := peer.OpenIn(in.Root, p) // a container's file system when the agent runs in one
	if err != nil {
		return nil
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > maxMCPConfig || !userCanRead(st, in) {
		return nil
	}
	key := in.Root + "\x00" + p
	mcpCacheMu.Lock()
	c := mcpCache[key]
	mcpCacheMu.Unlock()
	if c != nil && c.stable && c.mod.Equal(st.ModTime()) && c.size == st.Size() {
		return c
	}
	b, err := io.ReadAll(io.LimitReader(f, maxMCPConfig))
	if err != nil {
		return nil
	}
	c = &mcpFile{mod: st.ModTime(), size: st.Size(), stable: time.Since(st.ModTime()) > 2*time.Second, top: map[string]mcpDef{}}
	defs := func(m map[string]any) map[string]mcpDef {
		out := map[string]mcpDef{}
		for name, v := range m {
			if e, ok := v.(map[string]any); ok {
				out[strings.ToLower(name)] = defOf(name, e)
			}
		}
		return out
	}
	if strings.HasSuffix(p, ".toml") {
		var t map[string]any
		if toml.Unmarshal(b, &t) == nil {
			s, _ := t["mcp_servers"].(map[string]any)
			c.top = defs(s)
		}
	} else {
		var j struct {
			MCPServers map[string]any `json:"mcpServers"`
			Projects   map[string]struct {
				MCPServers map[string]any `json:"mcpServers"`
			} `json:"projects"`
		}
		if json.Unmarshal(b, &j) == nil {
			c.top = defs(j.MCPServers)
			for dir, pr := range j.Projects {
				if len(pr.MCPServers) > 0 {
					if c.proj == nil {
						c.proj = map[string]map[string]mcpDef{}
					}
					c.proj[dir] = defs(pr.MCPServers)
				}
			}
		}
	}
	mcpCacheMu.Lock()
	if len(mcpCache) > 256 {
		clear(mcpCache)
	}
	mcpCache[key] = c
	mcpCacheMu.Unlock()
	return c
}

// System-wide MCP configs (variables for tests).
var (
	claudeManagedMCP     = filepath.Join(filepath.Dir(hookstate.ClaudeFile()), "managed-mcp.json")
	geminiSystemSettings = hookstate.GeminiFile()
)

type mcpScope struct {
	source string // user, project, local, managed, system
	file   string
	defs   map[string]mcpDef
}

// mcpScopes are the agent's MCP configs, highest precedence first.
func mcpScopes(in ClaudeInput) []mcpScope {
	home, cwd := strings.ReplaceAll(in.Home, `\`, "/"), strings.ReplaceAll(in.Cwd, `\`, "/")
	var out []mcpScope
	add := func(source, file string, defs func(*mcpFile) map[string]mcpDef) {
		if c := loadMCPFile(in, file); c != nil {
			if d := defs(c); len(d) > 0 {
				out = append(out, mcpScope{source, file, d})
			}
		}
	}
	top := func(c *mcpFile) map[string]mcpDef { return c.top }
	up := func(name string) string {
		if cwd == "" || !strings.HasPrefix(cwd, "/") && !isDrive(cwd) {
			return ""
		}
		return findUp(in, cwd, name)
	}
	at := func(rel string) string {
		if home == "" {
			return ""
		}
		return path.Join(home, rel)
	}
	switch in.Agent {
	case "codex":
		add("project", up(".codex/config.toml"), top)
		if ch := in.Env["CODEX_HOME"]; ch != "" {
			add("user", path.Join(ch, "config.toml"), top)
		}
		add("user", at(".codex/config.toml"), top)
	case "gemini-cli", "gemini":
		add("system", geminiSystemSettings, top)
		add("project", up(".gemini/settings.json"), top)
		add("user", at(".gemini/settings.json"), top)
	case "cursor-agent", "cursor":
		add("project", up(".cursor/mcp.json"), top)
		add("user", at(".cursor/mcp.json"), top)
	default: // Claude Code
		if c := loadMCPFile(in, claudeManagedMCP); c != nil && len(c.top) > 0 {
			return []mcpScope{{"managed", claudeManagedMCP, c.top}} // exclusive
		}
		add("local", at(".claude.json"), func(c *mcpFile) map[string]mcpDef {
			best := ""
			for dir := range c.proj {
				if (cwd == dir || strings.HasPrefix(cwd, strings.TrimSuffix(dir, "/")+"/")) && len(dir) > len(best) {
					best = dir
				}
			}
			return c.proj[best]
		})
		add("project", up(".mcp.json"), top)
		add("user", at(".claude.json"), top)
	}
	return out
}

// lookupMCP is the definition the agent uses for server (lowercase).
func lookupMCP(in ClaudeInput, server string) (mcpDef, mcpScope, bool) {
	for _, s := range mcpScopes(in) {
		if d, ok := s.defs[server]; ok {
			return d, s, true
		}
	}
	return mcpDef{}, mcpScope{}, false
}

// MCPServers lists the MCP servers the agent's configs define, as the agent
// resolves them, with their fingerprints (reported on agent_start; copy one
// into mcp_pins to pin it).
func MCPServers(in ClaudeInput) []event.MCPServer {
	var out []event.MCPServer
	seen := map[string]bool{}
	for _, s := range mcpScopes(in) {
		names := make([]string, 0, len(s.defs))
		for n := range s.defs {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			if seen[n] || len(out) >= 100 {
				continue
			}
			seen[n] = true
			d := s.defs[n]
			out = append(out, event.MCPServer{Name: d.Name, Source: s.source, Transport: d.Transport, Fingerprint: d.fingerprint()})
		}
	}
	return out
}

// mcpPin adds mcp_changed when server is pinned and the agent's definition
// of it isn't one of its pins (or can't be found or read).
func (x *actx) mcpPin(server string) {
	pins, ok := x.rule.MCPPins[server]
	if !ok {
		return
	}
	attrs := map[string]string{"mcp_server": server}
	d, s, found := lookupMCP(x.in, server)
	if !found {
		attrs["fingerprint"] = "unknown"
		x.add(event.Action{Kind: "mcp_changed", Target: server + ": no definition the agent's user can read in its MCP config", Attrs: attrs})
		return
	}
	fp := d.fingerprint()
	if slices.Contains(pins, fp) {
		return
	}
	attrs["fingerprint"], attrs["source"] = fp, s.source
	what := d.Command
	if d.Transport == "remote" {
		what = d.URL
	}
	x.add(event.Action{Kind: "mcp_changed", Target: server + ": " + s.source + " config now runs " + cut(what, 200) + " (fingerprint " + fp[:12] + ")", Attrs: attrs})
}
