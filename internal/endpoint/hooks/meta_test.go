package hooks

import "testing"

func TestMeta(t *testing.T) {
	cases := map[string]SessionMeta{
		`{"session_id":"abc-123","cwd":"/w","transcript_path":"/h/.claude/projects/x/abc-123.jsonl","tool_name":"Bash","tool_input":{}}`: {SessionID: "abc-123", Cwd: "/w", TranscriptPath: "/h/.claude/projects/x/abc-123.jsonl"},
		`{"session_id":"s","model":"gpt-5.3-codex","tool_name":"Bash"}`:                                                                  {SessionID: "s", Model: "gpt-5.3-codex"},
		`{"session_id":"s","model":{"id":"claude-opus-5-5","display_name":"Opus"}}`:                                                      {SessionID: "s", Model: "claude-opus-5-5"},
		`{"session_id":"s","model":42}`: {SessionID: "s"},
		`not json`:                      {},
	}
	for in, want := range cases {
		if got := Meta([]byte(in)); got != want {
			t.Errorf("Meta(%s) = %+v, want %+v", in, got, want)
		}
	}
}
