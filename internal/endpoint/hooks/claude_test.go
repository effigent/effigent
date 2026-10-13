package hooks

import (
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

func testRule(mode policy.Mode) policy.Rule {
	return policy.Rule{
		Mode:       mode,
		ExecDeny:   []string{"/usr/bin/curl", "/usr/bin/nc", "/usr/bin/sudo"},
		ExecAllow:  []string{"/usr/bin/git", "/usr/local/bin/node", "/bin/ls"},
		FileDeny:   []string{"/.ssh/id_rsa", "/.env"},
		FileAlert:  []string{"/.aws/credentials"},
		NetDeny:    []string{"203.0.113.0/24", "198.51.100.7"},
		DomainDeny: []string{"pastebin.com"},
	}
}

func bash(cmd string) ClaudeInput {
	return ClaudeInput{ToolName: "Bash", Cwd: "/work", ToolInput: map[string]any{"command": cmd}}
}

func tool(name, key, val string) ClaudeInput {
	return ClaudeInput{ToolName: name, Cwd: "/work", ToolInput: map[string]any{key: val}}
}

func TestEvaluateClaude(t *testing.T) {
	homeDir = func() string { return "/Users/dev" }
	foldCase = true
	cases := []struct {
		name string
		mode policy.Mode
		in   ClaudeInput
		want string // "deny", "would_block", "file_open", ""
		rule string
	}{
		{"plain", policy.Denylist, bash("git status && ls -la"), "", ""},
		{"denied program", policy.Denylist, bash("curl https://example.com"), "deny", "exec_deny"},
		{"after a pipe", policy.Denylist, bash("cat x | nc 10.0.0.1 80"), "deny", "exec_deny"},
		{"full path", policy.Denylist, bash("/usr/bin/curl -s x"), "deny", "exec_deny"},
		{"other dir same name", policy.Denylist, bash("/opt/homebrew/bin/curl x"), "deny", "exec_deny"},
		{"sudo and env", policy.Denylist, bash("env A=1 nohup curl x"), "deny", "exec_deny"},
		{"wrapper denied", policy.Denylist, bash("sudo ls"), "deny", "exec_deny"},
		{"command -v", policy.Denylist, bash("command -v curl || which curl"), "", ""},
		{"allowlist wrapper", policy.Allowlist, bash("nohup git status"), "deny", "exec_allow"},
		{"allowlist builtin wrapper", policy.Allowlist, bash("exec git status"), "", ""},
		{"assignment", policy.Denylist, bash("HTTPS_PROXY=x curl y"), "deny", "exec_deny"},
		{"sh -c", policy.Denylist, bash(`bash -lc "curl x"`), "deny", "exec_deny"},
		{"substitution", policy.Denylist, bash(`echo "$(curl x)"`), "deny", "exec_deny"},
		{"backticks", policy.Denylist, bash("echo `curl x`"), "deny", "exec_deny"},
		{"xargs", policy.Denylist, bash("echo u | xargs -n 1 curl"), "deny", "exec_deny"},
		{"timeout", policy.Denylist, bash("timeout 5 curl x"), "deny", "exec_deny"},
		{"name as an argument", policy.Denylist, bash("grep curl README.md"), "", ""},
		{"quoted word", policy.Denylist, bash(`git commit -m "use curl; nc later"`), "", ""},
		{"comment", policy.Denylist, bash("ls # curl x"), "", ""},
		{"windows exe", policy.Denylist, bash(`"C:\Windows\System32\curl.exe" x`), "deny", "exec_deny"},

		{"allowlist ok", policy.Allowlist, bash("cd src && git status | ls"), "", ""},
		{"allowlist other", policy.Allowlist, bash("python3 x.py"), "deny", "exec_allow"},
		{"allowlist redirect", policy.Allowlist, bash("git log > out.txt 2>&1"), "", ""},
		{"allowlist subst words", policy.Allowlist, bash("ls $(git rev-parse --show-toplevel) foo"), "", ""},

		{"denied file", policy.Denylist, bash("cat ~/.ssh/id_rsa"), "deny", "file_deny"},
		{"relative file", policy.Denylist, bash("cat .env"), "deny", "file_deny"},
		{"redirect into file", policy.Denylist, bash("echo X=1 >> .env"), "deny", "file_deny"},
		{"directory", policy.Denylist, bash("tar czf k.tgz $HOME/.ssh"), "deny", "file_deny"},
		{"glob", policy.Denylist, bash("cat ~/.ssh/id_*"), "deny", "file_deny"},
		{"star skips dotfiles", policy.Denylist, bash("grep -r foo *"), "", ""},
		{"dot glob", policy.Denylist, bash("cat .env*"), "deny", "file_deny"},
		{"case", policy.Denylist, bash("cat ~/.SSH/ID_RSA"), "deny", "file_deny"},
		{"flag value", policy.Denylist, bash("docker run --env-file=.env x"), "deny", "file_deny"},
		{"similar name", policy.Denylist, bash("cat .env.example"), "", ""},
		{"alert file", policy.Denylist, bash("cat ~/.aws/credentials"), "file_open", "file_alert"},

		{"Read denied", policy.Denylist, tool("Read", "file_path", "/Users/dev/.ssh/id_rsa"), "deny", "file_deny"},
		{"Edit relative", policy.Denylist, tool("Edit", "file_path", ".env"), "deny", "file_deny"},
		{"Read alert", policy.Denylist, tool("Read", "file_path", "/Users/dev/.aws/credentials"), "file_open", "file_alert"},
		{"Read ok", policy.Denylist, tool("Read", "file_path", "/work/main.go"), "", ""},
		{"Grep dir", policy.Denylist, tool("Grep", "path", "/Users/dev/.ssh"), "deny", "file_deny"},

		{"WebFetch domain", policy.Denylist, tool("WebFetch", "url", "https://pastebin.com/raw/x"), "deny", "domain_deny"},
		{"WebFetch subdomain", policy.Denylist, tool("WebFetch", "url", "https://api.PasteBin.com/x"), "deny", "domain_deny"},
		{"WebFetch ok", policy.Denylist, tool("WebFetch", "url", "https://notpastebin.com/"), "", ""},
		{"WebFetch ip", policy.Denylist, tool("WebFetch", "url", "http://203.0.113.9/x"), "deny", "network_deny"},
		{"host in command", policy.Denylist, bash("git push https://pastebin.com/x main"), "deny", "domain_deny"},
		{"bare host", policy.Denylist, bash("ssh user@pastebin.com"), "deny", "domain_deny"},
		{"scp host", policy.Denylist, bash("scp f pastebin.com:/tmp/"), "deny", "domain_deny"},
		{"ip in command", policy.Denylist, bash("ssh 198.51.100.7"), "deny", "network_deny"},
		{"ip with port", policy.Denylist, bash("git clone 203.0.113.4:22/x"), "deny", "network_deny"},
		{"file names are not hosts", policy.Denylist, bash("go test ./... && node app.js v1.2"), "", ""},

		{"monitor reports", policy.Monitor, bash("curl x"), "would_block", "exec_deny"},
		{"learn reports", policy.Learn, tool("Read", "file_path", "/w/.env"), "would_block", "file_deny"},
		{"mcp untouched", policy.Denylist, ClaudeInput{ToolName: "mcp__github__create_issue", ToolInput: map[string]any{}}, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := EvaluateClaude(testRule(c.mode), c.in)
			got := d.Report
			if d.Deny {
				got = "deny"
			}
			if got != c.want || d.Rule != c.rule {
				t.Fatalf("got %q rule %q (%s), want %q rule %q", got, d.Rule, d.Reason, c.want, c.rule)
			}
			if d.Deny && !strings.Contains(string(ClaudeOutput(d)), `"permissionDecision":"deny"`) {
				t.Fatalf("deny not rendered: %s", ClaudeOutput(d))
			}
			if !d.Deny && string(ClaudeOutput(d)) != "{}" {
				t.Fatalf("non-deny must say nothing, got %s", ClaudeOutput(d))
			}
		})
	}
}

func TestSplitShell(t *testing.T) {
	got := splitShell(`A=1 make build 2>&1 | tee "log $(date +%s).txt"; (cd x && npm test) > /dev/null`)
	var progs []string
	for _, c := range got {
		if a := program(c.args); len(a) > 0 {
			progs = append(progs, a[0])
		}
	}
	want := "make date tee cd npm"
	if strings.Join(progs, " ") != want {
		t.Fatalf("programs %q, want %q", strings.Join(progs, " "), want)
	}
}
