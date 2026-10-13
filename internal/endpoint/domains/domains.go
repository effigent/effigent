// Package domains keeps the IP addresses behind domain_deny hostnames
// current, so the kernel (which only sees addresses) can block them.
//
// Every hostname is resolved through the system resolver and a few public
// resolvers, and the union is kept: an agent may get a different answer
// than effigentd (CDN geo-routing, round-robin subsets, its own resolver).
// Addresses stay blocked for Retain after they were last seen, because
// clients cache answers and round-robin sets rotate. A failed lookup never
// shrinks the set; an NXDOMAIN lets it expire.
package domains

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	// Retain is how long an address stays blocked after a lookup last returned it.
	Retain = 15 * time.Minute
	// MaxPerName bounds one hostname's addresses (most recently seen win).
	MaxPerName = 64
	// LookupTimeout bounds one query to one upstream.
	LookupTimeout = 2 * time.Second
)

// DefaultUpstreams are queried next to the system resolver.
var DefaultUpstreams = []string{"1.1.1.1:53", "8.8.8.8:53", "9.9.9.9:53"}

// LookupFunc returns the addresses of a hostname. A name that does not
// exist (NXDOMAIN) is an empty answer with a nil error.
type LookupFunc func(ctx context.Context, name string) (addrs []netip.Addr, err error)

type entry struct {
	seen map[netip.Addr]time.Time
}

type Resolver struct {
	mu     sync.Mutex
	names  map[string]*entry
	lookup LookupFunc
	now    func() time.Time
	logf   func(string, ...any)
}

// New resolves through the system resolver plus upstreams ("host:port").
func New(upstreams []string, logf func(string, ...any)) *Resolver {
	return NewWithLookup(Lookup(upstreams), logf)
}

func NewWithLookup(lookup LookupFunc, logf func(string, ...any)) *Resolver {
	return &Resolver{names: map[string]*entry{}, lookup: lookup, now: time.Now, logf: logf}
}

// Set makes names the watched hostnames. New ones are resolved before Set
// returns (bounded by ctx and LookupTimeout), so a policy applied right
// after already carries their addresses. It returns the names that were added.
func (r *Resolver) Set(ctx context.Context, names []string) []string {
	r.mu.Lock()
	want := map[string]bool{}
	var added []string
	for _, n := range names {
		want[n] = true
		if r.names[n] == nil {
			r.names[n] = &entry{seen: map[netip.Addr]time.Time{}}
			added = append(added, n)
		}
	}
	for n := range r.names {
		if !want[n] {
			delete(r.names, n)
		}
	}
	r.mu.Unlock()
	r.resolve(ctx, added)
	return added
}

// IPs returns a hostname's current addresses, sorted.
func (r *Resolver) IPs(name string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.names[name]
	if e == nil {
		return nil
	}
	out := make([]string, 0, len(e.seen))
	for a := range e.seen {
		out = append(out, a.String())
	}
	slices.Sort(out)
	return out
}

// Names returns the hostnames an address currently belongs to.
func (r *Resolver) Names(ip string) []string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return nil
	}
	a = a.Unmap()
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for n, e := range r.names {
		if _, ok := e.seen[a]; ok {
			out = append(out, n)
		}
	}
	slices.Sort(out)
	return out
}

// Refresh re-resolves every watched hostname and returns those whose
// address set changed.
func (r *Resolver) Refresh(ctx context.Context) []string {
	r.mu.Lock()
	names := make([]string, 0, len(r.names))
	for n := range r.names {
		names = append(names, n)
	}
	r.mu.Unlock()
	return r.resolve(ctx, names)
}

// Run refreshes every interval and reports changed hostnames to onChange.
func (r *Resolver) Run(ctx context.Context, every time.Duration, onChange func(ctx context.Context, names []string)) {
	t := time.NewTicker(max(every, time.Second))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if changed := r.Refresh(ctx); len(changed) > 0 {
				onChange(ctx, changed)
			}
		}
	}
}

func (r *Resolver) resolve(ctx context.Context, names []string) []string {
	type result struct {
		addrs []netip.Addr
		err   error
	}
	res := make([]result, len(names))
	var wg sync.WaitGroup
	for i, n := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := r.lookup(ctx, n)
			res[i] = result{a, err}
		}()
	}
	wg.Wait()

	now := r.now()
	var changed []string
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, n := range names {
		e := r.names[n]
		if e == nil {
			continue // removed while resolving
		}
		before := keys(e.seen)
		if res[i].err != nil {
			// Keep what we had: a resolver outage must not lift a block.
			if r.logf != nil {
				r.logf("domain_deny: resolve %s: %v (keeping %d known addresses)", n, res[i].err, len(e.seen))
			}
			continue
		}
		for _, a := range res[i].addrs {
			e.seen[a] = now
		}
		for a, t := range e.seen {
			if now.Sub(t) > Retain {
				delete(e.seen, a)
			}
		}
		if len(e.seen) > MaxPerName {
			all := keys(e.seen)
			slices.SortFunc(all, func(a, b netip.Addr) int { return e.seen[b].Compare(e.seen[a]) })
			for _, a := range all[MaxPerName:] {
				delete(e.seen, a)
			}
		}
		if !slices.Equal(before, keys(e.seen)) {
			changed = append(changed, n)
		}
	}
	return changed
}

func keys(m map[netip.Addr]time.Time) []netip.Addr {
	out := make([]netip.Addr, 0, len(m))
	for a := range m {
		out = append(out, a)
	}
	slices.SortFunc(out, func(a, b netip.Addr) int { return a.Compare(b) })
	return out
}

// Lookup queries the system resolver and every upstream in parallel and
// returns the union of their A and AAAA answers. It fails only if every
// resolver failed; NXDOMAIN everywhere is an empty, successful answer.
func Lookup(upstreams []string) LookupFunc {
	resolvers := []*net.Resolver{net.DefaultResolver}
	for _, u := range upstreams {
		resolvers = append(resolvers, &net.Resolver{PreferGo: true,
			Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, u)
			}})
	}
	return func(ctx context.Context, name string) ([]netip.Addr, error) {
		type result struct {
			addrs []netip.Addr
			err   error
		}
		res := make([]result, len(resolvers))
		var wg sync.WaitGroup
		for i, rv := range resolvers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				c, cancel := context.WithTimeout(ctx, LookupTimeout)
				defer cancel()
				a, err := rv.LookupNetIP(c, "ip", name)
				res[i] = result{a, err}
			}()
		}
		wg.Wait()
		var out []netip.Addr
		var errs []error
		ok := false
		for _, r := range res {
			var dnsErr *net.DNSError
			switch {
			case r.err == nil:
				ok = true
			case errors.As(r.err, &dnsErr) && dnsErr.IsNotFound:
				ok = true
			default:
				errs = append(errs, r.err)
				continue
			}
			for _, a := range r.addrs {
				if a = a.Unmap(); Blockable(a) && !slices.Contains(out, a) {
					out = append(out, a)
				}
			}
		}
		if !ok {
			return nil, errors.Join(errs...)
		}
		return out, nil
	}
}

// Blockable reports whether an answer may be blocked. Loopback, link-local,
// multicast and unspecified answers (sinkholes, rebinding) would break
// local traffic, so they are never added.
func Blockable(a netip.Addr) bool {
	return a.IsValid() && !a.IsLoopback() && !a.IsUnspecified() && !a.IsLinkLocalUnicast() &&
		!a.IsLinkLocalMulticast() && !a.IsInterfaceLocalMulticast() && !a.IsMulticast()
}

// PublicResolvers are well-known public DNS, DNS-over-HTTPS and DNS-over-TLS
// services. While domain_deny is in force, agents may not reach them on
// DNS ports (53, 443, 853), so they can't fetch an answer effigentd never saw.
var PublicResolvers = []string{
	// Cloudflare (incl. 1.1.1.2/3 families)
	"1.1.1.1", "1.0.0.1", "1.1.1.2", "1.0.0.2", "1.1.1.3", "1.0.0.3",
	"2606:4700:4700::1111", "2606:4700:4700::1001", "2606:4700:4700::1112",
	"2606:4700:4700::1002", "2606:4700:4700::1113", "2606:4700:4700::1003",
	// Google (dns.google)
	"8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844",
	// Quad9
	"9.9.9.9", "149.112.112.112", "9.9.9.10", "149.112.112.10", "9.9.9.11", "149.112.112.11",
	"2620:fe::fe", "2620:fe::9", "2620:fe::10", "2620:fe::fe:10", "2620:fe::11", "2620:fe::fe:11",
	// OpenDNS
	"208.67.222.222", "208.67.220.220", "208.67.222.123", "208.67.220.123",
	"2620:119:35::35", "2620:119:53::53",
	// AdGuard
	"94.140.14.14", "94.140.15.15", "2a10:50c0::ad1:ff", "2a10:50c0::ad2:ff",
}

// DNSPorts are the destination ports the bypass guard applies to.
var DNSPorts = []string{"53", "443", "853"}

// Nameservers reads the nameserver lines of resolv.conf files. Missing or
// unreadable files are skipped.
func Nameservers(files ...string) []string {
	var out []string
	for _, f := range files {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		s := bufio.NewScanner(fh)
		for s.Scan() {
			fields := strings.Fields(s.Text())
			if len(fields) >= 2 && fields[0] == "nameserver" {
				if a, err := netip.ParseAddr(strings.SplitN(fields[1], "%", 2)[0]); err == nil && !slices.Contains(out, a.Unmap().String()) {
					out = append(out, a.Unmap().String())
				}
			}
		}
		fh.Close()
	}
	return out
}

// Guarded returns PublicResolvers minus the given nameservers: an agent's
// own configured resolver is how ordinary DNS works and is never blocked.
func Guarded(exempt []string) []string {
	out := make([]string, 0, len(PublicResolvers))
	for _, ip := range PublicResolvers {
		if !slices.Contains(exempt, ip) {
			out = append(out, ip)
		}
	}
	return out
}
