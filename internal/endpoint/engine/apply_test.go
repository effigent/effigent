package engine

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

// fakeEnf renders an -lsm and a -net document per policy and refuses to load
// the documents whose suffix is in fail.
type fakeEnf struct {
	mu     sync.Mutex
	loaded []string
	fail   map[string]bool
}

func (f *fakeEnf) PolicyName(agent string, pid uint32, gen uint64) string {
	return fmt.Sprintf("eff-%s-%d-g%d", agent, pid, gen)
}

func (f *fakeEnf) Render(name string, _ uint32, _ policy.Rule) ([]Doc, error) {
	return []Doc{{Name: name + "-lsm", YAML: []byte(name + "-lsm")}, {Name: name + "-net", YAML: []byte(name + "-net")}}, nil
}

func (f *fakeEnf) Add(_ context.Context, y []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	name := string(y)
	if f.fail[docSuffix(name)] {
		return errors.New("bpf: program load refused")
	}
	f.loaded = append(f.loaded, name)
	return nil
}

func (f *fakeEnf) Delete(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loaded = slices.DeleteFunc(f.loaded, func(n string) bool { return n == name })
	return nil
}

func (f *fakeEnf) Owned(context.Context) ([]string, error) { return nil, nil }

func (f *fakeEnf) set() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := slices.Clone(f.loaded)
	slices.Sort(out)
	return out
}

func TestApplyKeepsOldPoliciesWhenReloadFails(t *testing.T) {
	enf := &fakeEnf{fail: map[string]bool{}}
	var mu sync.Mutex
	var events []event.Event
	e := New(&policy.Policy{}, nil, enf, func(ev event.Event) { mu.Lock(); events = append(events, ev); mu.Unlock() },
		func(string, ...any) {}, false)
	root := &Root{Agent: "grok-bot", PID: 42}
	ctx := context.Background()
	rule := policy.Rule{Mode: policy.Denylist}

	e.apply(ctx, root, rule, 1)
	if got := enf.set(); !slices.Equal(got, []string{"eff-grok-bot-42-g1-lsm", "eff-grok-bot-42-g1-net"}) {
		t.Fatalf("first load: %v", got)
	}

	// Every new document fails: the old ones stay loaded and tracked.
	enf.fail = map[string]bool{"-lsm": true, "-net": true}
	e.apply(ctx, root, rule, 2)
	if got := enf.set(); !slices.Equal(got, []string{"eff-grok-bot-42-g1-lsm", "eff-grok-bot-42-g1-net"}) {
		t.Fatalf("after a failed reload: %v", got)
	}
	if !slices.Equal(root.Policies, []string{"eff-grok-bot-42-g1-lsm", "eff-grok-bot-42-g1-net"}) {
		t.Errorf("root policies: %v", root.Policies)
	}
	high := 0
	for _, ev := range events {
		if ev.Type == event.PolicyLoad && ev.Severity == "high" {
			high++
			if !strings.Contains(ev.Message, "previous version stays loaded") {
				t.Errorf("message: %q", ev.Message)
			}
		}
	}
	if high != 2 {
		t.Errorf("%d high events", high)
	}

	// One document fails: that one's old version stays, the other is replaced.
	enf.fail = map[string]bool{"-net": true}
	e.apply(ctx, root, rule, 3)
	want := []string{"eff-grok-bot-42-g1-net", "eff-grok-bot-42-g3-lsm"}
	if got := enf.set(); !slices.Equal(got, want) {
		t.Fatalf("partial reload: %v", got)
	}

	// The next good reload replaces everything, the kept document included.
	enf.fail = map[string]bool{}
	e.apply(ctx, root, rule, 4)
	if got := enf.set(); !slices.Equal(got, []string{"eff-grok-bot-42-g4-lsm", "eff-grok-bot-42-g4-net"}) {
		t.Fatalf("good reload: %v", got)
	}
	e.mu.Lock()
	n := len(e.byPolicy)
	e.mu.Unlock()
	if n != 2 {
		t.Errorf("byPolicy holds %d names", n)
	}
}

// ruleEnf records the last rule rendered for the kernel.
type ruleEnf struct {
	fakeEnf
	last policy.Rule
}

func (f *ruleEnf) Render(name string, pid uint32, r policy.Rule) ([]Doc, error) {
	f.mu.Lock()
	f.last = r
	f.mu.Unlock()
	return f.fakeEnf.Render(name, pid, r)
}

func TestObserveOnlyKernelRule(t *testing.T) {
	pol, err := policy.Parse([]byte("defaults:\n  mode: denylist\n  exec_deny: [/usr/bin/curl]\n"))
	if err != nil {
		t.Fatal(err)
	}
	enf := &ruleEnf{fakeEnf: fakeEnf{fail: map[string]bool{}}}
	e := New(pol, nil, enf, func(event.Event) {}, func(string, ...any) {}, false)
	ctx := context.Background()
	e.SetGuard(ctx, &policy.SelfProtect{Paths: []string{"/var/lib/effigent"}, KillPIDs: []uint32{1}})
	e.track(ctx, &Root{Agent: "grok-bot", PID: 42}, event.Raw{})
	if enf.last.Mode != policy.Denylist || enf.last.SelfProtect == nil {
		t.Fatalf("enforcing kernel: mode %s, guard %v", enf.last.Mode, enf.last.SelfProtect)
	}

	// Old kernel / no BTF / no BPF LSM: the live agent is re-applied observe-only, no guard.
	e.SetObserveOnly(true)
	if enf.last.Mode != policy.Monitor || enf.last.SelfProtect != nil {
		t.Fatalf("observe-only kernel: mode %s, guard %v", enf.last.Mode, enf.last.SelfProtect)
	}
	if len(enf.last.ExecDeny) == 0 {
		t.Error("the deny list should still be rendered (as would_block)")
	}
	if a := e.Agents(); len(a) != 1 || a[0].Mode != policy.Monitor {
		t.Errorf("tracked agent: %+v", a)
	}
	// The hooks' rule is the policy's: they still enforce.
	if r := e.RuleFor("grok-bot"); r.Mode != policy.Denylist {
		t.Errorf("hook rule mode %s", r.Mode)
	}
	// A learn-mode agent stays learn (it records what runs).
	pol2, err := policy.Parse([]byte("defaults:\n  mode: learn\n"))
	if err != nil {
		t.Fatal(err)
	}
	e2 := New(pol2, nil, enf, func(event.Event) {}, func(string, ...any) {}, false)
	e2.SetObserveOnly(true)
	e2.track(ctx, &Root{Agent: "grok-bot", PID: 43}, event.Raw{})
	if enf.last.Mode != policy.Learn {
		t.Errorf("learn became %s", enf.last.Mode)
	}
}

func TestDocSuffix(t *testing.T) {
	for in, want := range map[string]string{
		"eff-claude-42-g3-lsm":    "-lsm",
		"eff-claude-42-g3-guardk": "-guardk",
		"eff-gemini-g2-7-g12-net": "-net",
		"eff-codex-9-g1":          "",
		"something-else-entirely": "something-else-entirely",
	} {
		if got := docSuffix(in); got != want {
			t.Errorf("docSuffix(%q) = %q, want %q", in, got, want)
		}
	}
}
