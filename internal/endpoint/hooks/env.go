package hooks

import (
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

// model adds model_endpoint / model_api_key, only when a policy list names them.
func (x *actx) model() {
	if !listsName(x.rule, "model_endpoint", "model_api_key") || x.in.Env == nil {
		return
	}
	if len(x.rule.ModelHostsAllow) > 0 && listsName(x.rule, "model_endpoint") {
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
	if x.mcpDatabase(server, tool, input) {
		return // its statements carry the server (access@env included)
	}
	for _, e := range x.rule.Environments {
		if slices.ContainsFunc(e.MCPServers, func(p string) bool { return wild(p, server) }) {
			x.add(event.Action{Kind: "access", Target: tool, Attrs: map[string]string{"mcp_server": server}})
			break
		}
	}
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
