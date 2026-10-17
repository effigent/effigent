package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	ep "github.com/effigent/effigent/internal/endpoint/policy"
)

// The policy assistant turns a plain-language request ("ask before any git
// push", "block curl for every agent except on build machines") into a
// proposed endpoint policy, validated with effigentd's own parser. It never
// publishes: the console loads the proposal into the editor for review.

const assistSystem = `You edit the endpoint policy of Effigent, which controls AI coding agents (Claude Code, Codex, Gemini CLI…) on company machines.
The policy is YAML. Its format, with comments, is the reference policy below. Rules:
- "defaults" applies to every agent; an entry under "agents" overrides individual fields for that agent only.
- Modes: monitor (observe; matches are reported), learn, denylist (block listed items), allowlist (block everything not in exec_allow).
- exec_deny / exec_allow / exec_approve: ABSOLUTE program paths (e.g. /usr/bin/curl). List the common locations (/usr/bin, /bin, /usr/local/bin, /opt/homebrew/bin) when the user names a program.
- file_deny / file_alert / file_approve: path suffixes (e.g. /.env, /.ssh/id_rsa).
- domain_deny / domain_approve: exact hostnames (no scheme, no wildcards; www. separately).
- network_deny / network_allow / network_approve: IPs or CIDRs only.
- command_approve: command lines, exact or prefix with a trailing * (e.g. "git push*"); tool_approve: agent tool names, e.g. "mcp__github__*" or "WebFetch".
- tool_deny: agent tool names to refuse outright (same patterns, e.g. "mcp__claude-in-chrome__*"); MCP tools are named mcp__<server>__<tool>.
- Deny and allow lists only block in denylist/allowlist mode; to enforce for one agent only, set that agent's mode under "agents".
- Approval lists pause the agent and ask an approver; they only pause in denylist or allowlist mode. The "approvals" block (wait_seconds ≤ 90, ttl_minutes) is top-level.
- Keep everything in the current policy that the request doesn't change, including comments, agents and mcp_servers.
Answer with exactly two parts:
<summary>one or two plain sentences on what you changed</summary>
<policy>
the complete new policy YAML, no code fences
</policy>`

var (
	reSummary = regexp.MustCompile(`(?s)<summary>(.*?)</summary>`)
	rePolicy  = regexp.MustCompile("(?s)<policy>\\s*(?:```(?:ya?ml)?\\s*)?(.*?)(?:```\\s*)?</policy>")
)

type assistLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

// allow: 30 requests per tenant per hour.
func (l *assistLimiter) allow(tenant string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := time.Now().Add(-time.Hour)
	h := l.hits[tenant][:0]
	for _, t := range l.hits[tenant] {
		if t.After(cut) {
			h = append(h, t)
		}
	}
	if len(h) >= 30 {
		l.hits[tenant] = h
		return false
	}
	l.hits[tenant] = append(h, time.Now())
	return true
}

var assistLimits = &assistLimiter{hits: map[string][]time.Time{}}

func (s *Server) assistPolicy(w http.ResponseWriter, r *http.Request, p Principal) {
	if s.AIKey == "" {
		writeErr(w, http.StatusServiceUnavailable, "the policy assistant is not set up on this control plane (EFFIGENT_ANTHROPIC_API_KEY)")
		return
	}
	var req struct {
		Prompt string `json:"prompt"`
		Body   string `json:"body"` // the editor's current text; default: the published policy
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || strings.TrimSpace(req.Prompt) == "" {
		writeErr(w, http.StatusBadRequest, `body must be {"prompt": "what to change", "body": "<current policy, optional>"}`)
		return
	}
	if !assistLimits.allow(p.Tenant) {
		writeErr(w, http.StatusTooManyRequests, "the policy assistant allows 30 requests per hour per workspace")
		return
	}
	current := req.Body
	if strings.TrimSpace(current) == "" {
		if pv, err := s.Store.LatestPolicy(r.Context(), p.Tenant); err == nil {
			current = pv.Body
		} else {
			current = string(ep.DefaultYAML)
		}
	}
	prompt := clip(strings.TrimSpace(req.Prompt), 4000)
	msgs := []map[string]string{{"role": "user", "content": "Current policy:\n<current>\n" + current + "\n</current>\n\nRequest: " + prompt}}

	var summary, proposal, perr string
	for attempt := 0; attempt < 2; attempt++ {
		text, err := s.callClaude(r.Context(), msgs)
		if err != nil {
			s.Logf("policy assist: %v", err)
			msg := "the policy assistant could not answer; try again"
			switch e := err.Error(); {
			case strings.Contains(e, "credit balance"):
				msg = "the policy assistant's Anthropic account is out of credit — add credit in the Anthropic console (Plans & Billing)"
			case strings.Contains(e, "anthropic 401"), strings.Contains(e, "invalid x-api-key"):
				msg = "the policy assistant's Anthropic API key was rejected — replace effigent/cp/anthropic-api-key"
			case strings.Contains(e, "anthropic 429"), strings.Contains(e, "anthropic 529"):
				msg = "the policy assistant is busy (Anthropic rate limit); try again in a minute"
			}
			writeErr(w, http.StatusBadGateway, msg)
			return
		}
		summary, proposal = "", ""
		if m := reSummary.FindStringSubmatch(text); m != nil {
			summary = strings.TrimSpace(m[1])
		}
		if m := rePolicy.FindStringSubmatch(text); m != nil {
			proposal = strings.TrimSpace(m[1]) + "\n"
		}
		perr = ""
		if proposal == "\n" || proposal == "" {
			perr = "the answer had no <policy> section"
		} else if _, err := ep.Parse([]byte(proposal)); err != nil {
			perr = err.Error()
		}
		if perr == "" {
			break
		}
		msgs = append(msgs, map[string]string{"role": "assistant", "content": text},
			map[string]string{"role": "user", "content": "effigentd rejects that policy: " + perr + "\nFix it and answer again in the same format."})
	}
	s.audit(r, p, "policy.assist", "", map[string]any{"prompt": clip(prompt, 300), "valid": perr == "", "model": s.aiModel()})
	writeJSON(w, http.StatusOK, map[string]any{"summary": summary, "yaml": proposal, "valid": perr == "", "error": perr, "model": s.aiModel()})
}

func (s *Server) aiModel() string {
	if s.AIModel != "" {
		return s.AIModel
	}
	return "claude-haiku-5-5"
}

// callClaude sends one Messages API request and returns the text answer.
func (s *Server) callClaude(ctx context.Context, msgs []map[string]string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model": s.aiModel(), "max_tokens": 8000, "system": assistSystem + "\n\nReference policy:\n<reference>\n" + string(ep.DefaultYAML) + "</reference>",
		"messages": msgs,
	})
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	base := s.AIBaseURL
	if base == "" {
		base = "https://api.anthropic.com"
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/messages", bytes.NewReader(body))
	req.Header.Set("x-api-key", s.AIKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("anthropic %d: %s", res.StatusCode, clip(string(raw), 300))
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	var b strings.Builder
	for _, c := range out.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	if b.Len() == 0 {
		return "", errors.New("empty answer")
	}
	return b.String(), nil
}
