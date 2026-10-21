// Package gateway is effigentd's local model gateway: a plain HTTP listener
// on loopback that agents are pointed at through their base URL (Claude Code
// ANTHROPIC_BASE_URL, Codex's model provider, …). It is not TLS
// interception: the agent talks to it knowingly, and it forwards each
// request over TLS to a fixed provider host, chosen by the first path
// segment, never by the request.
//
// For each model call it checks the model (and the output-token cap)
// against the policy's models section, streams the response through as it
// arrives, and records one model_call event: agent, session, model, token
// counts from the response's usage, latency, status. Prompts, completions
// and credentials are never read into events or logs; the agent's own
// Authorization / x-api-key headers pass through untouched and are never
// stored.
package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

// DefaultAddr is where the gateway listens unless -gateway says otherwise.
const DefaultAddr = "127.0.0.1:7779"

// ModelCall is the event type of one request through the gateway.
const ModelCall event.Type = "model_call"

// Providers are the upstreams, by the first path segment of the gateway URL:
// http://127.0.0.1:7779/<provider>/<agent>/<the provider's own path>.
var Providers = map[string]string{
	"anthropic": "https://api.anthropic.com",
	"openai":    "https://api.openai.com",
	"chatgpt":   "https://chatgpt.com/backend-api/codex", // Codex signed in with ChatGPT
	"gemini":    "https://generativelanguage.googleapis.com",
}

// Identity is who is behind a session, as the agent's hook calls said.
type Identity struct{ OSUser, GitEmail string }

// Config wires the gateway to the daemon.
type Config struct {
	Rule func(agent string) policy.Rule // the agent's effective rule (mode + models)
	Emit func(event.Event)
	// Session returns what the agent's hooks reported for a session (nil: unknown).
	Session func(agent, session string) (Identity, bool)
	// Seen is told about every model call's session, so hooks can tell that
	// a session's model traffic goes through the gateway.
	Seen func(agent, session string)
	// Peer names the OS user behind a loopback connection, where the
	// platform can tell (Linux: /proc/net/tcp); nil or "" when it can't.
	Peer func(remoteAddr string) string
	Logf func(string, ...any)
	// Upstreams replaces Providers (tests); Transport the upstream client.
	Upstreams map[string]string
	Transport http.RoundTripper
}

// Gateway is an http.Handler.
type Gateway struct {
	cfg       Config
	upstreams map[string]*url.URL
	rt        http.RoundTripper
}

// New builds a gateway.
func New(cfg Config) (*Gateway, error) {
	ups := cfg.Upstreams
	if ups == nil {
		ups = Providers
	}
	g := &Gateway{cfg: cfg, upstreams: map[string]*url.URL{}, rt: cfg.Transport}
	for name, raw := range ups {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return nil, fmt.Errorf("gateway upstream %s: %q is not a URL", name, raw)
		}
		g.upstreams[name] = u
	}
	if g.rt == nil {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.Proxy = http.ProxyFromEnvironment // corporate egress proxies
		t.MaxIdleConnsPerHost = 16
		t.ResponseHeaderTimeout = 0 // a non-streamed answer can take minutes
		g.rt = t
	}
	if g.cfg.Logf == nil {
		g.cfg.Logf = func(string, ...any) {}
	}
	return g, nil
}

// maxRequest bounds a request body (Anthropic's own limit is 32 MB).
const maxRequest = 64 << 20

var agentRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$`)

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	// Only local programs, never a web page: a browser sends Origin, and a
	// DNS-rebound name arrives with a Host that isn't loopback.
	if r.Header.Get("Origin") != "" || !loopbackHost(r.Host) {
		http.Error(w, "the Effigent model gateway only serves local agents", http.StatusForbidden)
		return
	}
	prov, agent, rest, ok := splitPath(r.URL.EscapedPath())
	up := g.upstreams[prov]
	if !ok || up == nil {
		http.Error(w, "Effigent model gateway: use http://"+r.Host+"/<anthropic|openai|chatgpt|gemini>/<agent>/… as the base URL", http.StatusNotFound)
		return
	}
	if !agentRE.MatchString(agent) {
		writeError(w, prov, http.StatusBadRequest, "invalid_request_error", "Effigent model gateway: "+strconv.Quote(agent)+" is not an agent name")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequest+1))
	if err != nil {
		writeError(w, prov, http.StatusBadRequest, "invalid_request_error", "Effigent model gateway: could not read the request")
		return
	}
	if len(body) > maxRequest {
		writeError(w, prov, http.StatusRequestEntityTooLarge, "request_too_large", "Effigent model gateway: the request is larger than 64 MB")
		return
	}
	c := classify(prov, r.Method, rest, body)
	session := sessionOf(r.Header)
	ev := event.Event{Time: start, Type: ModelCall, Severity: "info", Agent: agent, Kind: "model", Rule: "gateway",
		Target: up.Host + strings.TrimSuffix(up.Path, "/") + cleanPath(rest), SessionID: session, Model: c.model}
	if g.cfg.Session != nil && session != "" {
		if id, ok := g.cfg.Session(agent, session); ok {
			ev.OSUser, ev.GitEmail = id.OSUser, id.GitEmail
		}
	}
	if ev.OSUser == "" && g.cfg.Peer != nil {
		ev.OSUser = g.cfg.Peer(r.RemoteAddr)
	}
	mc := &event.ModelCall{Provider: prov, RequestedModel: c.model}
	ev.ModelCall = mc
	if c.metered {
		if g.cfg.Seen != nil && session != "" {
			g.cfg.Seen(agent, session)
		}
		rule := policy.Rule{Mode: policy.Monitor}
		if g.cfg.Rule != nil {
			rule = g.cfg.Rule(agent)
		}
		ev.Mode = string(rule.Mode)
		enforce := rule.Mode == policy.Denylist || rule.Mode == policy.Allowlist
		if why := refuse(rule.Models, c); why != "" {
			ev.Rule, ev.Message = "models", why
			if enforce {
				ev.Type, ev.Severity = event.Blocked, "high"
				// 400, not 403: agents read 401/403 as a login problem
				// (Claude Code: "Failed to authenticate"), and don't retry a 400.
				mc.Status = http.StatusBadRequest
				g.cfg.Emit(ev)
				writeError(w, prov, http.StatusBadRequest, "invalid_request_error", "Blocked by Effigent: "+why+
					". Choose an allowed model (Claude Code: /model) or ask your IT team.")
				return
			}
			// monitor / learn: report and let it through
			wb, snap := ev, *mc
			wb.Type, wb.Severity, wb.Time, wb.ModelCall = event.WouldBlock, "medium", time.Now(), &snap
			g.cfg.Emit(wb)
			ev.Rule, ev.Message = "gateway", ""
		}
		limit := 0
		if enforce { // monitor / learn change nothing
			limit = rule.Models.MaxTokens
		}
		body, mc.Rewritten = rewrite(c, body, limit)
	}

	out, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL(up, rest, r.URL.RawQuery), bytes.NewReader(body))
	if err != nil {
		writeError(w, prov, http.StatusBadRequest, "invalid_request_error", "Effigent model gateway: bad request path")
		return
	}
	copyHeaders(out.Header, r.Header)
	out.ContentLength = int64(len(body))
	resp, err := g.rt.RoundTrip(out)
	if err != nil {
		if !c.metered {
			writeError(w, prov, http.StatusBadGateway, "api_error", "Effigent model gateway: "+up.Host+" is unreachable")
			return
		}
		mc.Status, mc.LatencyMS = http.StatusBadGateway, time.Since(start).Milliseconds()
		if r.Context().Err() != nil {
			mc.Status, mc.ModelUsage.Error = 499, "client_closed"
		} else {
			mc.ModelUsage.Error = "upstream_unreachable"
			writeError(w, prov, http.StatusBadGateway, "api_error", "Effigent model gateway: "+up.Host+" is unreachable ("+netErr(err)+")")
		}
		ev.Severity, ev.Message = "medium", up.Host+" unreachable"
		g.cfg.Emit(ev)
		return
	}
	defer resp.Body.Close()
	mc.Status = resp.StatusCode
	mc.FirstByteMS = time.Since(start).Milliseconds()
	mc.RequestID = first(resp.Header.Get("request-id"), resp.Header.Get("x-request-id"))
	stream := strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream")
	mc.Stream = stream
	for k, vs := range resp.Header {
		if !hopByHop(k) {
			w.Header()[k] = vs
		}
	}
	w.WriteHeader(resp.StatusCode)
	var m meter
	if c.metered {
		m = newMeter(c.wire, stream)
	}
	copyErr := pipe(w, resp.Body, m)
	if !c.metered {
		return
	}
	mc.LatencyMS = time.Since(start).Milliseconds()
	u := m.Usage()
	mc.ModelUsage = u
	if u.Model != "" {
		ev.Model = u.Model
	}
	if copyErr != nil && u.Error == "" {
		mc.ModelUsage.Error = "stream_cut"
		if r.Context().Err() != nil {
			mc.ModelUsage.Error = "client_closed"
		}
	}
	if resp.StatusCode >= 500 || mc.ModelUsage.Error != "" && resp.StatusCode < 400 {
		ev.Severity = "medium"
	}
	ev.Message = summary(ev.Model, mc)
	g.cfg.Emit(ev)
}

// pipe copies the response as it arrives, flushing every read, and lets the
// meter see each chunk.
func pipe(w http.ResponseWriter, body io.Reader, m meter) error {
	rc := http.NewResponseController(w)
	buf := make([]byte, 32<<10)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return werr
			}
			_ = rc.Flush()
			if m != nil {
				_, _ = m.Write(buf[:n])
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// call is what the gateway needs to know about a request.
type call struct {
	metered   bool // a model call: checked, measured, recorded
	wire      wire
	model     string
	maxTokens int64 // the output tokens the request asks for (0: none named)
}

// classify reads the model and output-token limit of a model call; other
// requests (model lists, token counting…) are forwarded as they are.
func classify(prov, method, path string, body []byte) call {
	if method != http.MethodPost {
		return call{}
	}
	path = strings.TrimSuffix(path, "/")
	var c call
	switch prov {
	case "anthropic":
		if path != "/v1/messages" {
			return call{}
		}
		c.wire = wireAnthropic
	case "openai", "chatgpt":
		switch {
		case strings.HasSuffix(path, "/chat/completions"):
			c.wire = wireOpenAIChat
		case strings.HasSuffix(path, "/responses"):
			c.wire = wireOpenAIResponses
		default:
			return call{}
		}
	case "gemini":
		// /v1beta/models/{model}:generateContent | :streamGenerateContent
		i := strings.Index(path, "/models/")
		if i < 0 {
			return call{}
		}
		model, verb, ok := strings.Cut(path[i+len("/models/"):], ":")
		if !ok || (verb != "generateContent" && verb != "streamGenerateContent") {
			return call{}
		}
		if m, err := url.PathUnescape(model); err == nil {
			model = m
		}
		c.metered, c.wire, c.model = true, wireGemini, model
		var b struct {
			GenerationConfig struct {
				MaxOutputTokens int64 `json:"maxOutputTokens"`
			} `json:"generationConfig"`
		}
		_ = json.Unmarshal(body, &b)
		c.maxTokens = b.GenerationConfig.MaxOutputTokens
		return c
	default:
		return call{}
	}
	var b struct {
		Model               string `json:"model"`
		MaxTokens           int64  `json:"max_tokens"`
		MaxCompletionTokens int64  `json:"max_completion_tokens"`
		MaxOutputTokens     int64  `json:"max_output_tokens"`
	}
	_ = json.Unmarshal(body, &b)
	c.metered, c.model = true, b.Model
	c.maxTokens = max(b.MaxTokens, b.MaxCompletionTokens, b.MaxOutputTokens)
	return c
}

// refuse says why the policy refuses a call ("" lets it through).
func refuse(r policy.ModelRule, c call) string {
	if r.Empty() {
		return ""
	}
	if c.model == "" && (len(r.Allow) > 0 || len(r.Deny) > 0) {
		return "the request names no model"
	}
	if ok, why := r.Allows(c.model); !ok {
		return "model " + c.model + " is not allowed (" + why + ")"
	}
	return ""
}

// rewrite is the only change the gateway makes to a request body, and only
// when it must: an output-token limit above models.max_tokens is lowered to
// it (with Anthropic's thinking budget below it), and a streamed Chat
// Completions request is asked to report usage (stream_options.include_usage),
// without which its tokens can't be counted. Everything else is forwarded
// byte for byte. note says what changed ("" when nothing did).
func rewrite(c call, body []byte, maxTokens int) (out []byte, note string) {
	capped := maxTokens > 0 && c.maxTokens > int64(maxTokens)
	if !capped && c.wire != wireOpenAIChat {
		return body, ""
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(body, &m) != nil {
		return body, ""
	}
	var notes []string
	lim := json.RawMessage(strconv.Itoa(maxTokens))
	lower := func(obj map[string]json.RawMessage, keys ...string) {
		for _, k := range keys {
			var n int64
			if v, ok := obj[k]; ok && json.Unmarshal(v, &n) == nil && n > int64(maxTokens) {
				obj[k] = lim
			}
		}
	}
	if capped {
		notes = append(notes, fmt.Sprintf("output tokens lowered from %d to %d (models.max_tokens)", c.maxTokens, maxTokens))
		switch c.wire {
		case wireAnthropic:
			lower(m, "max_tokens")
			var th map[string]json.RawMessage
			if json.Unmarshal(m["thinking"], &th) == nil && th != nil {
				var budget int64
				if json.Unmarshal(th["budget_tokens"], &budget) == nil && budget >= int64(maxTokens) {
					th["budget_tokens"] = json.RawMessage(strconv.Itoa(max(maxTokens-1, 1)))
					m["thinking"], _ = json.Marshal(th)
				}
			}
		case wireOpenAIChat:
			lower(m, "max_tokens", "max_completion_tokens")
		case wireOpenAIResponses:
			lower(m, "max_output_tokens")
		case wireGemini:
			var gc map[string]json.RawMessage
			if json.Unmarshal(m["generationConfig"], &gc) == nil && gc != nil {
				lower(gc, "maxOutputTokens")
				m["generationConfig"], _ = json.Marshal(gc)
			}
		}
	}
	if c.wire == wireOpenAIChat && string(m["stream"]) == "true" {
		var so map[string]json.RawMessage
		_ = json.Unmarshal(m["stream_options"], &so)
		if _, set := so["include_usage"]; !set {
			if so == nil {
				so = map[string]json.RawMessage{}
			}
			so["include_usage"] = json.RawMessage("true")
			m["stream_options"], _ = json.Marshal(so)
			notes = append(notes, "stream_options.include_usage added")
		}
	}
	if len(notes) == 0 {
		return body, ""
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // keep the agent's text as it wrote it
	if enc.Encode(m) != nil {
		return body, ""
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), strings.Join(notes, "; ")
}

// writeError answers in the provider's own error format, so the agent shows
// the message as it shows the provider's errors.
func writeError(w http.ResponseWriter, prov string, status int, typ, msg string) {
	var body any
	switch prov {
	case "anthropic":
		body = map[string]any{"type": "error", "error": map[string]any{"type": typ, "message": msg}}
	case "gemini":
		body = map[string]any{"error": map[string]any{"code": status, "message": msg, "status": geminiStatus(status)}}
	default: // OpenAI
		body = map[string]any{"error": map[string]any{"message": msg, "type": typ, "param": nil, "code": typ}}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Effigent-Gateway", "refused")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func geminiStatus(status int) string {
	switch status {
	case http.StatusForbidden:
		return "PERMISSION_DENIED"
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge:
		return "INVALID_ARGUMENT"
	case http.StatusNotFound:
		return "NOT_FOUND"
	}
	return "UNAVAILABLE"
}

// splitPath: /<provider>/<agent>/<rest>.
func splitPath(p string) (prov, agent, rest string, ok bool) {
	parts := strings.SplitN(strings.TrimPrefix(p, "/"), "/", 3)
	if len(parts) < 3 || parts[0] == "" || parts[1] == "" {
		return "", "", "", false
	}
	return parts[0], parts[1], "/" + parts[2], true
}

// upstreamURL joins the provider's base and the request's path. rest is
// still escaped; a path that climbs (..) is cleaned so it stays under the
// provider's base.
func upstreamURL(up *url.URL, rest, query string) string {
	u := *up
	u.RawPath = strings.TrimSuffix(up.EscapedPath(), "/") + cleanPath(rest)
	u.Path, _ = url.PathUnescape(u.RawPath)
	u.RawQuery = query
	return u.String()
}

func cleanPath(p string) string {
	var out []string
	for _, s := range strings.Split(p, "/") {
		dot := s
		if u, err := url.PathUnescape(s); err == nil {
			dot = u // %2e%2e is .. too
		}
		switch dot {
		case "", ".":
		case "..":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
		default:
			out = append(out, s)
		}
	}
	return "/" + strings.Join(out, "/")
}

// sessionHeaders identify an agent's session: Claude Code sends
// X-Claude-Code-Session-Id, Codex session_id.
var sessionHeaders = []string{"X-Claude-Code-Session-Id", "Session_id", "Session-Id", "X-Session-Id"}

func sessionOf(h http.Header) string {
	for _, k := range sessionHeaders {
		if v := h.Get(k); v != "" {
			return cut(v, 200)
		}
	}
	if vs := h.Values("session_id"); len(vs) > 0 { // not canonicalised by every client
		return cut(vs[0], 200)
	}
	for k, vs := range h {
		if strings.EqualFold(k, "session_id") && len(vs) > 0 {
			return cut(vs[0], 200)
		}
	}
	return ""
}

func cut(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

var hopHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true, "Te": true,
	"Trailer": true, "Transfer-Encoding": true, "Upgrade": true, "Proxy-Connection": true,
}

func hopByHop(k string) bool { return hopHeaders[http.CanonicalHeaderKey(k)] }

// copyHeaders forwards the agent's headers as they are (credentials
// included), minus hop-by-hop ones and Accept-Encoding: the upstream client
// negotiates compression itself and hands the gateway plain bytes to read.
func copyHeaders(dst, src http.Header) {
	drop := map[string]bool{"Host": true, "Accept-Encoding": true, "Content-Length": true}
	for _, f := range src.Values("Connection") { // headers the client marked hop-by-hop
		for _, k := range strings.Split(f, ",") {
			drop[http.CanonicalHeaderKey(strings.TrimSpace(k))] = true
		}
	}
	for k, vs := range src {
		if hopByHop(k) || drop[http.CanonicalHeaderKey(k)] {
			continue
		}
		dst[k] = vs
	}
}

func loopbackHost(hostport string) bool {
	h := hostport
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		h = host
	}
	h = strings.Trim(h, "[]")
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func netErr(err error) string {
	var op *net.OpError
	if errors.As(err, &op) {
		return op.Op + ": " + op.Err.Error()
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timed out"
	}
	s := err.Error()
	if i := strings.LastIndex(s, ": "); i >= 0 {
		s = s[i+2:]
	}
	return s
}

func summary(model string, mc *event.ModelCall) string {
	var b strings.Builder
	b.WriteString(first(model, "unknown model"))
	fmt.Fprintf(&b, " · %d", mc.Status)
	u := mc.ModelUsage
	if u.Seen {
		fmt.Fprintf(&b, " · %d in", u.InputTokens)
		if u.CacheReadTokens+u.CacheWriteTokens > 0 {
			fmt.Fprintf(&b, " (+%d cached, +%d cache write)", u.CacheReadTokens, u.CacheWriteTokens)
		}
		fmt.Fprintf(&b, " / %d out", u.OutputTokens)
	}
	if u.Error != "" {
		b.WriteString(" · " + u.Error)
	}
	fmt.Fprintf(&b, " · %.1fs", float64(mc.LatencyMS)/1000)
	return b.String()
}
