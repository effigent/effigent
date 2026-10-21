package gateway

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Fixtures in testdata/ are the providers' documented examples (sources in
// testdata/README); the stream is fed in small pieces, as it arrives.
func meterFile(t *testing.T, w wire, stream bool, file string, chunk int) Usage {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		t.Fatal(err)
	}
	m := newMeter(w, stream)
	for len(b) > 0 {
		n := min(chunk, len(b))
		_, _ = m.Write(b[:n])
		b = b[n:]
	}
	return m.Usage()
}

func TestUsageFixtures(t *testing.T) {
	for _, c := range []struct {
		file   string
		wire   wire
		stream bool
		want   Usage
	}{
		// message_delta's usage is cumulative and replaces message_start's
		{"anthropic_stream.sse", wireAnthropic, true, Usage{Model: "claude-opus-5-5", InputTokens: 25, OutputTokens: 15, StopReason: "end_turn"}},
		{"anthropic_stream_tools.sse", wireAnthropic, true, Usage{Model: "claude-opus-5", InputTokens: 472, OutputTokens: 89, StopReason: "tool_use"}},
		{"anthropic_stream_websearch.sse", wireAnthropic, true, Usage{Model: "claude-opus-5-5", InputTokens: 10682, OutputTokens: 510, StopReason: "end_turn"}},
		{"anthropic_stream_error.sse", wireAnthropic, true, Usage{Model: "claude-opus-5-5", InputTokens: 25, OutputTokens: 1, Error: "overloaded_error"}},
		// input_tokens already excludes cache reads and writes
		{"anthropic_message_cache.json", wireAnthropic, false, Usage{InputTokens: 2048, OutputTokens: 503, CacheReadTokens: 1800, CacheWriteTokens: 248}},
		{"anthropic_error.json", wireAnthropic, false, Usage{Error: "not_found_error"}},
		{"openai_chat_stream.sse", wireOpenAIChat, true, Usage{Model: "gpt-6-astra", InputTokens: 19, OutputTokens: 10, StopReason: "stop"}},
		{"openai_chat.json", wireOpenAIChat, false, Usage{Model: "gpt-6-astra", InputTokens: 19, OutputTokens: 10, StopReason: "stop"}},
		{"openai_responses_stream.sse", wireOpenAIResponses, true, Usage{Model: "gpt-6-astra", StopReason: "completed"}},
		{"openai_responses.json", wireOpenAIResponses, false, Usage{Model: "gpt-6-astra", StopReason: "completed"}},
		{"openai_responses_error.sse", wireOpenAIResponses, true, Usage{Error: "ERR_SOMETHING"}},
		{"openai_error.json", wireOpenAIChat, false, Usage{Error: "invalid_request_error"}},
		// every chunk carries running totals; output = candidates + thoughts
		{"gemini_stream.sse", wireGemini, true, Usage{Model: "gemini-2.0-flash", InputTokens: 8, OutputTokens: 31, ReasoningTokens: 20, StopReason: "STOP"}},
		// promptTokenCount includes the cached content
		{"gemini_stream_array.json", wireGemini, false, Usage{Model: "gemini-2.0-flash", InputTokens: 200, CacheReadTokens: 1000, OutputTokens: 11, StopReason: "STOP"}},
		{"gemini_error.json", wireGemini, false, Usage{Error: "INVALID_ARGUMENT"}},
	} {
		for _, chunk := range []int{1, 7, 1 << 20} {
			got := meterFile(t, c.wire, c.stream, c.file, chunk)
			got.Seen = false
			if got != c.want {
				t.Errorf("%s (chunks of %d):\n got %+v\nwant %+v", c.file, chunk, got, c.want)
			}
		}
	}
}

// A stream cut off mid-way keeps what it had; a line over the limit is
// skipped without breaking the events after it.
func TestUsageCutAndHugeLines(t *testing.T) {
	m := newMeter(wireAnthropic, true)
	_, _ = m.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":7,\"output_tokens\":1}}}\n\n"))
	_, _ = m.Write([]byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"" + strings.Repeat("x", maxLine+10) + "\"}}\n\n"))
	_, _ = m.Write([]byte("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"},\"usage\":{\"output_tokens\":42}}")) // no blank line: cut
	u := m.Usage()
	if u.InputTokens != 7 || u.OutputTokens != 42 || u.StopReason != "max_tokens" || !u.Seen {
		t.Errorf("%+v", u)
	}
	j := newMeter(wireAnthropic, false)
	_, _ = j.Write([]byte(strings.Repeat(" ", maxJSON+1)))
	if u := j.Usage(); u.Seen {
		t.Errorf("an oversized body was read: %+v", u)
	}
}
