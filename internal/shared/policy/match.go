package policy

import (
	"net"
	"path"
	"strings"

	"github.com/effigent/effigent/internal/shared/action"
)

func anyOf(list []string, ok func(string) bool) bool {
	if len(list) == 0 {
		return true
	}
	for _, x := range list {
		if ok(x) {
			return true
		}
	}
	return false
}

func eqFold(want string) func(string) bool {
	return func(got string) bool { return strings.EqualFold(want, got) }
}

// textMatch: exact, or prefix when the pattern ends in "*".
func textMatch(pattern, s string) bool {
	if p, ok := strings.CutSuffix(pattern, "*"); ok {
		return strings.HasPrefix(s, p)
	}
	return pattern == s
}

// globMatch matches a path glob where "**" spans directories and "*" stays
// inside one segment.
func globMatch(pattern, p string) bool {
	return globParts(strings.Split(pattern, "/"), strings.Split(p, "/"))
}

func globParts(pat, segs []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			for i := 0; i <= len(segs); i++ {
				if globParts(pat[1:], segs[i:]) {
					return true
				}
			}
			return false
		}
		if len(segs) == 0 {
			return false
		}
		if ok, _ := path.Match(pat[0], segs[0]); !ok {
			return false
		}
		pat, segs = pat[1:], segs[1:]
	}
	return len(segs) == 0
}

func hostMatch(pattern, host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	pattern = strings.ToLower(pattern)
	if _, cidr, err := net.ParseCIDR(pattern); err == nil {
		ip := net.ParseIP(host)
		return ip != nil && cidr.Contains(ip)
	}
	if rest, ok := strings.CutPrefix(pattern, "*."); ok {
		return host == rest || strings.HasSuffix(host, "."+rest)
	}
	return host == pattern
}

func (s Selector) matches(sub Subject) bool {
	return anyOf(s.AgentTypes, eqFold(sub.AgentType)) &&
		anyOf(s.Users, func(u string) bool { return u == sub.UserID || strings.EqualFold(u, sub.UserEmail) }) &&
		anyOf(s.Teams, func(t string) bool {
			for _, have := range sub.Teams {
				if strings.EqualFold(t, have) {
					return true
				}
			}
			return false
		}) &&
		anyOf(s.Endpoints, func(e string) bool { return e == sub.EndpointID || strings.EqualFold(e, sub.Hostname) }) &&
		anyOf(s.OSUsers, func(u string) bool { return u == sub.OSUser })
}

func (t Target) matches(a action.Action) bool {
	if len(t.Classes) > 0 {
		ok := false
		for _, c := range t.Classes {
			ok = ok || c == a.Class
		}
		if !ok {
			return false
		}
	}
	if len(t.Ports) > 0 {
		ok := false
		for _, p := range t.Ports {
			ok = ok || p == a.Port
		}
		if !ok {
			return false
		}
	}
	paths := func(p string) bool {
		for _, have := range a.Paths {
			if globMatch(p, have) {
				return true
			}
		}
		return false
	}
	return anyOf(t.Tools, func(p string) bool { return textMatch(p, a.Tool) }) &&
		anyOf(t.Binaries, func(p string) bool { return a.Binary != "" && (textMatch(p, a.Binary) || path.Base(a.Binary) == p) }) &&
		anyOf(t.Commands, func(p string) bool { return textMatch(p, strings.TrimSpace(a.Command)) }) &&
		anyOf(t.Paths, paths) &&
		anyOf(t.Hosts, func(p string) bool { return a.Host != "" && hostMatch(p, a.Host) }) &&
		anyOf(t.MCPServers, func(p string) bool { return textMatch(p, a.MCPServer) }) &&
		anyOf(t.MCPTools, func(p string) bool { return textMatch(p, a.MCPTool) })
}

// Matches reports whether the selector picks sub. The control plane's policy
// compiler uses it to decide which rules apply to a machine.
func (s Selector) Matches(sub Subject) bool { return s.matches(sub) }

// Matches reports whether the target picks action a.
func (t Target) Matches(a action.Action) bool { return t.matches(a) }
