package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// A tenant's own Slack app, called with its bot token (scopes chat:write,
// chat:write.public, users:read, users:read.email).

// SlackAPIError is an error Slack's Web API answered with ("not_in_channel").
type SlackAPIError struct{ Method, Code string }

func (e *SlackAPIError) Error() string {
	hint := map[string]string{
		"not_in_channel":          " — invite the Effigent app to the channel (/invite @Effigent), or add the chat:write.public scope",
		"channel_not_found":       " — check the channel ID, and invite the app if the channel is private",
		"invalid_auth":            " — the bot token is not valid (use the xoxb- token from OAuth & Permissions)",
		"not_authed":              " — the bot token is missing",
		"account_inactive":        " — the app was uninstalled or the token revoked",
		"token_revoked":           " — the app was uninstalled or the token revoked",
		"missing_scope":           " — the app is missing a scope: chat:write, chat:write.public, users:read, users:read.email",
		"user_not_found":          "",
		"ratelimited":             " — Slack is rate limiting; try again shortly",
		"is_archived":             " — the channel is archived",
		"restricted_action":       " — the workspace does not let the app post there",
		"invalid_blocks":          "",
		"msg_too_long":            "",
		"no_text":                 "",
		"team_access_not_granted": "",
	}[e.Code]
	return "slack " + e.Method + ": " + e.Code + hint
}

func (s *Sender) slackAPIBase() string {
	if s != nil && s.SlackAPIBase != "" {
		return strings.TrimSuffix(s.SlackAPIBase, "/")
	}
	return "https://slack.com/api"
}

// slackCall calls one Web API method with the bot token: form-encoded when
// form is set, otherwise JSON. out receives the whole answer.
func (s *Sender) slackCall(ctx context.Context, token, method string, form url.Values, body any, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var req *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		req, _ = http.NewRequestWithContext(ctx, http.MethodPost, s.slackAPIBase()+"/"+method, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	} else {
		req, _ = http.NewRequestWithContext(ctx, http.MethodPost, s.slackAPIBase()+"/"+method, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("slack %s: %w", method, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("slack %s answered %d", method, res.StatusCode)
	}
	var env struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("slack %s: bad answer", method)
	}
	if !env.OK {
		return &SlackAPIError{Method: method, Code: env.Error}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// SlackTeam is who a bot token belongs to.
type SlackTeam struct {
	TeamID string `json:"team_id"`
	Team   string `json:"team"`
	UserID string `json:"user_id"` // the bot user
	BotID  string `json:"bot_id"`
}

// SlackAuthTest checks a bot token and returns its workspace.
func (s *Sender) SlackAuthTest(ctx context.Context, token string) (SlackTeam, error) {
	var t SlackTeam
	if !strings.HasPrefix(token, "xoxb-") {
		return t, errors.New("use the app's Bot User OAuth Token (xoxb-…)")
	}
	err := s.slackCall(ctx, token, "auth.test", url.Values{}, nil, &t)
	return t, err
}

// SlackPost posts the message to a channel as the app and returns the
// message timestamp.
func (s *Sender) SlackPost(ctx context.Context, token, channel string, m Message) (string, error) {
	var out struct {
		TS string `json:"ts"`
	}
	err := s.slackCall(ctx, token, "chat.postMessage", nil,
		map[string]any{"channel": channel, "text": m.Title, "blocks": SlackBlocks(m), "unfurl_links": false}, &out)
	return out.TS, err
}

// SlackUpdate replaces a message the app posted (chat.update).
func (s *Sender) SlackUpdate(ctx context.Context, token, channel, ts, text string, blocks []map[string]any) error {
	return s.slackCall(ctx, token, "chat.update", nil, map[string]any{"channel": channel, "ts": ts, "text": text, "blocks": blocks}, nil)
}

// SlackUser is a Slack account, from users.info.
type SlackUser struct {
	ID           string
	TeamID       string
	Username     string // the handle (name)
	RealName     string
	DisplayName  string
	Email        string
	IsBot        bool
	Deleted      bool
	IsRestricted bool // guest accounts
}

// Name is how to show the person: their display name, real name or handle.
func (u SlackUser) Name() string {
	for _, n := range []string{u.RealName, u.DisplayName, u.Username} {
		if n = strings.TrimSpace(n); n != "" {
			return n
		}
	}
	return u.ID
}

// SlackUserInfo reads one user (users:read, users:read.email).
func (s *Sender) SlackUserInfo(ctx context.Context, token, user string) (SlackUser, error) {
	var out struct {
		User struct {
			ID                string `json:"id"`
			TeamID            string `json:"team_id"`
			Name              string `json:"name"`
			RealName          string `json:"real_name"`
			Deleted           bool   `json:"deleted"`
			IsBot             bool   `json:"is_bot"`
			IsRestricted      bool   `json:"is_restricted"`
			IsUltraRestricted bool   `json:"is_ultra_restricted"`
			Profile           struct {
				Email       string `json:"email"`
				RealName    string `json:"real_name"`
				DisplayName string `json:"display_name"`
			} `json:"profile"`
		} `json:"user"`
	}
	if err := s.slackCall(ctx, token, "users.info", url.Values{"user": {user}}, nil, &out); err != nil {
		return SlackUser{}, err
	}
	u := out.User
	real := u.RealName
	if real == "" {
		real = u.Profile.RealName
	}
	return SlackUser{ID: u.ID, TeamID: u.TeamID, Username: u.Name, RealName: real, DisplayName: u.Profile.DisplayName,
		Email: u.Profile.Email, IsBot: u.IsBot || u.ID == "USLACKBOT", Deleted: u.Deleted, IsRestricted: u.IsRestricted || u.IsUltraRestricted}, nil
}

// ValidSlackResponseURL accepts only the response_url Slack puts in an
// interaction (https://hooks.slack.com/actions/…): it arrives in a request
// body, and the control plane must never post to an address someone picked.
func ValidSlackResponseURL(u string) error {
	p, err := url.Parse(u)
	if err != nil || p.Scheme != "https" || p.Host != "hooks.slack.com" || !strings.HasPrefix(p.Path, "/actions/") || p.User != nil {
		return errors.New("not a Slack response_url")
	}
	return nil
}

// SlackRespond answers an interaction through its response_url: replace
// the original message, or (ephemeral) tell only the person who clicked.
func (s *Sender) SlackRespond(ctx context.Context, responseURL string, body map[string]any) error {
	if err := ValidSlackResponseURL(responseURL); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, responseURL, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res, err := s.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("slack response_url: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 256))
		return fmt.Errorf("slack response_url answered %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}
