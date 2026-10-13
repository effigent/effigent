package domains

import (
	"context"
	"errors"
	"net/netip"
	"slices"
	"testing"
	"time"
)

type fake struct {
	answers map[string][]string
	err     error
}

func (f *fake) lookup(_ context.Context, name string) ([]netip.Addr, error) {
	if f.err != nil {
		return nil, f.err
	}
	var out []netip.Addr
	for _, s := range f.answers[name] {
		out = append(out, netip.MustParseAddr(s))
	}
	return out, nil
}

func newTest(f *fake) (*Resolver, *time.Time) {
	r := NewWithLookup(f.lookup, nil)
	now := time.Unix(1_000_000, 0)
	r.now = func() time.Time { return now }
	return r, &now
}

func TestSetResolvesNewNamesBeforeReturning(t *testing.T) {
	r, _ := newTest(&fake{answers: map[string][]string{"example.com": {"93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"}}})
	if added := r.Set(context.Background(), []string{"example.com"}); !slices.Equal(added, []string{"example.com"}) {
		t.Fatalf("added = %v", added)
	}
	if got := r.IPs("example.com"); len(got) != 2 {
		t.Fatalf("IPs = %v", got)
	}
	if got := r.Names("93.184.215.14"); !slices.Equal(got, []string{"example.com"}) {
		t.Fatalf("Names = %v", got)
	}
}

func TestRotatingAnswersAreKeptUntilRetainExpires(t *testing.T) {
	f := &fake{answers: map[string][]string{"cdn.test": {"203.0.113.1"}}}
	r, now := newTest(f)
	r.Set(context.Background(), []string{"cdn.test"})

	f.answers["cdn.test"] = []string{"203.0.113.2"}
	*now = now.Add(time.Minute)
	if changed := r.Refresh(context.Background()); !slices.Equal(changed, []string{"cdn.test"}) {
		t.Fatalf("changed = %v", changed)
	}
	if got := r.IPs("cdn.test"); !slices.Equal(got, []string{"203.0.113.1", "203.0.113.2"}) {
		t.Fatalf("old answer dropped too early: %v", got)
	}
	if changed := r.Refresh(context.Background()); len(changed) != 0 {
		t.Fatalf("no new answer must not report a change: %v", changed)
	}

	*now = now.Add(Retain)
	r.Refresh(context.Background())
	if got := r.IPs("cdn.test"); !slices.Equal(got, []string{"203.0.113.2"}) {
		t.Fatalf("stale answer kept: %v", got)
	}
}

func TestFailedLookupNeverShrinksTheSet(t *testing.T) {
	f := &fake{answers: map[string][]string{"example.com": {"203.0.113.9"}}}
	r, now := newTest(f)
	r.Set(context.Background(), []string{"example.com"})
	f.err = errors.New("i/o timeout")
	*now = now.Add(2 * Retain)
	if changed := r.Refresh(context.Background()); len(changed) != 0 {
		t.Fatalf("changed on failure: %v", changed)
	}
	if got := r.IPs("example.com"); len(got) != 1 {
		t.Fatalf("resolver outage lifted the block: %v", got)
	}
}

func TestRemovedNamesAreForgotten(t *testing.T) {
	r, _ := newTest(&fake{answers: map[string][]string{"a.test": {"203.0.113.1"}, "b.test": {"203.0.113.2"}}})
	r.Set(context.Background(), []string{"a.test", "b.test"})
	r.Set(context.Background(), []string{"b.test"})
	if got := r.IPs("a.test"); got != nil {
		t.Fatalf("removed name still has IPs: %v", got)
	}
	if got := r.Names("203.0.113.1"); got != nil {
		t.Fatalf("removed name still matches: %v", got)
	}
}

func TestPerNameCap(t *testing.T) {
	f := &fake{answers: map[string][]string{}}
	r, now := newTest(f)
	r.Set(context.Background(), []string{"big.test"})
	for i := range MaxPerName + 10 {
		f.answers["big.test"] = []string{netip.AddrFrom4([4]byte{198, 51, 100, byte(i)}).String()}
		*now = now.Add(time.Second)
		r.Refresh(context.Background())
	}
	got := r.IPs("big.test")
	if len(got) != MaxPerName || slices.Contains(got, "198.51.100.0") || !slices.Contains(got, "198.51.100.73") {
		t.Fatalf("cap must keep the %d most recent: %d kept", MaxPerName, len(got))
	}
}

func TestLocalAnswersAreNeverBlockable(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "0.0.0.0", "::1", "::", "169.254.1.1", "fe80::1", "224.0.0.1"} {
		if Blockable(netip.MustParseAddr(s)) {
			t.Errorf("%s must not be blockable", s)
		}
	}
	for _, s := range []string{"10.1.2.3", "93.184.215.14", "2606:4700::1"} {
		if !Blockable(netip.MustParseAddr(s)) {
			t.Errorf("%s must be blockable", s)
		}
	}
}

func TestGuardExemptsConfiguredResolvers(t *testing.T) {
	g := Guarded([]string{"8.8.8.8", "192.168.65.7"})
	if slices.Contains(g, "8.8.8.8") || !slices.Contains(g, "1.1.1.1") {
		t.Fatalf("guard = %v", g)
	}
}
