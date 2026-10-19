package hooks

import (
	"encoding/json"
	"strings"
)

// SessionMeta is what a hook payload says about the session, beyond the tool
// call: Claude Code, Codex and Gemini CLI all send session_id, cwd and
// transcript_path; a model appears in some payloads (Codex; Claude Code's
// SessionStart) and is absent from others. Unverified fields are best effort.
type SessionMeta struct {
	SessionID      string
	Cwd            string
	TranscriptPath string
	Model          string
}

// Meta reads the session fields of any of the three agents' hook payloads.
func Meta(raw []byte) SessionMeta {
	var in struct {
		SessionID      string          `json:"session_id"`
		Cwd            string          `json:"cwd"`
		TranscriptPath string          `json:"transcript_path"`
		Model          json.RawMessage `json:"model"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return SessionMeta{}
	}
	return SessionMeta{SessionID: cut(in.SessionID, 200), Cwd: in.Cwd, TranscriptPath: cut(in.TranscriptPath, 1024), Model: cut(model(in.Model), 120)}
}

// model takes "claude-…" or {"id": "…", "display_name": "…"}.
func model(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	var o struct {
		ID   string `json:"id"`
		Name string `json:"display_name"`
	}
	if json.Unmarshal(raw, &o) == nil {
		if o.ID != "" {
			return o.ID
		}
		return o.Name
	}
	return ""
}

func cut(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
