package hooks

import (
	"net"
	"net/url"
	"os"
	"path"
	"runtime"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

func init() { Claude = EvaluateClaude }

// foldCase compares paths case-insensitively, as macOS and Windows file
// systems do by default.
var foldCase = runtime.GOOS != "linux"

// homeDir is where ~ points; a variable so tests can pin it.
var homeDir = func() string { h, _ := os.UserHomeDir(); return h }

// builtins always run in allowlist mode: they are part of the shell, not programs.
var builtins = map[string]bool{
	"cd": true, "pwd": true, "echo": true, "printf": true, "export": true, "unset": true,
	"set": true, "true": true, "false": true, "test": true, "[": true, "[[": true, "]]": true,
	"source": true, ".": true, "read": true, "exit": true, "return": true, "shift": true,
	"alias": true, "type": true, "wait": true, "local": true, "declare": true, "if": true,
	"then": true, "else": true, "elif": true, "fi": true, "for": true, "while": true,
	"until": true, "do": true, "done": true, "case": true, "esac": true, "in": true,
	"function": true, "{": true, "}": true, "!": true, "trap": true, "umask": true,
	"pushd": true, "popd": true, "dirs": true, "hash": true, "ulimit": true, "eval": true,
	"command": true, "builtin": true, "exec": true, "time": true,
}

var pathTools = map[string]bool{
	"Read": true, "Write": true, "Edit": true, "MultiEdit": true, "NotebookEdit": true,
	"NotebookRead": true, "LS": true, "Glob": true, "Grep": true,
}

// EvaluateClaude checks one Claude Code tool call against the agent's rule.
//
// What it checks, by tool:
//   - Bash: every program the command runs (exec_deny, or exec_allow in
//     allowlist mode, matched by program name), files it names or redirects
//     to (file_deny / file_alert, path suffixes), and hosts or IPs it names
//     (domain_deny, network_deny, network_allow).
//   - Read, Write, Edit, …: the path (file_deny / file_alert).
//   - WebFetch: the URL's host (domain_deny, network_deny, network_allow).
//
// In denylist and allowlist mode a match is denied; in monitor and learn
// mode it is only reported (would_block). A call that no deny list matches
// but an approval list does (exec_approve, command_approve, tool_approve, …)
// returns Approve in the enforcing modes: the daemon asks an approver.
func EvaluateClaude(rule policy.Rule, in ClaudeInput) Decision {
	var f finding
	for _, p := range rule.ToolDeny {
		if textMatch(p, in.ToolName) {
			f = finding{reason: "the " + in.ToolName + " tool is not allowed", kind: "tool", target: Summary(in), rule: "tool_deny"}
			break
		}
	}
	switch {
	case f.reason != "":
	case in.ToolName == "Bash":
		f = checkCommand(rule, str(in.ToolInput, "command"), in.Cwd)
	case pathTools[in.ToolName]:
		for _, k := range []string{"file_path", "notebook_path", "path"} {
			if p := str(in.ToolInput, k); p != "" {
				f = f.or(checkPath(rule, resolve(p, in.Cwd)))
			}
		}
	case in.ToolName == "WebFetch":
		if u, err := url.Parse(str(in.ToolInput, "url")); err == nil {
			f = checkHost(rule, u.Hostname())
		}
	}

	if f.reason == "" {
		if a := checkApproval(rule, in); a.reason != "" {
			if enforcing(rule) {
				return Decision{Approve: true, Report: "approval", Kind: a.kind, Target: a.target, Rule: a.rule,
					Reason: a.reason}
			}
			return Decision{Report: "would_block", Kind: a.kind, Target: a.target, Rule: a.rule,
				Reason: "Effigent policy would ask for approval: " + a.reason}
		}
	}

	switch {
	case f.reason != "" && enforcing(rule):
		return Decision{Deny: true, Report: "blocked", Kind: f.kind, Target: f.target, Rule: f.rule,
			Reason: "Blocked by Effigent: " + f.reason + ". This is your organization's policy; ask your IT team if you need it."}
	case f.reason != "":
		return Decision{Report: "would_block", Kind: f.kind, Target: f.target, Rule: f.rule,
			Reason: "Effigent policy would block this: " + f.reason}
	case f.alert != "":
		return Decision{Report: "file_open", Kind: "file_open", Target: f.alert, Rule: "file_alert",
			Reason: "sensitive file " + f.alert}
	}
	return Decision{}
}

func enforcing(r policy.Rule) bool { return r.Mode == policy.Denylist || r.Mode == policy.Allowlist }

// finding is the first policy match in a tool call.
type finding struct {
	reason string // set when the call matches a deny rule
	kind   string // exec | file_open | connect
	target string
	rule   string // the policy list that matched
	alert  string // a file_alert path, when nothing was denied
}

func (f finding) or(g finding) finding {
	if f.reason != "" {
		return f
	}
	if g.reason != "" {
		return g
	}
	if f.alert == "" {
		f.alert = g.alert
	}
	return f
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func checkCommand(rule policy.Rule, line, cwd string) finding {
	var f finding
	for _, c := range splitShell(line) {
		args, wrappers := unwrap(c.args)
		for _, w := range wrappers {
			if !builtins[progName(w)] {
				f = f.or(checkProgram(rule, w))
			}
		}
		if len(args) > 0 {
			f = f.or(checkProgram(rule, args[0]))
			args = args[1:]
		}
		for _, w := range append(args, c.redirects...) {
			f = f.or(checkWord(rule, w, cwd))
		}
		if f.reason != "" {
			return f
		}
	}
	return f
}

func checkProgram(rule policy.Rule, prog string) finding {
	name := progName(prog)
	for _, d := range rule.ExecDeny {
		if progName(d) == name {
			return finding{reason: "running " + name + " is not allowed", kind: "exec", target: "exec " + prog, rule: "exec_deny"}
		}
	}
	if rule.Mode == policy.Allowlist && !builtins[name] {
		for _, a := range rule.ExecAllow {
			if progName(a) == name {
				return finding{}
			}
		}
		return finding{reason: name + " is not on the list of programs agents may run", kind: "exec", target: "exec " + prog, rule: "exec_allow"}
	}
	return finding{}
}

// checkWord checks one argument as a path and as a host.
func checkWord(rule policy.Rule, w, cwd string) finding {
	if w == "" {
		return finding{}
	}
	var f finding
	cands := []string{w}
	if eq := strings.IndexByte(w, '='); eq > 0 && eq < len(w)-1 {
		cands = append(cands, w[eq+1:]) // --config=/path, KEY=value
	}
	for _, c := range cands {
		f = f.or(checkPath(rule, resolve(c, cwd)))
		if h := hostIn(c); h != "" {
			f = f.or(checkHost(rule, h))
		}
	}
	return f
}

// resolve makes p absolute: ~ and $HOME become the home directory, relative
// paths are taken from cwd.
func resolve(p, cwd string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	for _, pre := range []string{"~", "$HOME", "${HOME}"} {
		if p == pre || strings.HasPrefix(p, pre+"/") {
			p = strings.ReplaceAll(homeDir(), `\`, "/") + p[len(pre):]
			break
		}
	}
	if !strings.HasPrefix(p, "/") && !isDrive(p) && cwd != "" {
		p = strings.ReplaceAll(cwd, `\`, "/") + "/" + p
	}
	return path.Clean(p)
}

func isDrive(p string) bool { return len(p) >= 2 && p[1] == ':' }

// checkPath matches a path against file_deny and file_alert. Besides the
// file itself it catches a directory that holds a listed file (cp -r ~/.ssh)
// and a glob that would expand to one (cat ~/.ssh/id_*).
func checkPath(rule policy.Rule, p string) finding {
	if p == "" || p == "." {
		return finding{}
	}
	if s := matchSuffix(rule.FileDeny, p); s != "" {
		return finding{reason: "access to " + s + " files is not allowed", kind: "file_open", target: p, rule: "file_deny"}
	}
	if matchSuffix(rule.FileAlert, p) != "" {
		return finding{alert: p}
	}
	return finding{}
}

func matchSuffix(list []string, p string) string {
	if foldCase {
		p = strings.ToLower(p)
	}
	glob := strings.ContainsAny(p, "*?[")
	for _, s := range list {
		s = strings.ReplaceAll(s, `\`, "/")
		if foldCase {
			s = strings.ToLower(s)
		}
		if s == "" {
			continue
		}
		if !strings.HasPrefix(s, "/") {
			s = "/" + s
		}
		if strings.HasSuffix(p, s) {
			return s
		}
		// a directory holding the file: every leading part of s that names
		// at least one directory (/.ssh for /.ssh/id_rsa; nothing for /.env)
		for i := len(s) - 1; i > 0; i-- {
			if s[i] == '/' && strings.HasSuffix(p, s[:i]) {
				return s
			}
		}
		if glob {
			dir, base := path.Split(p)
			sdir, sbase := path.Split(s)
			if strings.HasSuffix(strings.TrimSuffix(dir, "/"), strings.TrimSuffix(sdir, "/")) {
				// like the shell, a pattern matches a dotfile only if it starts with a dot
				if ok, _ := path.Match(base, sbase); ok && (sbase[0] != '.' || strings.HasPrefix(base, ".")) {
					return s
				}
			}
		}
	}
	return ""
}

// hostIn returns the host a word names: a URL's host, user@host, host:path
// (scp/git), or a bare name with a dot such as example.com. "" if none.
func hostIn(w string) string {
	if i := strings.Index(w, "://"); i > 0 {
		if u, err := url.Parse(w); err == nil {
			return strings.ToLower(u.Hostname())
		}
		return ""
	}
	if net.ParseIP(w) != nil {
		return w
	}
	if at := strings.LastIndexByte(w, '@'); at >= 0 {
		w = w[at+1:]
	}
	if i := strings.IndexAny(w, "/:"); i >= 0 {
		if host, port, err := net.SplitHostPort(w); err == nil && port != "" && !strings.Contains(port, "/") {
			w = host
		} else {
			w = w[:i]
		}
	}
	w = strings.ToLower(strings.TrimSuffix(w, "."))
	if net.ParseIP(w) != nil {
		return w
	}
	if !strings.Contains(w, ".") || strings.HasPrefix(w, ".") || strings.HasPrefix(w, "-") {
		return ""
	}
	for _, r := range w {
		if !(r == '.' || r == '-' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9') {
			return ""
		}
	}
	// the last label must be letters (rules out versions and file names like a.1)
	tld := w[strings.LastIndexByte(w, '.')+1:]
	if len(tld) < 2 {
		return ""
	}
	for _, r := range tld {
		if r < 'a' || r > 'z' {
			return ""
		}
	}
	return w
}

// checkHost matches a hostname or IP against domain_deny (the name and its
// subdomains), network_deny and network_allow.
func checkHost(rule policy.Rule, host string) finding {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" {
		return finding{}
	}
	if ip := net.ParseIP(host); ip != nil {
		if inNets(rule.NetDeny, ip) {
			return finding{reason: "connections to " + host + " are not allowed", kind: "connect", target: host, rule: "network_deny"}
		}
		if len(rule.NetAllow) > 0 && !ip.IsLoopback() && !inNets(rule.NetAllow, ip) {
			return finding{reason: host + " is not on the list of allowed addresses", kind: "connect", target: host, rule: "network_allow"}
		}
		return finding{}
	}
	for _, d := range rule.DomainDeny {
		d = strings.ToLower(strings.TrimSuffix(d, "."))
		if d != "" && (host == d || strings.HasSuffix(host, "."+d)) {
			return finding{reason: "connections to " + d + " are not allowed", kind: "connect", target: host, rule: "domain_deny"}
		}
	}
	return finding{}
}

func inNets(list []string, ip net.IP) bool {
	for _, s := range list {
		if !strings.Contains(s, "/") {
			if net.ParseIP(s).Equal(ip) {
				return true
			}
			continue
		}
		if _, n, err := net.ParseCIDR(s); err == nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// checkApproval matches a tool call against the approval lists. Programs,
// files and hosts reuse the deny matchers on a view of the rule whose deny
// lists are the approval lists, so both match the same way.
func checkApproval(rule policy.Rule, in ClaudeInput) finding {
	if !rule.NeedsApproval() {
		return finding{}
	}
	view := policy.Rule{Mode: policy.Denylist, ExecDeny: rule.ExecApprove, FileDeny: rule.FileApprove,
		DomainDeny: rule.DomainApprove, NetDeny: rule.NetApprove}
	var f finding
	for _, p := range rule.ToolApprove {
		if textMatch(p, in.ToolName) {
			return finding{reason: "the " + in.ToolName + " tool needs approval", kind: "tool", target: Summary(in), rule: "tool_approve"}
		}
	}
	switch {
	case in.ToolName == "Bash":
		line := str(in.ToolInput, "command")
		for _, c := range splitShell(line) {
			args, _ := unwrap(c.args)
			if len(args) == 0 {
				continue
			}
			cmd := strings.Join(append([]string{progName(args[0])}, args[1:]...), " ")
			for _, p := range rule.CommandApprove {
				if textMatch(p, cmd) {
					return finding{reason: "`" + clip(cmd, 80) + "` needs approval", kind: "exec", target: "exec " + clip(cmd, 200), rule: "command_approve"}
				}
			}
		}
		f = checkCommand(view, line, in.Cwd)
	case pathTools[in.ToolName]:
		for _, k := range []string{"file_path", "notebook_path", "path"} {
			if p := str(in.ToolInput, k); p != "" {
				f = f.or(checkPath(view, resolve(p, in.Cwd)))
			}
		}
	case in.ToolName == "WebFetch":
		if u, err := url.Parse(str(in.ToolInput, "url")); err == nil {
			f = checkHost(view, u.Hostname())
		}
	}
	if f.reason == "" {
		return finding{}
	}
	f.rule = strings.Replace(f.rule, "_deny", "_approve", 1)
	f.reason = strings.Replace(f.reason, " is not allowed", " needs approval", 1)
	f.reason = strings.Replace(f.reason, " are not allowed", " need approval", 1)
	return f
}

// textMatch: exact, or a prefix when the pattern ends in "*" (case-sensitive,
// like the central policy's matcher).
func textMatch(pattern, s string) bool {
	if p, ok := strings.CutSuffix(pattern, "*"); ok {
		return strings.HasPrefix(s, p)
	}
	return pattern == s
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
