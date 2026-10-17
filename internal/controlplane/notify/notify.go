// Package notify announces approval requests: a Slack incoming webhook per
// tenant, and email through the Amazon SES API (the service's own AWS role) or
// over SMTP (any provider: Resend, Postmark, Google Workspace…). Messages link to the console, where an approver signs in to
// decide; nothing in a message can approve by itself.
package notify

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Message is one announcement. Fields are label/value pairs shown under the title.
type Message struct {
	Title  string
	Fields [][2]string
	Link   string // console page to review the request
	Footer string
	// Actions are buttons (Approve / Deny); each opens a confirmation page.
	Actions []Action
}

// Action is one button. Style: "primary" (green), "danger" (red) or "".
type Action struct {
	Label, URL, Style string
}

// Sender delivers messages. The zero value sends Slack only.
type Sender struct {
	// SMTPURL: smtp://user:pass@host:587 (STARTTLS, required unless the host
	// is local) or smtps://user:pass@host:465 (TLS from the start).
	SMTPURL string
	// SESRegion sends through the Amazon SES API with the process's AWS role
	// instead (used when SMTPURL is empty), e.g. "us-east-1".
	SESRegion string
	From      string // "Effigent <approvals@effigent.ai>"
	HTTP      *http.Client

	sesOnce sync.Once
	ses     *sesSender
}

// EmailEnabled reports whether this server can send email.
func (s *Sender) EmailEnabled() bool {
	return s != nil && (s.SMTPURL != "" || s.SESRegion != "") && s.From != ""
}

// ValidSlackWebhook accepts only Slack's incoming-webhook URLs, so the control
// plane never posts to an address a tenant admin picked (internal services).
func ValidSlackWebhook(u string) error {
	p, err := url.Parse(u)
	if err != nil || p.Scheme != "https" || p.Host != "hooks.slack.com" || !strings.HasPrefix(p.Path, "/services/") || p.User != nil {
		return errors.New("use a Slack incoming webhook URL (https://hooks.slack.com/services/…)")
	}
	return nil
}

// ValidEmail checks one recipient address.
func ValidEmail(a string) error {
	m, err := mail.ParseAddress(a)
	if err != nil || m.Address != a || m.Name != "" {
		return fmt.Errorf("%q is not an email address", a)
	}
	return nil
}

// Slack posts the message to an incoming webhook.
func (s *Sender) Slack(ctx context.Context, webhook string, m Message) error {
	if err := ValidSlackWebhook(webhook); err != nil {
		return err
	}
	var fields []map[string]any
	for _, f := range m.Fields {
		fields = append(fields, map[string]any{"type": "mrkdwn", "text": "*" + slackEscape(f[0]) + "*\n" + slackEscape(f[1])})
	}
	blocks := []map[string]any{
		{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": "*" + slackEscape(m.Title) + "*"}},
	}
	for i := 0; i < len(fields); i += 10 { // Slack allows 10 fields per section
		blocks = append(blocks, map[string]any{"type": "section", "fields": fields[i:min(i+10, len(fields))]})
	}
	var buttons []map[string]any
	for _, a := range m.Actions {
		b := map[string]any{"type": "button", "url": a.URL, "text": map[string]any{"type": "plain_text", "text": a.Label}}
		if a.Style == "primary" || a.Style == "danger" {
			b["style"] = a.Style
		}
		buttons = append(buttons, b)
	}
	if m.Link != "" {
		b := map[string]any{"type": "button", "url": m.Link, "text": map[string]any{"type": "plain_text", "text": "Review in Effigent"}}
		if len(m.Actions) == 0 {
			b["style"] = "primary"
		}
		buttons = append(buttons, b)
	}
	if len(buttons) > 0 {
		blocks = append(blocks, map[string]any{"type": "actions", "elements": buttons})
	}
	if m.Footer != "" {
		blocks = append(blocks, map[string]any{"type": "context", "elements": []map[string]any{{"type": "mrkdwn", "text": slackEscape(m.Footer)}}})
	}
	body, _ := json.Marshal(map[string]any{"text": m.Title, "blocks": blocks})
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, webhook, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	c := s.httpClient()
	res, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("slack: %w", err)
	}
	defer res.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("slack answered %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

func (s *Sender) httpClient() *http.Client {
	if s != nil && s.HTTP != nil {
		return s.HTTP
	}
	// Never follow redirects: the webhook host was validated, its target wasn't.
	return &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// slackEscape escapes the three characters Slack's mrkdwn treats as control.
func slackEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// Email sends the message as plain text to each recipient.
func (s *Sender) Email(ctx context.Context, to []string, m Message) error {
	if !s.EmailEnabled() {
		return errors.New("email is not configured on this control plane (EFFIGENT_SES_REGION or EFFIGENT_SMTP_URL, and EFFIGENT_EMAIL_FROM)")
	}
	if len(to) == 0 {
		return nil
	}
	for _, a := range to {
		if err := ValidEmail(a); err != nil {
			return err
		}
	}
	from, err := mail.ParseAddress(s.From)
	if err != nil {
		return fmt.Errorf("EFFIGENT_EMAIL_FROM: %w", err)
	}
	if s.SMTPURL == "" {
		s.sesOnce.Do(func() { s.ses = &sesSender{region: s.SESRegion} })
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		return s.ses.send(ctx, from, to, render(from, to, m))
	}
	u, err := url.Parse(s.SMTPURL)
	if err != nil || (u.Scheme != "smtp" && u.Scheme != "smtps") || u.Hostname() == "" {
		return errors.New("EFFIGENT_SMTP_URL must look like smtp://user:pass@host:587 or smtps://user:pass@host:465")
	}
	host, port := u.Hostname(), u.Port()
	if port == "" {
		port = map[string]string{"smtp": "587", "smtps": "465"}[u.Scheme]
	}
	deadline := time.Now().Add(30 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	dialer := &net.Dialer{Deadline: deadline}
	var conn net.Conn
	if u.Scheme == "smtps" {
		conn, err = tls.DialWithDialer(dialer, "tcp", net.JoinHostPort(host, port), &tls.Config{ServerName: host})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	}
	if err != nil {
		return fmt.Errorf("smtp: %w", err)
	}
	_ = conn.SetDeadline(deadline)
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp: %w", err)
	}
	defer c.Close()
	if u.Scheme == "smtp" {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(&tls.Config{ServerName: host}); err != nil {
				return fmt.Errorf("smtp starttls: %w", err)
			}
		} else if !isLocal(host) {
			return errors.New("smtp: the server does not offer STARTTLS; refusing to send credentials in clear text")
		}
	}
	if u.User != nil {
		pass, _ := u.User.Password()
		if err := c.Auth(smtp.PlainAuth("", u.User.Username(), pass, host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return fmt.Errorf("smtp: %w", err)
	}
	for _, a := range to {
		if err := c.Rcpt(a); err != nil {
			return fmt.Errorf("smtp rcpt %s: %w", a, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp: %w", err)
	}
	if _, err := w.Write(render(from, to, m)); err != nil {
		return fmt.Errorf("smtp: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp: %w", err)
	}
	return c.Quit()
}

func isLocal(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// render builds the RFC 5322 message. Header values come from agent and
// machine data, so line breaks are stripped (no header injection).
func render(from *mail.Address, to []string, m Message) []byte {
	oneLine := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	id := make([]byte, 12)
	_, _ = rand.Read(id)
	domain := from.Address[strings.LastIndexByte(from.Address, '@')+1:]
	boundary := "effigent-" + hex.EncodeToString(id)
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from.String())
	fmt.Fprintf(&b, "To: %s\r\n", strings.Join(to, ", "))
	fmt.Fprintf(&b, "Subject: %s\r\n", mimeHeader(oneLine(m.Title)))
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().UTC().Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Message-ID: <%s@%s>\r\n", hex.EncodeToString(id), domain)
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=%q\r\n\r\n", boundary)

	// plain text, for clients that don't show HTML
	fmt.Fprintf(&b, "--%s\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n", boundary)
	b.WriteString(oneLine(m.Title) + "\r\n\r\n")
	for _, f := range m.Fields {
		fmt.Fprintf(&b, "%s: %s\r\n", f[0], f[1])
	}
	for _, a := range m.Actions {
		fmt.Fprintf(&b, "\r\n%s: %s\r\n", a.Label, a.URL)
	}
	if m.Link != "" {
		fmt.Fprintf(&b, "\r\nReview in Effigent: %s\r\n", m.Link)
	}
	if m.Footer != "" {
		fmt.Fprintf(&b, "\r\n-- \r\n%s\r\n", m.Footer)
	}
	fmt.Fprintf(&b, "\r\n--%s\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n", boundary)
	b.WriteString(htmlBody(m))
	fmt.Fprintf(&b, "\r\n--%s--\r\n", boundary)
	return []byte(strings.ReplaceAll(strings.ReplaceAll(b.String(), "\r\n", "\n"), "\n", "\r\n"))
}

// mimeHeader encodes a non-ASCII header value (RFC 2047).
func mimeHeader(s string) string {
	for _, r := range s {
		if r > 126 {
			return "=?utf-8?q?" + qEncode(s) + "?="
		}
	}
	return s
}

func qEncode(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c == ' ':
			b.WriteByte('_')
		case c >= '0' && c <= '9', c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '.', c == '-':
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "=%02X", c)
		}
	}
	return b.String()
}
