package gateway

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// Usage is what one model call consumed, read from the provider's response
// (never the prompt or the completion); see event.ModelUsage for how the
// providers' counts are normalised.
type Usage = event.ModelUsage

// meter reads a response body as it passes through (a copy of each chunk)
// and works out its Usage. It never keeps more than a bounded amount of it.
type meter interface {
	Write(p []byte) (int, error)
	Usage() Usage
}

// maxJSON bounds the copy kept of a non-streamed body (its usage is at the
// end); maxLine bounds one SSE line. Bigger ones are passed through unread.
const (
	maxJSON = 16 << 20
	maxLine = 4 << 20
)

// wire is a provider's response format.
type wire int

const (
	wireAnthropic wire = iota // Messages API (also Vertex rawPredict / streamRawPredict)
	wireOpenAIChat
	wireOpenAIResponses
	wireGemini
)

func newMeter(w wire, stream bool) meter {
	if stream {
		return &sseMeter{wire: w}
	}
	return &jsonMeter{wire: w}
}

// ---- non-streamed: one JSON document (Gemini: maybe an array of them) ----

type jsonMeter struct {
	wire wire
	buf  bytes.Buffer
	over bool
}

func (m *jsonMeter) Write(p []byte) (int, error) {
	if !m.over {
		if m.buf.Len()+len(p) > maxJSON {
			m.over = true
			m.buf = bytes.Buffer{}
		} else {
			m.buf.Write(p)
		}
	}
	return len(p), nil
}

func (m *jsonMeter) Usage() Usage {
	var u Usage
	b := bytes.TrimSpace(m.buf.Bytes())
	if m.over || len(b) == 0 {
		return u
	}
	if m.wire == wireGemini && b[0] == '[' { // streamGenerateContent without alt=sse
		var arr []json.RawMessage
		if json.Unmarshal(b, &arr) == nil {
			for _, c := range arr {
				readEvent(m.wire, "", c, &u)
			}
		}
		return u
	}
	readEvent(m.wire, "", b, &u)
	return u
}

// ---- streamed: server-sent events ----

type sseMeter struct {
	wire  wire
	line  []byte
	skip  bool // the current line is over maxLine: drop it
	event string
	data  []byte
	u     Usage
}

func (m *sseMeter) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			m.add(p)
			break
		}
		m.add(p[:i])
		m.endLine()
		p = p[i+1:]
	}
	return n, nil
}

func (m *sseMeter) add(p []byte) {
	if m.skip {
		return
	}
	if len(m.line)+len(p) > maxLine {
		m.skip, m.line = true, nil
		return
	}
	m.line = append(m.line, p...)
}

func (m *sseMeter) endLine() {
	line := bytes.TrimSuffix(m.line, []byte("\r"))
	skipped := m.skip
	m.line, m.skip = m.line[:0], false
	if skipped {
		m.data = nil // a partial data line is no use
		return
	}
	switch {
	case len(line) == 0: // end of an event
		if len(m.data) > 0 {
			readEvent(m.wire, m.event, m.data, &m.u)
		}
		m.event, m.data = "", nil
	case bytes.HasPrefix(line, []byte("event:")):
		m.event = strings.TrimSpace(string(line[6:]))
	case bytes.HasPrefix(line, []byte("data:")):
		d := bytes.TrimPrefix(line[5:], []byte(" "))
		if len(m.data) > 0 {
			m.data = append(m.data, '\n')
		}
		if len(m.data)+len(d) <= maxLine {
			m.data = append(m.data, d...)
		}
	}
}

func (m *sseMeter) Usage() Usage {
	if len(m.line) > 0 { // cut off mid-line: a complete JSON object still counts
		m.endLine()
	}
	if len(m.data) > 0 { // a stream cut off without its final blank line
		readEvent(m.wire, m.event, m.data, &m.u)
		m.data = nil
	}
	return m.u
}

// ---- provider formats ----

// anthropicUsage is the Messages API's usage object.
type anthropicUsage struct {
	InputTokens              *int64 `json:"input_tokens"`
	OutputTokens             *int64 `json:"output_tokens"`
	CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
}

// apply copies the fields present: message_delta's counts are cumulative
// and replace message_start's.
func (a *anthropicUsage) apply(u *Usage) {
	if a == nil {
		return
	}
	set := func(dst *int64, v *int64) {
		if v != nil {
			*dst = *v
			u.Seen = true
		}
	}
	set(&u.InputTokens, a.InputTokens)
	set(&u.OutputTokens, a.OutputTokens)
	set(&u.CacheWriteTokens, a.CacheCreationInputTokens)
	set(&u.CacheReadTokens, a.CacheReadInputTokens)
}

type providerError struct {
	Type    string `json:"type"`
	Code    any    `json:"code"`
	Status  string `json:"status"` // Gemini
	Message string `json:"message"`
}

func (e *providerError) name() string {
	switch {
	case e == nil:
		return ""
	case e.Type != "":
		return e.Type
	case e.Status != "":
		return e.Status
	case e.Code != nil:
		if s, ok := e.Code.(string); ok {
			return s
		}
		return "error"
	}
	return "error"
}

// openAIUsage covers Chat Completions (prompt/completion) and the Responses
// API (input/output).
type openAIUsage struct {
	PromptTokens        int64 `json:"prompt_tokens"`
	CompletionTokens    int64 `json:"completion_tokens"`
	InputTokens         int64 `json:"input_tokens"`
	OutputTokens        int64 `json:"output_tokens"`
	PromptTokensDetails *struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	InputTokensDetails *struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	CompletionTokensDetails *struct {
		ReasoningTokens int64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
	OutputTokensDetails *struct {
		ReasoningTokens int64 `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

func (o *openAIUsage) apply(u *Usage) {
	if o == nil {
		return
	}
	in, out := o.PromptTokens+o.InputTokens, o.CompletionTokens+o.OutputTokens
	var cached, reasoning int64
	if o.PromptTokensDetails != nil {
		cached += o.PromptTokensDetails.CachedTokens
	}
	if o.InputTokensDetails != nil {
		cached += o.InputTokensDetails.CachedTokens
	}
	if o.CompletionTokensDetails != nil {
		reasoning += o.CompletionTokensDetails.ReasoningTokens
	}
	if o.OutputTokensDetails != nil {
		reasoning += o.OutputTokensDetails.ReasoningTokens
	}
	u.InputTokens, u.CacheReadTokens = max(in-cached, 0), cached
	u.OutputTokens, u.ReasoningTokens = out, reasoning
	u.Seen = true
}

type geminiUsage struct {
	PromptTokenCount        int64 `json:"promptTokenCount"`
	CandidatesTokenCount    int64 `json:"candidatesTokenCount"`
	CachedContentTokenCount int64 `json:"cachedContentTokenCount"`
	ThoughtsTokenCount      int64 `json:"thoughtsTokenCount"`
}

// readEvent folds one JSON document (a whole body, or one SSE event's data)
// into u.
func readEvent(w wire, name string, data []byte, u *Usage) {
	if len(data) == 0 || data[0] != '{' { // "[DONE]", pings
		return
	}
	switch w {
	case wireAnthropic:
		var ev struct {
			Type    string `json:"type"`
			Model   string `json:"model"`
			Message *struct {
				Model      string          `json:"model"`
				Usage      *anthropicUsage `json:"usage"`
				StopReason string          `json:"stop_reason"`
			} `json:"message"`
			Usage      *anthropicUsage `json:"usage"`
			StopReason string          `json:"stop_reason"`
			Delta      *struct {
				StopReason string `json:"stop_reason"`
			} `json:"delta"`
			Error *providerError `json:"error"`
		}
		if json.Unmarshal(data, &ev) != nil {
			return
		}
		if ev.Message != nil { // message_start
			u.Model = first(ev.Message.Model, u.Model)
			ev.Message.Usage.apply(u)
		}
		u.Model = first(ev.Model, u.Model) // a non-streamed message
		ev.Usage.apply(u)                  // message_delta, or a non-streamed message
		u.StopReason = first(ev.StopReason, u.StopReason)
		if ev.Delta != nil {
			u.StopReason = first(ev.Delta.StopReason, u.StopReason)
		}
		if ev.Type == "error" || name == "error" {
			u.Error = first(ev.Error.name(), "error")
		}
	case wireOpenAIChat:
		var ev struct {
			Model   string       `json:"model"`
			Usage   *openAIUsage `json:"usage"`
			Choices []struct {
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Error *providerError `json:"error"`
		}
		if json.Unmarshal(data, &ev) != nil {
			return
		}
		u.Model = first(ev.Model, u.Model)
		ev.Usage.apply(u)
		for _, c := range ev.Choices {
			u.StopReason = first(c.FinishReason, u.StopReason)
		}
		if ev.Error != nil {
			u.Error = first(ev.Error.name(), "error")
		}
	case wireOpenAIResponses:
		type response struct {
			Model             string         `json:"model"`
			Status            string         `json:"status"`
			Usage             *openAIUsage   `json:"usage"`
			Error             *providerError `json:"error"`
			IncompleteDetails *struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
		}
		var ev struct {
			Type     string `json:"type"`
			Response *response
			response
			Code    any    `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &ev) != nil {
			return
		}
		r := &ev.response // a non-streamed response
		if ev.Response != nil {
			r = ev.Response // response.created / .completed / .failed / .incomplete
		}
		u.Model = first(r.Model, u.Model)
		r.Usage.apply(u)
		if r.Status != "" && r.Status != "in_progress" && r.Status != "queued" {
			u.StopReason = r.Status
		}
		if r.IncompleteDetails != nil && r.IncompleteDetails.Reason != "" {
			u.StopReason = "incomplete: " + r.IncompleteDetails.Reason
		}
		if r.Error != nil {
			u.Error = first(r.Error.name(), "error")
		}
		if ev.Type == "error" || name == "error" { // a stream error event
			u.Error = first((&providerError{Code: ev.Code}).name(), "error")
		}
	case wireGemini:
		var ev struct {
			ModelVersion  string       `json:"modelVersion"`
			UsageMetadata *geminiUsage `json:"usageMetadata"`
			Candidates    []struct {
				FinishReason string `json:"finishReason"`
			} `json:"candidates"`
			Error *providerError `json:"error"`
		}
		if json.Unmarshal(data, &ev) != nil {
			return
		}
		u.Model = first(ev.ModelVersion, u.Model)
		if g := ev.UsageMetadata; g != nil { // every chunk carries the running totals
			u.InputTokens = max(g.PromptTokenCount-g.CachedContentTokenCount, 0)
			u.CacheReadTokens = g.CachedContentTokenCount
			u.OutputTokens = g.CandidatesTokenCount + g.ThoughtsTokenCount
			u.ReasoningTokens = g.ThoughtsTokenCount
			u.Seen = true
		}
		for _, c := range ev.Candidates {
			u.StopReason = first(c.FinishReason, u.StopReason)
		}
		if ev.Error != nil {
			u.Error = first(ev.Error.name(), "error")
		}
	}
}

func first(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}
