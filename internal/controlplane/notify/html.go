package notify

import (
	"fmt"
	"html"
	"strings"
)

// htmlBody is the designed email: a header, the request as a table, and the
// buttons. Table layout and inline styles, which every mail client renders.
func htmlBody(m Message) string {
	e := html.EscapeString
	var rows strings.Builder
	for _, f := range m.Fields {
		val := e(f[1])
		if f[0] == "Action" {
			val = `<code style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f1f3f9;border:1px solid #e3e7f0;border-radius:6px;padding:6px 8px;display:inline-block;word-break:break-all">` + val + `</code>`
		}
		fmt.Fprintf(&rows, `<tr><td style="padding:7px 0;color:#6b7280;font-size:13px;width:96px;vertical-align:top">%s</td><td style="padding:7px 0;color:#111827;font-size:14px">%s</td></tr>`, e(f[0]), val)
	}
	btn := func(label, url, bg, fg, border string) string {
		return fmt.Sprintf(`<a href="%s" style="display:inline-block;background:%s;color:%s;border:1px solid %s;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:600;text-decoration:none;margin:0 8px 8px 0">%s</a>`,
			e(url), bg, fg, border, e(label))
	}
	var buttons strings.Builder
	for _, a := range m.Actions {
		switch a.Style {
		case "primary":
			buttons.WriteString(btn(a.Label, a.URL, "#16a34a", "#ffffff", "#15803d"))
		case "danger":
			buttons.WriteString(btn(a.Label, a.URL, "#dc2626", "#ffffff", "#b91c1c"))
		default:
			buttons.WriteString(btn(a.Label, a.URL, "#ffffff", "#111827", "#d1d5db"))
		}
	}
	if m.Link != "" {
		buttons.WriteString(btn("Review in Effigent", m.Link, "#ffffff", "#4f46e5", "#c7d2fe"))
	}
	footer := ""
	if m.Footer != "" {
		footer = `<p style="margin:18px 0 0;color:#6b7280;font-size:12px;line-height:1.5">` + e(m.Footer) + `</p>`
	}
	return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5fb">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fb;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7ef;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<tr><td style="background:#0f1530;padding:16px 24px;color:#ffffff;font-size:15px;font-weight:700;letter-spacing:.2px">Effigent <span style="color:#9aa3c7;font-weight:400">· AI Agent Control Plane</span></td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 14px;font-size:19px;line-height:1.35;color:#111827">` + e(strings.Join(strings.Fields(m.Title), " ")) + `</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` + rows.String() + `</table>
<div style="margin-top:20px">` + buttons.String() + `</div>` + footer + `
</td></tr></table>
<p style="color:#9ca3af;font-size:11px;margin:14px 0 0;font-family:-apple-system,Helvetica,Arial,sans-serif">Sent by Effigent because you are an approver for this workspace.</p>
</td></tr></table></body></html>`
}
