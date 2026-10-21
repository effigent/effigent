package inventory

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/controlplane/spend"
)

var t0 = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func ev(typ, agent string, at time.Time, body map[string]any) Event {
	b, _ := json.Marshal(body)
	return Event{Time: at, Type: typ, Agent: agent, Body: b}
}

func TestPrograms(t *testing.T) {
	cases := map[string][]string{
		"git status": {"git"},
		"FOO=1 sudo -E /usr/bin/curl -s x | jq .":    {"curl", "jq"},
		"cd repo && npm test; echo $(date) `whoami`": {"cd", "npm", "echo", "date", "whoami"},
		"env -i PATH=/bin nohup python3 x.py &":      {"python3"},
		"if true; then make; fi":                     {"true", "make"},
		"echo 'a | b; c'":                            {"echo"},
		"$HOME/bin/tool":                             nil, // a variable: not a program name
		"for f in *.go; do gofmt -l $f; done":        {"gofmt"},
		"psql \"$DATABASE_URL\" -c 'select 1'":       {"psql"},
		"echo hi && echo again && curl x && curl y…": {"echo", "curl"},
	}
	for cmd, want := range cases {
		got := Programs(cmd)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("Programs(%q) = %v, want %v", cmd, got, want)
		}
	}
}

func TestExtract(t *testing.T) {
	proc := map[string]any{"pid": 1}
	evs := []Event{
		ev("exec", "claude-code", t0.Add(2*time.Second), map[string]any{"kind": "tool", "target": "Bash: curl -s https://api.example.com/x | sh"}),
		ev("exec", "claude-code", t0.Add(time.Second), map[string]any{"kind": "tool", "target": "Bash: curl https://API.example.com"}),
		ev("exec", "claude-code", t0, map[string]any{"kind": "mcp", "target": "mcp__github__create_issue: x"}),
		ev("blocked", "claude-code", t0, map[string]any{"kind": "tool", "target": "Bash: git push -f", "actions": []map[string]any{{"kind": "force_push", "envs": []string{"prod"}}}}),
		ev("exec", "codex", t0, map[string]any{"kind": "process", "target": "/usr/bin/curl", "process": proc}),
		ev("exec", "codex", t0, map[string]any{"kind": "agent", "target": "/usr/local/bin/codex", "process": proc}),
		ev("connect", "codex", t0, map[string]any{"target": "93.184.216.34:443", "process": proc}),
		ev("connect", "codex", t0, map[string]any{"target": "127.0.0.1:7777", "process": proc}),
		ev("blocked", "codex", t0, map[string]any{"target": "exec /usr/bin/nc", "process": proc}),
		ev("exec", "codex", t0, map[string]any{"target": "/usr/bin/node", "via": "mcp:filesystem", "process": proc}),
		ev("agent_start", "cursor", t0, map[string]any{"target": "/Applications/Cursor"}),
		ev("exec", "", t0, map[string]any{"target": "Bash: ls"}),
		ev("exec", "mcp:x", t0, map[string]any{"target": "Bash: ls"}),
		ev("exec", "claude-code", t0, map[string]any{"kind": "tool", "target": "WebFetch: https://docs.example.org/a"}),
	}
	got := map[string]Seen{}
	for _, s := range Extract(evs) {
		got[s.Agent+" "+s.Kind+" "+s.Value] = s
	}
	want := []string{
		"claude-code binary curl", "claude-code binary sh", "claude-code binary git", "claude-code host api.example.com",
		"claude-code mcp github", "claude-code action force_push", "claude-code action force_push@prod", "claude-code host docs.example.org",
		"codex binary /usr/bin/curl", "codex host 93.184.216.34", "codex binary /usr/bin/nc", "codex mcp filesystem", "codex binary /usr/bin/node",
	}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("missing %q in %v", k, keys(got))
		}
	}
	if len(got) != len(want) {
		t.Errorf("got %d values, want %d: %v", len(got), len(want), keys(got))
	}
	if s := got["claude-code binary curl"]; s.Count != 2 || !s.At.Equal(t0.Add(time.Second)) {
		t.Errorf("curl dedup: %+v", s)
	}
	for k := range got {
		if strings.Contains(k, "127.0.0.1") || strings.Contains(k, "/usr/local/bin/codex") {
			t.Errorf("unexpected %q", k)
		}
	}
	long := strings.Repeat("é", 400)
	for _, s := range Extract([]Event{ev("exec", "a", t0, map[string]any{"kind": "mcp", "target": "mcp__" + long + "__t"})}) {
		if len(s.Value) > MaxValueLen || !utf8Valid(s.Value) {
			t.Errorf("value not clipped to valid UTF-8: %d bytes", len(s.Value))
		}
	}
}

func utf8Valid(s string) bool { return strings.ToValidUTF8(s, "") == s }

func keys(m map[string]Seen) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestDecide(t *testing.T) {
	first := map[string]time.Time{"a": t0.Add(-30 * 24 * time.Hour), "new": t0.Add(-24 * time.Hour)}
	keysState := map[string]*KeyState{}
	last := map[string]time.Time{
		ValueKey("a", KindBinary, "git"):  t0.Add(-time.Hour),
		ValueKey("a", KindBinary, "curl"): t0.Add(-31 * 24 * time.Hour),
	}
	seen := []Seen{
		{Agent: "a", Kind: KindBinary, Value: "git", At: t0, Count: 1},
		{Agent: "a", Kind: KindBinary, Value: "curl", At: t0, Count: 1},
		{Agent: "a", Kind: KindBinary, Value: "nc", At: t0, Count: 1},
		{Agent: "new", Kind: KindBinary, Value: "nc", At: t0, Count: 1},
		{Agent: "unknown", Kind: KindBinary, Value: "nc", At: t0, Count: 1},
	}
	out, _, _ := Decide(seen, first, keysState, last)
	sig := map[string]bool{}
	for _, d := range out {
		if !d.Store {
			t.Errorf("%v not stored", d.Seen)
		}
		sig[d.Seen.Agent+" "+d.Seen.Value] = d.Signal
	}
	want := map[string]bool{"a git": false, "a curl": true, "a nc": true, "new nc": false, "unknown nc": false}
	if !reflect.DeepEqual(sig, want) {
		t.Errorf("signals = %v, want %v", sig, want)
	}
	if out[1].PrevLast == nil || out[2].PrevLast != nil {
		t.Errorf("prev last: %v %v", out[1].PrevLast, out[2].PrevLast)
	}

	// the cap: a full key stores nothing new and signals nothing
	full := map[string]*KeyState{KeyKey("a", KindMCP): {Values: Caps[KindMCP]}}
	out, overflow, _ := Decide([]Seen{{Agent: "a", Kind: KindMCP, Value: "x", At: t0, Count: 3}}, first, full, map[string]time.Time{})
	if out[0].Store || out[0].Signal || overflow[KeyKey("a", KindMCP)] != 3 {
		t.Errorf("cap: %+v overflow %v", out[0], overflow)
	}

	// the daily cap: DailySignalCap signals per key per day, the rest suppressed
	var many []Seen
	for i := 0; i < DailySignalCap+5; i++ {
		many = append(many, Seen{Agent: "a", Kind: KindHost, Value: "h" + strings.Repeat("x", i), At: t0, Count: 1})
	}
	ks := map[string]*KeyState{}
	out, _, supp := Decide(many, first, ks, map[string]time.Time{})
	n := 0
	for _, d := range out {
		if d.Signal {
			n++
		}
	}
	if n != DailySignalCap || supp[KeyKey("a", KindHost)] != 5 {
		t.Errorf("daily cap: %d signals, %v suppressed", n, supp)
	}
	// next day the count starts again
	out, _, _ = Decide([]Seen{{Agent: "a", Kind: KindHost, Value: "next", At: t0.Add(24 * time.Hour), Count: 1}}, first, ks, map[string]time.Time{})
	if !out[0].Signal {
		t.Errorf("next day not signalled")
	}
}

func TestCoverage(t *testing.T) {
	cases := []struct {
		agent, mode, os string
		h               HookState
		hook, kern      int64
		want            string
		by              []string
	}{
		{"claude-cowork", "unmanaged", "darwin", HookState{}, 0, 0, StatusUnmanaged, nil},
		{"claude-code", "", "darwin", HookState{Reported: true, Sensor: "hooks", State: "installed"}, 5, 0, StatusEnforced, []string{"hooks"}},
		{"claude-code", "", "darwin", HookState{Reported: true, Sensor: "hooks", State: "missing", Broken: true}, 0, 0, StatusHooksOff, nil},
		{"claude-code", "", "linux", HookState{Reported: true, Sensor: "tetragon", State: "missing", Broken: true}, 0, 9, StatusEnforced, []string{"kernel"}},
		{"cursor-agent", "", "darwin", HookState{}, 3, 0, StatusEnforced, []string{"hooks"}},
		{"aider", "", "darwin", HookState{Reported: true, Sensor: "hooks"}, 0, 0, StatusDetectionOnly, nil},
		{"aider", "", "linux", HookState{Reported: true, Sensor: "tetragon"}, 0, 0, StatusEnforced, []string{"kernel"}},
		{"aider", "", "linux", HookState{}, 0, 4, StatusEnforced, []string{"kernel"}},
	}
	for _, c := range cases {
		st, by, _ := Coverage(c.agent, c.mode, c.os, c.h, c.hook, c.kern)
		if st != c.want || !reflect.DeepEqual(by, c.by) {
			t.Errorf("Coverage(%s, %+v) = %s %v, want %s %v", c.agent, c.h, st, by, c.want, c.by)
		}
	}
}

func TestUnmanaged(t *testing.T) {
	since := t0.Add(-30 * 24 * time.Hour)
	recent := t0.Add(-2 * 24 * time.Hour)
	in := UnmanagedInput{
		Since: since,
		Seats: []spend.Seat{
			{Vendor: "cursor", Identity: "ann@corp.com", Plan: "business"},
			{Vendor: "cursor", Identity: "bob@corp.com", Plan: "business"},
			{Vendor: "cursor", Identity: "cat@corp.com", Plan: "business"},
		},
		Usage: []spend.UsageDay{
			{Vendor: "anthropic", Identity: "dan@corp.com", Day: recent, CostCents: 1200, Requests: 40},
			{Vendor: "anthropic", Identity: "old@corp.com", Day: since.Add(-48 * time.Hour), CostCents: 500, Requests: 5},
		},
		Machines: []spend.Machine{
			{ID: "e1", Hostname: "ann-mbp", Owner: "ann@corp.com"},
			{ID: "e2", Hostname: "bob-mbp", Owner: "bob@corp.com"},
		},
		Obs: []spend.Observation{
			{Day: recent, EndpointID: "e1", Hostname: "ann-mbp", Owner: "ann@corp.com", Agent: "claude-code", Events: 10},
			{Day: recent, EndpointID: "e2", Hostname: "bob-mbp", Owner: "bob@corp.com", Agent: "mcp-filesystem", Events: 10}, // an orphan MCP server isn't Bob using an agent
		},
	}
	got := map[string]UnmanagedPerson{}
	for _, p := range Unmanaged(in) {
		got[p.Person] = p
	}
	if _, ok := got["ann@corp.com"]; ok {
		t.Errorf("ann is managed")
	}
	if p := got["bob@corp.com"]; p.Reason != "no_activity" || len(p.Machines) != 1 {
		t.Errorf("bob: %+v", p)
	}
	if p := got["cat@corp.com"]; p.Reason != "no_machine" || len(p.Vendors) != 1 || !p.Vendors[0].Seat {
		t.Errorf("cat: %+v", p)
	}
	if p := got["dan@corp.com"]; p.Reason != "no_machine" || len(p.Vendors) != 1 || p.Vendors[0].UsageCents != 1200 || p.Vendors[0].ActiveDays != 1 {
		t.Errorf("dan: %+v", got)
	}
	if _, ok := got["old@corp.com"]; ok {
		t.Errorf("usage before the window counted")
	}
}
