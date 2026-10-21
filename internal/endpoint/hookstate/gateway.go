package hookstate

import (
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Gateway states: whether an agent's machine-wide config points it at
// effigentd's model gateway (`effigentd install-gateway`).
const (
	GatewayOn        = "on"        // pointed at this machine's gateway
	GatewayOff       = "off"       // not configured: the agent talks to its provider
	GatewayElsewhere = "elsewhere" // a base URL that isn't the gateway (another proxy or host)
	GatewayOtherPort = "other_port"
)

// Gateway is one agent's gateway configuration.
type Gateway struct {
	State  string `json:"state"`
	URL    string `json:"url,omitempty"` // the configured base URL, credentials and query removed
	File   string `json:"file"`
	Detail string `json:"detail,omitempty"`
}

// gatewayProviders are the gateway's first path segments.
var gatewayProviders = []string{"anthropic", "openai", "codex", "gemini"}

// GatewayURL is the base URL that sends an agent's calls for a provider
// through the gateway at addr.
func GatewayURL(addr, provider, agent string) string {
	return "http://" + addr + "/" + provider + "/" + agent
}

// IsGatewayURL reports whether a base URL is the gateway's: loopback, a
// gateway provider path, and (addr != "") the gateway's port.
func IsGatewayURL(raw, addr string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" {
		return false
	}
	h := u.Hostname()
	if ip := net.ParseIP(h); !strings.EqualFold(h, "localhost") && (ip == nil || !ip.IsLoopback()) {
		return false
	}
	prov, _, _ := strings.Cut(strings.TrimPrefix(u.Path, "/"), "/")
	ok := false
	for _, p := range gatewayProviders {
		ok = ok || p == prov
	}
	if !ok {
		return false
	}
	if addr != "" {
		if _, port, err := net.SplitHostPort(addr); err == nil && u.Port() != port {
			return false
		}
	}
	return true
}

func gatewayState(file, raw, addr string) *Gateway {
	g := &Gateway{File: file, State: GatewayOff}
	if raw == "" {
		return g
	}
	g.URL = cleanURL(raw)
	switch {
	case addr == "" && IsGatewayURL(raw, ""):
		// pointed at a gateway, but effigentd runs none: the agent is cut off
		g.State, g.Detail = GatewayOtherPort, "effigentd's model gateway is off on this machine (-gateway \"\" or it couldn't listen)"
	case IsGatewayURL(raw, addr):
		g.State = GatewayOn
	case IsGatewayURL(raw, ""):
		g.State, g.Detail = GatewayOtherPort, "points at a gateway port effigentd doesn't listen on ("+addr+")"
	default:
		g.State = GatewayElsewhere
	}
	return g
}

func cleanURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "[unparsed]"
	}
	u.User, u.RawQuery = nil, ""
	return u.String()
}

// checkGateways adds each gateway-capable agent's gateway state.
func checkGateways(o Options, r *Report) {
	if a, ok := r.Agents["claude"]; ok {
		m, _, readable := read(o.Claude, false)
		env, _ := m["env"].(map[string]any)
		base, _ := env["ANTHROPIC_BASE_URL"].(string)
		a.Gateway = gatewayState(o.Claude, base, o.GatewayAddr)
		if !readable && m == nil && exists(o.Claude) {
			a.Gateway.Detail = "the file can't be read"
		}
		r.Agents["claude"] = a
	}
	if a, ok := r.Agents["codex"]; ok && o.CodexManaged != "" {
		a.Gateway = checkCodexGateway(o.CodexManaged, o.GatewayAddr)
		r.Agents["codex"] = a
	}
}

// checkCodexGateway reads openai_base_url, the built-in OpenAI provider's
// base URL, from Codex's managed defaults.
func checkCodexGateway(file, addr string) *Gateway {
	m, _, readable := read(file, true)
	base, _ := m["openai_base_url"].(string)
	g := gatewayState(file, base, addr)
	if !readable && exists(file) {
		g.Detail = "the file can't be read or isn't valid TOML"
	}
	if p, _ := m["model_provider"].(string); p != "" && p != "openai" && g.State == GatewayOn {
		g.State, g.Detail = GatewayElsewhere, "model_provider = "+strconv.Quote(p)+": openai_base_url doesn't apply to it"
	}
	return g
}
