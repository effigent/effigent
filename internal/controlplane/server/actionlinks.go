package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

// Approve / Deny buttons in emails open a signed link here. The link names
// one request, one recipient and expires with the request. (Slack buttons are
// interactive and go to /slack/interactions instead: slackapp.go.)
// Opening it (GET) only shows a confirmation page — mail scanners open every
// link — and the decision is made by the button on that page (POST).

type linkClaims struct {
	Approval  string `json:"a"`
	Tenant    string `json:"t"`
	Recipient string `json:"r"` // email address, or the Slack team id (slack-app)
	Channel   string `json:"c"` // email | slack-app (| slack: old webhook links, refused)
	Expires   int64  `json:"e"`
}

func (s *Server) linkKey() []byte {
	h := sha256.Sum256(append([]byte("effigent-approval-links\x00"), s.Key.Seed()...))
	return h[:]
}

func (s *Server) signLink(c linkClaims) string {
	body, _ := json.Marshal(c)
	mac := hmac.New(sha256.New, s.linkKey())
	mac.Write(body)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(body) + "." + enc.EncodeToString(mac.Sum(nil))
}

func (s *Server) verifyLink(tok string) (linkClaims, error) {
	c, expired, err := s.parseLink(tok)
	if err == nil && expired {
		err = errors.New("this link has expired")
	}
	return c, err
}

// parseLink checks a token's signature; expired is reported separately so a
// late click can still be answered ("this request expired").
func (s *Server) parseLink(tok string) (c linkClaims, expired bool, err error) {
	body64, sig64, ok := strings.Cut(tok, ".")
	enc := base64.RawURLEncoding
	body, err1 := enc.DecodeString(body64)
	sig, err2 := enc.DecodeString(sig64)
	if !ok || err1 != nil || err2 != nil {
		return c, false, errors.New("this link is not valid")
	}
	mac := hmac.New(sha256.New, s.linkKey())
	mac.Write(body)
	if !hmac.Equal(sig, mac.Sum(nil)) || json.Unmarshal(body, &c) != nil {
		return linkClaims{}, false, errors.New("this link is not valid")
	}
	return c, time.Now().Unix() > c.Expires, nil
}

// approvalActions are the Approve / Deny buttons for one recipient.
func (s *Server) approvalActions(a store.Approval, recipient, channel string) []notify.Action {
	if s.PublicBaseURL == "" || s.Key == nil {
		return nil
	}
	tok := s.signLink(linkClaims{Approval: a.ID, Tenant: a.Tenant, Recipient: recipient, Channel: channel, Expires: a.ExpiresAt.Unix()})
	base := strings.TrimSuffix(s.PublicBaseURL, "/") + "/a/" + tok
	return []notify.Action{{Label: "Approve", URL: base + "?d=approve", Style: "primary"}, {Label: "Deny", URL: base + "?d=deny", Style: "danger"}}
}

func (s *Server) approvalLink(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src https://effigent.ai; form-action 'self'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	c, err := s.verifyLink(r.PathValue("token"))
	if err != nil {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, page("Link not valid", `<p>`+html.EscapeString(err.Error())+`. Open the request in the Effigent console instead.</p>`))
		return
	}
	if c.Channel != "email" {
		// Slack: webhook messages carried these links until Slack decisions
		// had to name the person (now the Slack app's interactive buttons);
		// a link anyone in the channel could forward can't decide.
		w.WriteHeader(http.StatusForbidden)
		console := ""
		if s.ConsoleOrigin != "" {
			console = ` <a href="` + html.EscapeString(s.ConsoleOrigin+"/approvals?id="+c.Approval) + `">Open it in the Effigent console</a>.`
		}
		fmt.Fprint(w, page("Decide in Effigent", `<p>Decisions from Slack must show who made them, so this button no longer decides.`+console+`</p>`))
		return
	}
	if c.Approval == "apr_sample" {
		fmt.Fprint(w, page("This was a sample", `<p>Nothing is waiting: this button came from a sample message. Real requests open here with Approve and Deny.</p>`))
		return
	}
	a, err := s.Store.GetApproval(r.Context(), c.Tenant, c.Approval)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, page("Request not found", `<p>This approval request no longer exists.</p>`))
		return
	}
	who := c.Recipient + " (via " + c.Channel + ")"
	if r.Method == http.MethodPost {
		_ = r.ParseForm()
		d := r.PostForm.Get("decision")
		if d != "approve" && d != "deny" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, page("Choose Approve or Deny", ""))
			return
		}
		note := clip(strings.TrimSpace(r.PostForm.Get("note")), 500)
		got, err := s.Store.DecideApproval(r.Context(), c.Tenant, a.ID, d == "approve", "link:"+c.Channel+":"+c.Recipient, who, note, approvalUseWindow)
		if errors.Is(err, store.ErrAlreadyDecided) {
			cur, _ := s.Store.GetApproval(r.Context(), c.Tenant, a.ID)
			fmt.Fprint(w, page("Already decided", `<p>This request is already <b>`+html.EscapeString(cur.State)+`</b>`+byLine(cur)+`.</p>`))
			return
		} else if err != nil {
			s.fail(w, err)
			return
		}
		p := Principal{UserID: "link:" + c.Channel + ":" + c.Recipient, Tenant: c.Tenant, Role: "approver", Via: "approval-link"}
		s.audit(r, p, "approval."+d, a.ID, map[string]any{"summary": got.Summary, "hostname": got.Hostname, "rule": got.Rule, "note": note, "via": c.Channel})
		s.emit(r.Context(), c.Tenant, "approval.decided", s.approvalEvent(got))
		verb, color := "Approved", "#16a34a"
		if d == "deny" {
			verb, color = "Denied", "#dc2626"
		}
		fmt.Fprint(w, page(verb, `<p style="font-size:15px"><b style="color:`+color+`">`+verb+`</b> — `+html.EscapeString(got.Summary)+`</p>`+
			`<p>The agent on <b>`+html.EscapeString(got.Hostname)+`</b> gets the answer now.`+map[bool]string{true: ` The action may run once.`, false: ``}[d == "approve"]+`</p>`))
		return
	}

	if a.State != store.ApprovalPending || !a.ExpiresAt.After(time.Now()) {
		state := a.State
		if state == store.ApprovalPending {
			state = "expired"
		}
		fmt.Fprint(w, page("No longer waiting", `<p>This request is <b>`+html.EscapeString(state)+`</b>`+byLine(a)+`.</p>`))
		return
	}
	pre := r.URL.Query().Get("d")
	approveStyle, denyStyle := btnStyle("#16a34a", pre != "deny"), btnStyle("#dc2626", pre == "deny")
	e := html.EscapeString
	machine := a.Hostname
	if a.OSUser != "" {
		machine = a.OSUser + " on " + a.Hostname
	}
	body := `<table style="width:100%;border-collapse:collapse;margin:0 0 18px">` +
		row("Action", `<code style="font-family:Menlo,Consolas,monospace;font-size:13px;background:#f1f3f9;border:1px solid #e3e7f0;border-radius:6px;padding:6px 8px;display:inline-block;word-break:break-all">`+e(a.Summary)+`</code>`) +
		row("Why", e(a.Reason)) + row("Machine", e(machine)) + row("Rule", e(a.Rule)) +
		row("Expires", e(a.ExpiresAt.UTC().Format("Jan 2 15:04 MST"))) + `</table>` +
		`<form method="post">` +
		`<label style="display:block;font-size:13px;color:#6b7280;margin:0 0 6px">Note for the agent and the audit trail (optional)</label>` +
		`<textarea name="note" rows="2" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:8px;font:inherit;margin:0 0 14px"></textarea>` +
		`<button name="decision" value="approve" style="` + approveStyle + `">Approve once</button>` +
		`<button name="decision" value="deny" style="` + denyStyle + `">Deny</button>` +
		`</form><p style="color:#6b7280;font-size:12px;margin:14px 0 0">Deciding as <b>` + e(who) + `</b>. Approving lets this exact action run once.</p>`
	fmt.Fprint(w, page("Approval needed", body))
}

func byLine(a store.Approval) string {
	if a.DecidedByName == "" {
		return ""
	}
	return " by " + html.EscapeString(a.DecidedByName)
}

func row(k, v string) string {
	return `<tr><td style="padding:7px 0;color:#6b7280;font-size:13px;width:90px;vertical-align:top">` + html.EscapeString(k) + `</td><td style="padding:7px 0;font-size:14px">` + v + `</td></tr>`
}

func btnStyle(color string, solid bool) string {
	if solid {
		return "background:" + color + ";color:#fff;border:1px solid " + color + ";border-radius:8px;padding:11px 22px;font-size:15px;font-weight:600;margin:0 8px 0 0;cursor:pointer"
	}
	return "background:#fff;color:" + color + ";border:1px solid " + color + ";border-radius:8px;padding:11px 22px;font-size:15px;font-weight:600;margin:0 8px 0 0;cursor:pointer"
}

func page(title, body string) string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` + html.EscapeString(title) + ` · Effigent</title></head>` +
		`<body style="margin:0;background:#f4f5fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">` +
		`<div style="max-width:560px;margin:32px auto;padding:0 16px"><div style="background:#fff;border:1px solid #e5e7ef;border-radius:14px;overflow:hidden">` +
		`<div style="background:#0f1530;color:#fff;padding:14px 24px;font-weight:700;display:flex;align-items:center;gap:10px"><img src="`+notify.LogoURL+`" width="32" height="32" alt="" style="border-radius:8px">Effigent <span style="color:#9aa3c7;font-weight:400">· AI Agent Control Plane</span></div>` +
		`<div style="padding:24px"><h1 style="margin:0 0 14px;font-size:20px">` + html.EscapeString(title) + `</h1>` + body + `</div></div></div></body></html>`
}
