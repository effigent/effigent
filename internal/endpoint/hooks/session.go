package hooks

import (
	"net"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// Session rules: deterministic sequences inside one agent session, kept by
// the daemon (Sessions) and read by classify through ClaudeInput.History.
// They are pattern matching over what the hook saw, not prompt-injection
// detection:
//
//   - exfil_sequence: a credential read (credential_read, or a file_alert
//     match) earlier in the window, or in the same call, then a network call
//     (WebFetch, curl/wget/nc/ssh/scp/rsync/git push…) to a host the session
//     hasn't contacted before.
//   - untrusted_then_risky: content from outside the machine earlier in the
//     window (WebFetch, WebSearch, an MCP server outside mcp_allow — every
//     server when mcp_allow is empty —, curl/wget/http naming a host), then
//     a risky action (riskyKinds).
//
// The window is the last SessionCalls calls of the session and SessionWindow.
const (
	SessionWindow = 30 * time.Minute
	SessionCalls  = 50
	// sessionTTL drops a session nobody has used for this long; maxSessions
	// caps the table (the least recently used goes first).
	sessionTTL   = 2 * time.Hour
	maxSessions  = 2000
	maxHostsSeen = 256
)

// riskyKinds are the actions untrusted_then_risky looks for.
var riskyKinds = []string{"fs_destroy", "destructive_sql", "cloud_destroy", "force_push", "guardrail_edit", "remote_script", "credential_read"}

// History is what earlier calls of the same session did, within the window
// (a snapshot; set by the daemon).
type History struct {
	Secret    string          // the latest credential read ("" if none in the window)
	Untrusted string          // the latest outside content
	Hosts     map[string]bool // hosts the session contacted (allowed calls)
}

// Seen is what one call contributes to its session's history, recorded by
// the daemon only if the call ran (it wasn't denied).
type Seen struct {
	Hosts     []string // hosts the call contacts
	Untrusted string   // where outside content came from ("WebFetch example.com")
	Secret    string   // the credential it reads
}

func (s Seen) merge(o Seen) Seen {
	for _, h := range o.Hosts {
		if !slices.Contains(s.Hosts, h) {
			s.Hosts = append(s.Hosts, h)
		}
	}
	if s.Untrusted == "" {
		s.Untrusted = o.Untrusted
	}
	if s.Secret == "" {
		s.Secret = o.Secret
	}
	return s
}

type mark struct {
	at   time.Time
	n    int // call number in the session
	what string
}

type session struct {
	last      time.Time
	n         int
	secret    mark
	untrusted mark
	hosts     map[string]bool
}

// Sessions holds the per-session state of the session rules.
type Sessions struct {
	mu  sync.Mutex
	m   map[string]*session
	now func() time.Time
}

func NewSessions() *Sessions { return &Sessions{m: map[string]*session{}, now: time.Now} }

func (s *Sessions) inWindow(m mark, cur *session, now time.Time) bool {
	return m.what != "" && now.Sub(m.at) <= SessionWindow && cur.n-m.n < SessionCalls
}

// History returns the session's state for the next call (nil for a call
// without a session id).
func (s *Sessions) History(key string) *History {
	if s == nil || strings.HasSuffix(key, "/") || key == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.m[key]
	if cur == nil {
		return &History{}
	}
	now := s.now()
	h := &History{Hosts: make(map[string]bool, len(cur.hosts))}
	for k := range cur.hosts {
		h.Hosts[k] = true
	}
	if s.inWindow(cur.secret, cur, now) {
		h.Secret = cur.secret.what
	}
	if s.inWindow(cur.untrusted, cur, now) {
		h.Untrusted = cur.untrusted.what
	}
	return h
}

// Record adds one call to the session. ran says whether the call ran (not
// denied); a denied call only counts toward the window.
func (s *Sessions) Record(key string, seen Seen, ran bool) {
	if s == nil || strings.HasSuffix(key, "/") || key == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	cur := s.m[key]
	if cur == nil {
		s.evict(now)
		cur = &session{hosts: map[string]bool{}}
		s.m[key] = cur
	}
	cur.last = now
	cur.n++
	if !ran {
		return
	}
	for _, h := range seen.Hosts {
		if len(cur.hosts) < maxHostsSeen {
			cur.hosts[h] = true
		}
	}
	if seen.Secret != "" {
		cur.secret = mark{at: now, n: cur.n, what: seen.Secret}
	}
	if seen.Untrusted != "" {
		cur.untrusted = mark{at: now, n: cur.n, what: seen.Untrusted}
	}
}

// evict drops idle sessions, and the least recently used one when full.
func (s *Sessions) evict(now time.Time) {
	for k, v := range s.m {
		if now.Sub(v.last) > sessionTTL {
			delete(s.m, k)
		}
	}
	for len(s.m) >= maxSessions {
		var oldest string
		var t time.Time
		for k, v := range s.m {
			if oldest == "" || v.last.Before(t) {
				oldest, t = k, v.last
			}
		}
		delete(s.m, oldest)
	}
}

// Len is the number of sessions held (tests, stats).
func (s *Sessions) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// netPrograms contact the hosts named in their arguments.
var netPrograms = map[string]bool{"curl": true, "wget": true, "nc": true, "ncat": true, "netcat": true, "socat": true,
	"ssh": true, "scp": true, "sftp": true, "rsync": true, "ftp": true, "telnet": true, "http": true, "https": true,
	"xh": true, "aria2c": true, "git": true}

// fetchPrograms bring content from the host they name into the session.
var fetchPrograms = map[string]bool{"curl": true, "wget": true, "http": true, "https": true, "xh": true, "aria2c": true}

// observe works out what this call contributes to the session (hosts it
// contacts, outside content, credential reads) and, from the session's
// history, adds exfil_sequence and untrusted_then_risky.
func (x *actx) observe() {
	in := x.in
	switch {
	case in.ToolName == "Bash":
		for _, c := range x.f.cmds {
			args := program(c.args)
			if len(args) == 0 {
				continue
			}
			prog := progName(args[0])
			if !netPrograms[prog] {
				continue
			}
			if prog == "git" && !slices.ContainsFunc(args[1:], func(a string) bool {
				return a == "push" || a == "fetch" || a == "pull" || a == "clone" || a == "ls-remote"
			}) {
				continue
			}
			for _, w := range args[1:] {
				if h := netHost(w); h != "" {
					x.f.seen.Hosts = appendNew(x.f.seen.Hosts, h)
					if fetchPrograms[prog] && x.f.seen.Untrusted == "" {
						x.f.seen.Untrusted = prog + " " + h
					}
				}
			}
		}
	case in.ToolName == "WebFetch":
		if u, err := url.Parse(str(in.ToolInput, "url")); err == nil {
			if h := netHost(u.Hostname()); h != "" {
				x.f.seen.Hosts = appendNew(x.f.seen.Hosts, h)
				x.f.seen.Untrusted = "WebFetch " + h
			}
		}
	case in.ToolName == "WebSearch":
		x.f.seen.Untrusted = "WebSearch"
	case strings.HasPrefix(in.ToolName, "mcp__"):
		if server := mcpServer(in.ToolName); server != "" &&
			!slices.ContainsFunc(x.rule.MCPAllow, func(p string) bool { return wild(p, server) }) {
			x.f.seen.Untrusted = "MCP " + server
		}
	}
	for _, a := range x.f.actions {
		if a.Kind == "credential_read" && x.f.seen.Secret == "" {
			x.f.seen.Secret = a.Target
		}
	}

	h := in.History
	if h == nil {
		return // no session to compare with
	}
	secret := h.Secret
	if secret == "" {
		secret = x.f.seen.Secret // read and sent in one command
	}
	if secret != "" {
		for _, host := range x.f.seen.Hosts {
			if !h.Hosts[host] {
				x.add(event.Action{Kind: "exfil_sequence", Target: host + " after reading " + clip(secret, 80),
					Attrs: map[string]string{"host": host, "after": clip(secret, 200)}})
				break
			}
		}
	}
	if h.Untrusted != "" {
		for _, a := range x.f.actions {
			if !slices.Contains(riskyKinds, a.Kind) {
				continue
			}
			attrs := map[string]string{"after": clip(h.Untrusted, 200), "kind": a.Kind}
			for k, v := range a.Attrs {
				if _, ok := attrs[k]; !ok {
					attrs[k] = v
				}
			}
			x.add(event.Action{Kind: "untrusted_then_risky", Target: kindLabel[a.Kind] + " (" + clip(a.Target, 80) + ") after " + clip(h.Untrusted, 80),
				Attrs: attrs, In: a.In})
			break
		}
	}
}

// netHost is a host a network call reaches, "" for none or loopback.
func netHost(w string) string {
	h := hostIn(w)
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return ""
	}
	if ip := net.ParseIP(h); ip != nil && (ip.IsLoopback() || ip.IsUnspecified()) {
		return ""
	}
	return h
}

func appendNew(list []string, s string) []string {
	if slices.Contains(list, s) {
		return list
	}
	return append(list, s)
}
