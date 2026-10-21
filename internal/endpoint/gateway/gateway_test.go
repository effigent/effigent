package gateway

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

// recorder collects the gateway's events.
type recorder struct {
	mu  sync.Mutex
	evs []event.Event
}

func (r *recorder) emit(e event.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evs = append(r.evs, e)
}

func (r *recorder) all() []event.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]event.Event(nil), r.evs...)
}

// waitFor waits until n events are recorded (the gateway emits after the
// response body is done, which can be just after the client has read it).
func (r *recorder) waitFor(t *testing.T, n int) []event.Event {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if evs := r.all(); len(evs) >= n {
			return evs
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("want %d events, got %+v", n, r.all())
	return nil
}

type fixture struct {
	gw       *httptest.Server
	upstream *httptest.Server
	rec      *recorder
	rule     policy.Rule
}

// setup starts a fake provider (every provider routes to it) and the gateway.
func setup(t *testing.T, rule policy.Rule, upstream http.HandlerFunc) *fixture {
	t.Helper()
	f := &fixture{rec: &recorder{}, rule: rule}
	f.upstream = httptest.NewServer(upstream)
	t.Cleanup(f.upstream.Close)
	ups := map[string]string{}
	for name := range Providers {
		ups[name] = f.upstream.URL
	}
	ups["chatgpt"] = f.upstream.URL + "/backend-api/codex"
	g, err := New(Config{
		Rule: func(string) policy.Rule { return f.rule }, Emit: f.rec.emit, Upstreams: ups,
		Session: func(agent, s string) (Identity, bool) {
			return Identity{OSUser: "dana", GitEmail: "dana@acme.test"}, agent == "claude-code" && s == "sess-1"
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.gw = httptest.NewServer(g)
	t.Cleanup(f.gw.Close)
	return f
}

func post(t *testing.T, url, body string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func sse(w http.ResponseWriter, events ...string) {
	for _, e := range events {
		_, _ = io.WriteString(w, e+"\n\n")
	}
	w.(http.Flusher).Flush()
}

// The response streams through as it arrives: the agent reads the first
// event while the provider is still holding back the rest. Usage comes from
// message_start + message_delta, credentials pass through, and nothing
// secret ends up in the event.
func TestAnthropicStreamIsUnbuffered(t *testing.T) {
	release := make(chan struct{})
	var gotHdr http.Header
	var gotPath string
	f := setup(t, policy.Rule{Mode: policy.Denylist, Models: policy.ModelRule{Allow: []string{"claude-haiku-*"}}},
		func(w http.ResponseWriter, r *http.Request) {
			gotHdr, gotPath = r.Header.Clone(), r.URL.Path
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("request-id", "req_011")
			sse(w, `event: message_start`+"\n"+`data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-haiku-4-5-20251001","stop_reason":null,"usage":{"input_tokens":25,"cache_creation_input_tokens":100,"cache_read_input_tokens":2000,"output_tokens":1}}}`)
			select {
			case <-release:
			case <-time.After(5 * time.Second):
				t.Error("the gateway held the first event back")
				return
			}
			sse(w,
				`event: content_block_delta`+"\n"+`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
				`event: message_delta`+"\n"+`data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}`,
				`event: message_stop`+"\n"+`data: {"type":"message_stop"}`)
		})
	resp := post(t, f.gw.URL+"/anthropic/claude-code/v1/messages?beta=true",
		`{"model":"claude-haiku-4-5","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}`,
		map[string]string{"x-api-key": "sk-ant-secret-key", "Authorization": "Bearer sk-ant-oat-secret", "anthropic-version": "2023-06-01",
			"anthropic-beta": "oauth-2025-04-20", "X-Claude-Code-Session-Id": "sess-1", "Accept-Encoding": "br"})
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("status %d %v", resp.StatusCode, resp.Header)
	}
	br := bufio.NewReader(resp.Body)
	first, _ := br.ReadString('\n')
	if !strings.Contains(first, "message_start") {
		t.Fatalf("first line %q", first)
	}
	close(release) // only now may the provider send the rest
	rest, _ := io.ReadAll(br)
	if !strings.Contains(string(rest), `"text":"Hello"`) || !strings.Contains(string(rest), "message_stop") {
		t.Fatalf("rest of the stream: %q", rest)
	}
	if gotPath != "/v1/messages" || gotHdr.Get("X-Api-Key") != "sk-ant-secret-key" || gotHdr.Get("Authorization") != "Bearer sk-ant-oat-secret" ||
		gotHdr.Get("Anthropic-Beta") != "oauth-2025-04-20" || gotHdr.Get("Accept-Encoding") == "br" {
		t.Errorf("upstream got %s %v", gotPath, gotHdr)
	}
	evs := f.rec.waitFor(t, 1)
	e := evs[0]
	mc := e.ModelCall
	if e.Type != ModelCall || e.Agent != "claude-code" || e.SessionID != "sess-1" || e.OSUser != "dana" || e.GitEmail != "dana@acme.test" ||
		e.Model != "claude-haiku-4-5-20251001" || mc == nil || mc.RequestedModel != "claude-haiku-4-5" || !mc.Stream || mc.Status != 200 ||
		mc.InputTokens != 25 || mc.OutputTokens != 15 || mc.CacheReadTokens != 2000 || mc.CacheWriteTokens != 100 ||
		mc.StopReason != "end_turn" || mc.RequestID != "req_011" || e.Target != strings.TrimPrefix(f.upstream.URL, "http://")+"/v1/messages" {
		t.Errorf("event %+v %+v", e, mc)
	}
	b, _ := json.Marshal(evs)
	for _, secret := range []string{"sk-ant-secret-key", "sk-ant-oat-secret", "beta=true", `"hi"`} {
		if strings.Contains(string(b), secret) {
			t.Errorf("event carries %q: %s", secret, b)
		}
	}
}

// A refused model never reaches the provider; the agent gets the provider's
// own error shape, with the reason.
func TestDeniedModelIsRefusedInTheProvidersFormat(t *testing.T) {
	called := false
	f := setup(t, policy.Rule{Mode: policy.Denylist, Models: policy.ModelRule{Deny: []string{"*opus*"}}},
		func(w http.ResponseWriter, r *http.Request) { called = true })
	for _, c := range []struct{ path, body, want string }{
		{"/anthropic/claude-code/v1/messages", `{"model":"claude-opus-4-1","max_tokens":10,"stream":true}`, `"type":"permission_error"`},
		{"/openai/codex/v1/responses", `{"model":"o3-opus","stream":true}`, `"code":"permission_error"`},
		{"/gemini/gemini-cli/v1beta/models/gemini-opus:streamGenerateContent?alt=sse", `{}`, `"status":"PERMISSION_DENIED"`},
	} {
		resp := post(t, f.gw.URL+c.path, c.body, nil)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(b), c.want) || !strings.Contains(string(b), "Blocked by Effigent") ||
			!strings.Contains(string(b), "models.deny *opus*") {
			t.Errorf("%s: %d %s", c.path, resp.StatusCode, b)
		}
	}
	if called {
		t.Error("a refused request reached the provider")
	}
	evs := f.rec.waitFor(t, 3)
	for _, e := range evs {
		if e.Type != event.Blocked || e.Severity != "high" || e.Rule != "models" || e.ModelCall.Status != 403 {
			t.Errorf("event %+v", e)
		}
	}
	if evs[2].Model != "gemini-opus" {
		t.Errorf("gemini model from the path: %q", evs[2].Model)
	}
}

// Monitor mode reports the refusal and lets the call through.
func TestMonitorModeForwardsAndReports(t *testing.T) {
	f := setup(t, policy.Rule{Mode: policy.Monitor, Models: policy.ModelRule{Allow: []string{"claude-haiku-*"}, MaxTokens: 100}},
		func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(b), `"max_tokens":32000`) {
				t.Errorf("monitor mode changed the request: %s", b)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[{"type":"text","text":"Hi"}],"stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":3}}`)
		})
	resp := post(t, f.gw.URL+"/anthropic/claude-code/v1/messages", `{"model":"claude-sonnet-4-5","max_tokens":32000}`, nil)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	evs := f.rec.waitFor(t, 2)
	if evs[0].Type != event.WouldBlock || !strings.Contains(evs[0].Message, "not in models.allow") {
		t.Errorf("first %+v", evs[0])
	}
	if e := evs[1]; e.Type != ModelCall || e.ModelCall.InputTokens != 12 || e.ModelCall.OutputTokens != 3 || e.ModelCall.Stream || e.Mode != "monitor" ||
		e.ModelCall.Rewritten != "" {
		t.Errorf("model_call %+v %+v", e, e.ModelCall)
	}
}

// models.max_tokens lowers the request's limit (and a thinking budget above
// it) instead of refusing, so the agent keeps working.
func TestMaxTokensIsLowered(t *testing.T) {
	var got map[string]any
	f := setup(t, policy.Rule{Mode: policy.Denylist, Models: policy.ModelRule{MaxTokens: 4096}},
		func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&got)
			_, _ = io.WriteString(w, `{}`)
		})
	resp := post(t, f.gw.URL+"/anthropic/claude-code/v1/messages",
		`{"model":"claude-sonnet-4-5","max_tokens":32000,"thinking":{"type":"enabled","budget_tokens":10000},"system":"a <b> & c"}`, nil)
	resp.Body.Close()
	th, _ := got["thinking"].(map[string]any)
	if got["max_tokens"] != 4096.0 || th["budget_tokens"] != 4095.0 || got["system"] != "a <b> & c" {
		t.Errorf("upstream got %v", got)
	}
	evs := f.rec.waitFor(t, 1)
	if !strings.Contains(evs[0].ModelCall.Rewritten, "lowered from 32000 to 4096") {
		t.Errorf("rewritten = %q", evs[0].ModelCall.Rewritten)
	}
	// under the cap: forwarded byte for byte
	var raw []byte
	f.upstream.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { raw, _ = io.ReadAll(r.Body) })
	body := `{"model":"claude-sonnet-4-5",  "max_tokens":1000}`
	post(t, f.gw.URL+"/anthropic/claude-code/v1/messages", body, nil).Body.Close()
	if string(raw) != body {
		t.Errorf("a request under the cap was changed: %s", raw)
	}
}

// Chat Completions streams report usage only when asked: the gateway asks.
func TestOpenAIChatStreamUsage(t *testing.T) {
	f := setup(t, policy.Rule{Mode: policy.Denylist}, func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			StreamOptions struct {
				IncludeUsage bool `json:"include_usage"`
			} `json:"stream_options"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		if !b.StreamOptions.IncludeUsage {
			t.Error("include_usage was not added")
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("x-request-id", "req_abc")
		sse(w,
			`data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini-2024-07-18","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}],"usage":null}`,
			`data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini-2024-07-18","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}`,
			`data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini-2024-07-18","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":7,"total_tokens":1207,"prompt_tokens_details":{"cached_tokens":1024},"completion_tokens_details":{"reasoning_tokens":0}}}`,
			`data: [DONE]`)
	})
	resp := post(t, f.gw.URL+"/openai/aider/v1/chat/completions", `{"model":"gpt-4o-mini","stream":true,"messages":[]}`, nil)
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	e := f.rec.waitFor(t, 1)[0]
	if mc := e.ModelCall; mc.InputTokens != 176 || mc.CacheReadTokens != 1024 || mc.OutputTokens != 7 || mc.StopReason != "stop" ||
		e.Model != "gpt-4o-mini-2024-07-18" || mc.RequestID != "req_abc" || mc.Rewritten != "stream_options.include_usage added" || e.Agent != "aider" {
		t.Errorf("%+v %+v", e, mc)
	}
}

// Codex signed in with ChatGPT: the Responses API under /backend-api/codex.
func TestResponsesStreamUsage(t *testing.T) {
	var path, sessionHdr string
	f := setup(t, policy.Rule{Mode: policy.Denylist, Models: policy.ModelRule{Allow: []string{"gpt-5*"}}}, func(w http.ResponseWriter, r *http.Request) {
		path, sessionHdr = r.URL.Path, r.Header.Get("session_id")
		w.Header().Set("Content-Type", "text/event-stream")
		sse(w,
			"event: response.created\n"+`data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress","model":"gpt-5-codex","usage":null}}`,
			"event: response.output_text.delta\n"+`data: {"type":"response.output_text.delta","delta":"ok"}`,
			"event: response.completed\n"+`data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5-codex","usage":{"input_tokens":5000,"input_tokens_details":{"cached_tokens":4096},"output_tokens":300,"output_tokens_details":{"reasoning_tokens":256},"total_tokens":5300}}}`)
	})
	resp := post(t, f.gw.URL+"/chatgpt/codex/responses", `{"model":"gpt-5-codex","stream":true,"input":[]}`, map[string]string{"session_id": "019a-codex"})
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	e := f.rec.waitFor(t, 1)[0]
	if mc := e.ModelCall; path != "/backend-api/codex/responses" || sessionHdr != "019a-codex" || e.SessionID != "019a-codex" ||
		mc.InputTokens != 904 || mc.CacheReadTokens != 4096 || mc.OutputTokens != 300 || mc.ReasoningTokens != 256 || mc.StopReason != "completed" ||
		mc.Provider != "chatgpt" {
		t.Errorf("%s %+v %+v", path, e, mc)
	}
}

func TestGeminiStreamUsage(t *testing.T) {
	var query string
	f := setup(t, policy.Rule{Mode: policy.Denylist}, func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		sse(w,
			`data: {"candidates":[{"content":{"parts":[{"text":"Hel"}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":9,"totalTokenCount":9},"modelVersion":"gemini-2.5-flash"}`,
			`data: {"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2,"thoughtsTokenCount":20,"totalTokenCount":31},"modelVersion":"gemini-2.5-flash"}`)
	})
	resp := post(t, f.gw.URL+"/gemini/gemini-cli/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=AIzaSECRET", `{"contents":[]}`, nil)
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	e := f.rec.waitFor(t, 1)[0]
	if mc := e.ModelCall; query != "alt=sse&key=AIzaSECRET" || e.Model != "gemini-2.5-flash" || mc.InputTokens != 9 || mc.OutputTokens != 22 ||
		mc.ReasoningTokens != 20 || mc.StopReason != "STOP" || strings.Contains(e.Target, "AIza") {
		t.Errorf("%s %+v %+v", query, e, mc)
	}
}

func TestRefusesWhatIsNotALocalAgent(t *testing.T) {
	f := setup(t, policy.Rule{}, func(w http.ResponseWriter, r *http.Request) { t.Errorf("forwarded %s", r.URL) })
	for _, c := range []struct {
		path string
		hdr  map[string]string
		want int
	}{
		{"/anthropic/claude-code/v1/messages", map[string]string{"Origin": "https://evil.example"}, 403},
		{"/anthropic/claude-code/v1/messages", map[string]string{"Host": "rebind.evil.example"}, 403},
		{"/elsewhere/claude-code/v1/messages", nil, 404},
		{"/anthropic/Not_An_Agent/v1/messages", nil, 400},
		{"/v1/messages", nil, 404},
	} {
		req, _ := http.NewRequest(http.MethodPost, f.gw.URL+c.path, strings.NewReader(`{}`))
		for k, v := range c.hdr {
			req.Header.Set(k, v)
			if k == "Host" {
				req.Host = v
			}
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != c.want {
			t.Errorf("%s %v: %d, want %d", c.path, c.hdr, resp.StatusCode, c.want)
		}
	}
}

// A path can't climb out of the provider's base, and requests that aren't
// model calls are forwarded without an event.
func TestPathsStayUnderTheProvider(t *testing.T) {
	var paths []string
	f := setup(t, policy.Rule{}, func(w http.ResponseWriter, r *http.Request) { paths = append(paths, r.URL.Path) })
	for _, p := range []string{"/chatgpt/codex/../../../etc/passwd", "/chatgpt/codex/%2e%2e/%2e%2e/x", "/anthropic/claude-code/v1/models"} {
		req, _ := http.NewRequest(http.MethodGet, f.gw.URL+p, nil)
		req.URL.Opaque = p // send it as written
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	for _, p := range paths {
		if strings.Contains(p, "..") || (!strings.HasPrefix(p, "/backend-api/codex/") && p != "/v1/models") {
			t.Errorf("upstream path %q", p)
		}
	}
	time.Sleep(20 * time.Millisecond)
	if evs := f.rec.all(); len(evs) != 0 {
		t.Errorf("events for non-model requests: %+v", evs)
	}
}

func TestUpstreamDown(t *testing.T) {
	f := setup(t, policy.Rule{Mode: policy.Denylist}, func(w http.ResponseWriter, r *http.Request) {})
	f.upstream.Close()
	resp := post(t, f.gw.URL+"/anthropic/claude-code/v1/messages", `{"model":"claude-haiku-4-5","max_tokens":5}`, nil)
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || !strings.Contains(string(b), `"type":"api_error"`) {
		t.Errorf("%d %s", resp.StatusCode, b)
	}
	e := f.rec.waitFor(t, 1)[0]
	if e.ModelCall.Status != 502 || e.ModelCall.Error != "upstream_unreachable" || e.Severity != "medium" {
		t.Errorf("%+v %+v", e, e.ModelCall)
	}
}
