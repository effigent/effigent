// Package inventory is the control plane's view of what runs where: the
// agents and MCP servers seen per machine, the people who pay for an AI tool
// but have no managed machine, and behaviour baselines ("first seen"
// signals). It is pure: the store feeds it events and rows, nothing here
// reads the database.
package inventory

import (
	"encoding/json"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Baselines are novelty detection, not prompt-injection detection: for each
// machine and agent, the binaries it ran, the hosts it reached, the MCP
// servers it used and the action kinds it hit. A value the agent hasn't
// shown on that machine in the last Window is "first seen", once the agent
// has been seen there for at least Warmup (before that everything is new).
const (
	Window = 30 * 24 * time.Hour
	Warmup = 7 * 24 * time.Hour
	// DailySignalCap: at most this many first-seen signals per machine,
	// agent and kind per UTC day; the rest are counted (suppressed).
	DailySignalCap = 50
	// MaxValueLen clips stored values.
	MaxValueLen = 300
)

// Kinds of baseline values and how many distinct values one machine+agent
// keeps per kind. Past the cap a key stops learning and stops signalling
// (new values are counted as overflow).
const (
	KindBinary = "binary"
	KindHost   = "host"
	KindMCP    = "mcp"
	KindAction = "action"
)

var Kinds = []string{KindBinary, KindHost, KindMCP, KindAction}

var Caps = map[string]int{KindBinary: 2000, KindHost: 1000, KindMCP: 200, KindAction: 200}

// Event is one ingested event, as the store has it.
type Event struct {
	Time  time.Time
	Type  string
	Agent string
	Body  json.RawMessage
}

// Seen is one value an agent showed in a batch (deduplicated: the earliest
// time, how many events).
type Seen struct {
	Agent     string    `json:"agent"`
	Kind      string    `json:"kind"`
	Value     string    `json:"value"`
	At        time.Time `json:"at"`
	EventType string    `json:"event_type"`
	Count     int64     `json:"count"`
}

type body struct {
	Kind    string           `json:"kind"`
	Target  string           `json:"target"`
	Via     string           `json:"via"`
	Process *json.RawMessage `json:"process"`
	Actions []struct {
		Kind string   `json:"kind"`
		Envs []string `json:"envs"`
	} `json:"actions"`
}

// observed event types: what an agent did or tried (exits, policy loads and
// agent starts are not behaviour).
var observed = map[string]bool{"exec": true, "connect": true, "file_open": true, "blocked": true, "would_block": true,
	"approval_pending": true, "approved": true, "approval_denied": true}

// Extract reads a batch's events into baseline values.
func Extract(evs []Event) []Seen {
	type key struct{ agent, kind, value string }
	m := map[key]*Seen{}
	add := func(e Event, kind, v string) {
		v = strings.TrimSpace(v)
		if v == "" {
			return
		}
		if len(v) > MaxValueLen {
			v = strings.ToValidUTF8(v[:MaxValueLen], "") // never split a rune: Postgres refuses invalid UTF-8
		}
		k := key{e.Agent, kind, v}
		if s := m[k]; s != nil {
			s.Count++
			if e.Time.Before(s.At) {
				s.At, s.EventType = e.Time, e.Type
			}
			return
		}
		m[k] = &Seen{Agent: e.Agent, Kind: kind, Value: v, At: e.Time, EventType: e.Type, Count: 1}
	}
	for _, e := range evs {
		if e.Agent == "" || strings.HasPrefix(e.Agent, "mcp:") || !observed[e.Type] {
			continue
		}
		var b body
		if json.Unmarshal(e.Body, &b) != nil {
			continue
		}
		kernel := b.Process != nil
		if strings.HasPrefix(b.Via, "mcp:") {
			add(e, KindMCP, strings.TrimPrefix(b.Via, "mcp:"))
		}
		for _, a := range b.Actions {
			if a.Kind == "" {
				continue
			}
			add(e, KindAction, a.Kind)
			for _, env := range a.Envs {
				if env != "" {
					add(e, KindAction, a.Kind+"@"+env)
				}
			}
		}
		if kernel {
			t := b.Target
			switch {
			case e.Type == "exec" && b.Kind != "agent":
				add(e, KindBinary, t)
			case strings.HasPrefix(t, "exec "): // a kernel block of an exec
				add(e, KindBinary, strings.TrimPrefix(t, "exec "))
			case e.Type == "connect" || strings.HasPrefix(t, "connect "):
				if h := hostOf(strings.TrimPrefix(t, "connect ")); h != "" {
					add(e, KindHost, h)
				}
			}
			continue
		}
		tool, arg, _ := strings.Cut(b.Target, ": ")
		switch {
		case strings.HasPrefix(tool, "mcp__"):
			if s, _, _ := strings.Cut(strings.TrimPrefix(tool, "mcp__"), "__"); s != "" {
				add(e, KindMCP, s)
			}
		case tool == "Bash":
			for _, p := range Programs(arg) {
				add(e, KindBinary, p)
			}
			for _, h := range urlHosts(arg) {
				add(e, KindHost, h)
			}
		case tool == "WebFetch":
			for _, h := range urlHosts(arg) {
				add(e, KindHost, h)
			}
		}
	}
	out := make([]Seen, 0, len(m))
	for _, s := range m {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Agent != b.Agent {
			return a.Agent < b.Agent
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Value < b.Value
	})
	return out
}

// hostOf is the address of a kernel "ip:port" target; loopback is not
// behaviour.
func hostOf(t string) string {
	h, _, err := net.SplitHostPort(t)
	if err != nil {
		h = t
	}
	return cleanHost(h)
}

func cleanHost(h string) string {
	h = strings.ToLower(strings.Trim(strings.TrimSpace(h), "[]."))
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return ""
	}
	if ip := net.ParseIP(h); ip != nil && (ip.IsLoopback() || ip.IsUnspecified()) {
		return ""
	}
	return h
}

var urlRe = regexp.MustCompile(`(?i)\b(?:https?|wss?|ftp)://[^\s'"<>()|;&]+`)

// urlHosts lists the hostnames of the URLs in a command or tool argument.
func urlHosts(s string) []string {
	var out []string
	for _, raw := range urlRe.FindAllString(s, 20) {
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		if h := cleanHost(u.Hostname()); h != "" && !strings.ContainsAny(h, "$*{}") {
			out = append(out, h)
		}
	}
	return out
}

// wrappers run the command that follows them.
var wrappers = map[string]bool{"sudo": true, "env": true, "nohup": true, "time": true, "exec": true, "command": true,
	"builtin": true, "nice": true, "ionice": true, "stdbuf": true, "xargs": true, "doas": true, "caffeinate": true}

// shell words that aren't programs
var keywords = map[string]bool{"if": true, "then": true, "else": true, "elif": true, "fi": true, "for": true, "do": true,
	"done": true, "while": true, "until": true, "case": true, "esac": true, "in": true, "function": true, "select": true,
	"{": true, "}": true, "!": true, "[[": true, "]]": true, "[": true, "time": true, "coproc": true}

var progRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)

// Programs is a small reading of a shell command line: the program name
// (basename) of each simple command, after variable assignments and
// wrappers such as sudo or env. It does not follow scripts, aliases or
// variables; a word that doesn't look like a program name is skipped.
func Programs(cmd string) []string {
	cmd = strings.TrimSuffix(cmd, "…")
	var out []string
	seen := map[string]bool{}
	for _, seg := range splitCommands(cmd) {
		words := strings.Fields(seg)
		for i := 0; i < len(words); i++ {
			w := strings.Trim(words[i], `"'`)
			if w == "for" || w == "select" || w == "case" || strings.HasPrefix(w, "$") {
				break // a loop/case header, or a program named by a variable: not read
			}
			switch {
			case w == "" || keywords[w]:
				continue
			case strings.Contains(w, "=") && !strings.HasPrefix(w, "="): // FOO=bar
				continue
			case strings.HasPrefix(w, "-"): // a wrapper's option (sudo -u x, env -i)
				continue
			}
			name := w
			if j := strings.LastIndex(name, "/"); j >= 0 {
				name = name[j+1:]
			}
			if wrappers[name] {
				continue
			}
			if progRe.MatchString(name) && !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
			break
		}
	}
	return out
}

// splitCommands splits on the shell's command separators outside quotes:
// ; & | newlines, ( ) and $( / backticks.
func splitCommands(s string) []string {
	var (
		out   []string
		cur   strings.Builder
		quote rune
	)
	flush := func() {
		if t := strings.TrimSpace(cur.String()); t != "" {
			out = append(out, t)
		}
		cur.Reset()
	}
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
			cur.WriteRune(r)
		case r == '\'' || r == '"':
			quote = r
			cur.WriteRune(r)
		case r == '\\' && i+1 < len(rs):
			cur.WriteRune(rs[i+1])
			i++
		case r == ';' || r == '&' || r == '|' || r == '\n' || r == '(' || r == ')' || r == '`':
			flush()
		case r == '$' && i+1 < len(rs) && rs[i+1] == '(':
			flush()
			i++
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}

// KeyState is what the store knows of one machine+agent+kind baseline.
type KeyState struct {
	Values     int       // distinct values kept
	SignalsDay time.Time // UTC day the Signals count is for
	Signals    int
}

// Decision is what to do with one Seen value.
type Decision struct {
	Seen
	Store    bool       // insert or update the value (false: the key is at its cap)
	Signal   bool       // a first-seen signal
	PrevLast *time.Time // when it was last seen before (nil: never)
}

// KeyKey names a baseline key.
func KeyKey(agent, kind string) string { return agent + "\x00" + kind }

// ValueKey names a baseline value.
func ValueKey(agent, kind, value string) string { return agent + "\x00" + kind + "\x00" + value }

// Decide classifies a batch's values. agentFirst is when each agent was
// first seen on the machine (warm-up), keys the per-kind state (updated in
// place: values added, signals counted), last when each known value was
// last seen. Returned are the decisions, plus per key the values that
// didn't fit (overflow) and the signals over the daily cap (suppressed).
func Decide(seen []Seen, agentFirst map[string]time.Time, keys map[string]*KeyState, last map[string]time.Time) (out []Decision, overflow, suppressed map[string]int64) {
	overflow, suppressed = map[string]int64{}, map[string]int64{}
	for _, s := range seen {
		kk := KeyKey(s.Agent, s.Kind)
		ks := keys[kk]
		if ks == nil {
			ks = &KeyState{}
			keys[kk] = ks
		}
		d := Decision{Seen: s, Store: true}
		prev, known := last[ValueKey(s.Agent, s.Kind, s.Value)]
		switch {
		case known:
			p := prev
			d.PrevLast = &p
			d.Signal = s.At.Sub(prev) > Window
		case ks.Values >= Caps[s.Kind]:
			d.Store = false
			overflow[kk] += s.Count
		default:
			ks.Values++
			d.Signal = true
		}
		if first, ok := agentFirst[s.Agent]; d.Signal && (!ok || s.At.Sub(first) < Warmup) {
			d.Signal = false // still learning this agent on this machine
		}
		if d.Signal {
			day := s.At.UTC().Truncate(24 * time.Hour)
			if !ks.SignalsDay.Equal(day) {
				ks.SignalsDay, ks.Signals = day, 0
			}
			if ks.Signals >= DailySignalCap {
				d.Signal = false
				suppressed[kk]++
			} else {
				ks.Signals++
			}
		}
		out = append(out, d)
	}
	return out, overflow, suppressed
}
