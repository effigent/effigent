package hooks

import (
	"net"
	"net/url"
	"slices"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// The agent's environment as the hook process forwards it to the daemon
// (X-Effigent-Agent-Env): only the variables that say which identity, host
// or registry a command will use, never a secret. Like the OS user, it is
// what the hook process reports; an agent that controls its own hook's
// environment can make it say something else.

// agentEnvValues are forwarded with their value (URLs without credentials).
var agentEnvValues = []string{
	"AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE",
	"KUBECONFIG", "CLOUDSDK_CORE_PROJECT", "CLOUDSDK_ACTIVE_CONFIG_NAME", "CLOUDSDK_CONFIG", "GOOGLE_CLOUD_PROJECT",
	"GOOGLE_PROJECT", "AZURE_CONFIG_DIR", "ARM_SUBSCRIPTION_ID", "AZURE_SUBSCRIPTION_ID", "TF_WORKSPACE",
	"PGHOST", "MYSQL_HOST", "SQLCMDSERVER", "CLICKHOUSE_HOST", "COCKROACH_HOST", "DATABASE_URL",
	"ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "GOOGLE_GEMINI_BASE_URL", "GEMINI_API_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
	"ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "GOOGLE_GENAI_USE_VERTEXAI", "HTTPS_PROXY", "https_proxy",
	"NPM_CONFIG_REGISTRY", "npm_config_registry", "npm_config_ignore_scripts", "NPM_CONFIG_IGNORE_SCRIPTS",
	"PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_DEFAULT_INDEX",
	"HUSKY", "SKIP_HOOKS", "SKIP",
}

// agentEnvSet are forwarded as "set" when present: credentials whose
// presence matters, never their value.
var agentEnvSet = []string{
	"AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY",
	"GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GITHUB_TOKEN", "GH_TOKEN",
	"AZURE_CLIENT_SECRET", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY",
}

// AgentEnv picks the forwarded variables out of an environment (os.Environ form).
func AgentEnv(environ []string) map[string]string {
	out := map[string]string{}
	for _, kv := range environ {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || v == "" {
			continue
		}
		switch {
		case slices.Contains(agentEnvSet, k):
			out[k] = "set"
		case slices.Contains(agentEnvValues, k):
			out[k] = clip(stripCreds(v), 300)
		}
	}
	return out
}

// CleanAgentEnv keeps only forwarded names from a map the daemon received.
func CleanAgentEnv(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		switch {
		case slices.Contains(agentEnvSet, k):
			out[k] = "set"
		case slices.Contains(agentEnvValues, k) && v != "":
			out[k] = clip(stripCreds(v), 300)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// stripCreds removes user:password@ (and query secrets) from URLs.
func stripCreds(v string) string {
	if !strings.Contains(v, "://") {
		return v
	}
	var parts []string
	for _, s := range strings.Split(v, " ") {
		if u, err := url.Parse(s); err == nil && u.Host != "" {
			u.User = nil
			u.RawQuery = ""
			s = u.String()
		} else if strings.Contains(s, "@") {
			s = "[unparsed url]"
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, " ")
}

// default model API hosts, per agent.
var defaultModelHost = map[string]string{
	"claude-code": "api.anthropic.com", "claude": "api.anthropic.com", "codex": "api.openai.com",
	"gemini": "generativelanguage.googleapis.com", "gemini-cli": "generativelanguage.googleapis.com",
}

// ModelHosts are the model API hosts an agent's environment points it at.
func ModelHosts(agent string, env map[string]string) []string {
	var out []string
	add := func(raw string) {
		if raw == "" {
			return
		}
		if h := urlHost(raw); h != "" {
			out = append(out, h)
		} else {
			out = append(out, strings.ToLower(raw))
		}
	}
	switch {
	case truthy(env["CLAUDE_CODE_USE_BEDROCK"]) && isClaude(agent):
		if b := env["ANTHROPIC_BEDROCK_BASE_URL"]; b != "" {
			add(b)
		} else {
			region := firstNonEmpty(env["AWS_REGION"], env["AWS_DEFAULT_REGION"], "us-east-1")
			out = append(out, "bedrock-runtime."+region+".amazonaws.com")
		}
	case truthy(env["CLAUDE_CODE_USE_VERTEX"]) && isClaude(agent):
		if b := env["ANTHROPIC_VERTEX_BASE_URL"]; b != "" {
			add(b)
		} else {
			out = append(out, "aiplatform.googleapis.com")
		}
	case isClaude(agent):
		add(firstNonEmpty(env["ANTHROPIC_BASE_URL"], defaultModelHost[agent]))
	case agent == "codex":
		add(firstNonEmpty(env["OPENAI_BASE_URL"], env["OPENAI_API_BASE"], defaultModelHost[agent]))
	case strings.HasPrefix(agent, "gemini"):
		if truthy(env["GOOGLE_GENAI_USE_VERTEXAI"]) {
			out = append(out, "aiplatform.googleapis.com")
		} else {
			add(firstNonEmpty(env["GOOGLE_GEMINI_BASE_URL"], env["GEMINI_API_BASE_URL"], defaultModelHost["gemini"]))
		}
	}
	return out
}

func isClaude(agent string) bool { return agent == "claude-code" || agent == "claude" }

// modelKeys are the API key variables that bill a model vendor directly.
var modelKeys = map[string][]string{
	"claude": {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}, "codex": {"OPENAI_API_KEY", "CODEX_API_KEY"},
	"gemini": {"GEMINI_API_KEY", "GOOGLE_API_KEY"},
}

// model adds model_endpoint / model_api_key, only when a policy list names
// them (or models.require_gateway is on).
func (x *actx) model() {
	if x.rule.RequireGateway && GatewayAgent(x.in.Agent) {
		// The gateway carried this session's model calls, or the agent's
		// environment points it there; anything else goes around it.
		if !x.in.ViaGateway && !OnGateway(x.in.Agent, x.in.Env, x.rule.GatewayAddr) {
			target := "unknown host"
			if hs := ModelHosts(x.in.Agent, x.in.Env); len(hs) > 0 {
				target = hs[0]
			}
			x.add(event.Action{Kind: "model_endpoint", Target: target + ", not through the Effigent model gateway",
				Attrs: map[string]string{"agent": x.in.Agent, "gateway": firstNonEmpty(x.rule.GatewayAddr, "off")}})
		}
	}
	if !listsName(x.rule, "model_endpoint", "model_api_key") || x.in.Env == nil {
		return
	}
	if len(x.rule.ModelHostsAllow) > 0 && listsName(x.rule, "model_endpoint") && !x.rule.RequireGateway {
		for _, h := range ModelHosts(x.in.Agent, x.in.Env) {
			if !hostMatches(x.rule.ModelHostsAllow, h) {
				x.add(event.Action{Kind: "model_endpoint", Target: h, Attrs: map[string]string{"agent": x.in.Agent}})
			}
		}
	}
	if listsName(x.rule, "model_api_key") {
		fam := x.in.Agent
		if isClaude(fam) {
			fam = "claude"
		} else if strings.HasPrefix(fam, "gemini") {
			fam = "gemini"
		}
		for _, k := range modelKeys[fam] {
			if x.in.Env[k] != "" {
				x.add(event.Action{Kind: "model_api_key", Target: k, Attrs: map[string]string{"agent": x.in.Agent}})
			}
		}
	}
}

// mcp: a call to an MCP server outside mcp_allow, and the server as a target
// for environments that name it.
func (x *actx) mcp(tool string, input map[string]any) {
	server := mcpServer(tool)
	if server == "" {
		return
	}
	if len(x.rule.MCPAllow) > 0 && !slices.ContainsFunc(x.rule.MCPAllow, func(p string) bool { return wild(p, server) }) {
		x.add(event.Action{Kind: "mcp_unlisted", Target: server, Attrs: map[string]string{"tool": tool}})
	}
	for _, e := range x.rule.Environments {
		if slices.ContainsFunc(e.MCPServers, func(p string) bool { return wild(p, server) }) {
			x.add(event.Action{Kind: "access", Target: tool, Attrs: map[string]string{"mcp_server": server}})
			break
		}
	}
	_ = input
}

// mcpServer is the server of an mcp__<server>__<tool> name.
func mcpServer(tool string) string {
	rest, ok := strings.CutPrefix(tool, "mcp__")
	if !ok {
		return ""
	}
	s, _, _ := strings.Cut(rest, "__")
	return strings.ToLower(s)
}

// GatewayAgent reports whether effigentd's model gateway can carry an
// agent's model traffic (require_gateway applies to it).
func GatewayAgent(agent string) bool {
	return isClaude(agent) || agent == "codex" || strings.HasPrefix(agent, "gemini")
}

// gatewayVars is where each agent's base URL points it at the gateway, and
// the gateway providers it may name.
var gatewayVars = map[string]struct {
	vars  []string
	provs []string
}{
	"claude": {[]string{"ANTHROPIC_BASE_URL"}, []string{"anthropic"}},
	// Codex reads its base URL from config (openai_base_url), not from its
	// environment (OPENAI_BASE_URL isn't one in Codex): only the gateway
	// having seen the session counts (ClaudeInput.ViaGateway).
	"codex":  {nil, []string{"codex", "openai"}},
	"gemini": {[]string{"GOOGLE_GEMINI_BASE_URL"}, []string{"gemini"}},
}

// OnGateway reports whether an agent's environment points it at the gateway
// listening on addr: a loopback base URL on that port whose path names one of
// the agent's providers. Bedrock and Vertex bypass ANTHROPIC_BASE_URL.
func OnGateway(agent string, env map[string]string, addr string) bool {
	if addr == "" || env == nil {
		return false
	}
	fam := agent
	switch {
	case isClaude(agent):
		if truthy(env["CLAUDE_CODE_USE_BEDROCK"]) || truthy(env["CLAUDE_CODE_USE_VERTEX"]) {
			return false
		}
		fam = "claude"
	case strings.HasPrefix(agent, "gemini"):
		fam = "gemini"
	}
	gv, ok := gatewayVars[fam]
	if !ok {
		return false
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	for _, k := range gv.vars {
		u, err := url.Parse(env[k])
		if err != nil || u.Port() != port || !loopbackName(u.Hostname()) {
			continue
		}
		prov, _, _ := strings.Cut(strings.TrimPrefix(u.Path, "/"), "/")
		if slices.Contains(gv.provs, prov) {
			return true
		}
	}
	return false
}

func loopbackName(h string) bool {
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
