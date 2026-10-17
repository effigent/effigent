package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAssistPolicy(t *testing.T) {
	ctx := context.Background()
	auth, _ := NewAuthenticator(ctx, Options{AdminToken: "t0ken", AdminTenants: []string{"org:assist"}})
	var calls atomic.Int32
	var lastModel string
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model    string `json:"model"`
			Messages []struct{ Role, Content string }
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		lastModel = req.Model
		if r.Header.Get("x-api-key") != "sk-test" || !strings.Contains(req.Messages[0].Content, "ask before git push") {
			http.Error(w, "bad request", 400)
			return
		}
		text := "<summary>Added approval for git push.</summary>\n<policy>\ndefaults:\n  mode: sometimes\n</policy>" // invalid first
		if calls.Add(1) > 1 {
			if !strings.Contains(req.Messages[len(req.Messages)-1].Content, "unknown mode") {
				http.Error(w, "retry did not carry the parser error", 400)
				return
			}
			text = "<summary>Agents now ask before git push.</summary>\n<policy>\n```yaml\ndefaults:\n  mode: denylist\n  command_approve: [\"git push*\"]\n```\n</policy>"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"content": []map[string]string{{"type": "text", "text": text}}})
	}))
	defer fake.Close()

	post := func(s *Server, body any) (int, map[string]any) {
		srv := httptest.NewServer(s.Handler())
		defer srv.Close()
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", srv.URL+"/api/v1/policy/assist", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer t0ken")
		req.Header.Set("X-Effigent-Tenant", "org:assist")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	if code, _ := post(&Server{Auth: auth, Logf: t.Logf}, map[string]any{"prompt": "x", "body": "defaults: {mode: monitor}"}); code != 503 {
		t.Fatalf("no key: %d", code)
	}
	s := &Server{Auth: auth, Logf: t.Logf, AIKey: "sk-test", AIBaseURL: fake.URL}
	code, out := post(s, map[string]any{"prompt": "ask before git push", "body": "defaults:\n  mode: monitor\n"})
	if code != 200 || out["valid"] != true || !strings.Contains(out["yaml"].(string), `command_approve: ["git push*"]`) || strings.Contains(out["yaml"].(string), "```") {
		t.Fatalf("assist: %d %+v", code, out)
	}
	if out["summary"] != "Agents now ask before git push." || calls.Load() != 2 || lastModel != "claude-haiku-5-5" {
		t.Fatalf("summary %v, calls %d, model %q", out["summary"], calls.Load(), lastModel)
	}
}
