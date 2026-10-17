package notify

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"
)

// fakeSMTP accepts one message on localhost (no TLS: local hosts may skip it)
// and returns the DATA section.
func fakeSMTP(t *testing.T) (addr string, got chan string) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	got = make(chan string, 1)
	go func() {
		defer ln.Close()
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		say := func(s string) { c.Write([]byte(s + "\r\n")) }
		say("220 fake")
		var data strings.Builder
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			if inData {
				if line == ".\r\n" {
					inData = false
					got <- data.String()
					say("250 queued")
					continue
				}
				data.WriteString(line)
				continue
			}
			switch cmd := strings.ToUpper(strings.Fields(line)[0]); cmd {
			case "EHLO", "HELO":
				say("250-fake\r\n250 AUTH PLAIN")
			case "AUTH":
				say("235 ok")
			case "DATA":
				inData = true
				say("354 go")
			case "QUIT":
				say("221 bye")
				return
			default:
				say("250 ok")
			}
		}
	}()
	return ln.Addr().String(), got
}

func TestEmail(t *testing.T) {
	addr, got := fakeSMTP(t)
	s := &Sender{SMTPURL: "smtp://user:pw@" + addr, From: "Effigent <approvals@effigent.ai>"}
	err := s.Email(context.Background(), []string{"sec@acme.io"}, Message{
		Title:  "Approval needed: Claude Code on dana-mbp\r\nBcc: evil@x.io", // header injection attempt
		Fields: [][2]string{{"Action", "Bash: git push --force <script>x</script>"}},
		Link:   "https://app.effigent.ai/approvals?id=apr_1",
		Actions: []Action{{Label: "Approve", URL: "https://api.effigent.ai/a/tok?d=approve", Style: "primary"},
			{Label: "Deny", URL: "https://api.effigent.ai/a/tok?d=deny", Style: "danger"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	msg := <-got
	for _, want := range []string{"From: \"Effigent\" <approvals@effigent.ai>", "To: sec@acme.io",
		"Subject: Approval needed: Claude Code on dana-mbp Bcc: evil@x.io\r\n", "Action: Bash: git push --force",
		"Review in Effigent: https://app.effigent.ai/approvals?id=apr_1", "Approve: https://api.effigent.ai/a/tok?d=approve",
		"Content-Type: text/html", `href="https://api.effigent.ai/a/tok?d=deny"`, "&lt;script&gt;"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("missing %q in:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "<script>x") && strings.Count(msg, "<script>x") > 1 {
		t.Fatalf("HTML not escaped:\n%s", msg)
	}
	if strings.Contains(msg, "\r\nBcc:") {
		t.Fatalf("header injected:\n%s", msg)
	}
}

func TestValidation(t *testing.T) {
	for _, u := range []string{"https://hooks.slack.com/services/T/B/x"} {
		if err := ValidSlackWebhook(u); err != nil {
			t.Fatalf("%s: %v", u, err)
		}
	}
	for _, u := range []string{"http://hooks.slack.com/services/T/B/x", "https://hooks.slack.com.evil.io/services/x",
		"https://user@hooks.slack.com/services/x", "https://hooks.slack.com/api/x", "https://169.254.169.254/"} {
		if ValidSlackWebhook(u) == nil {
			t.Fatalf("accepted %s", u)
		}
	}
	if ValidEmail("Dana <d@x.io>") == nil || ValidEmail("d@x.io") != nil {
		t.Fatal("email validation")
	}
	if (&Sender{}).EmailEnabled() {
		t.Fatal("email without SMTP")
	}
}
