package spend

import "strings"

// Identity matching. Vendors key people differently: Cursor and Anthropic by
// email, Copilot by GitHub login, Anthropic API keys by key name, OpenAI by
// its own user id (resolved to an email at sync). effigentd knows machines and,
// from effigentd builds that send them, the OS user and git email behind each
// agent event; cp.endpoints.owner (an email or console user id) is set per
// machine in the console.
//
// Every value is turned into a person key: the person's work email when we
// know it, else "<kind>:<value>" (github:dana-k, host:build-7, key:ci-bot),
// so unrelated values never merge by accident. The workspace's people mapping
// (cp.people + cp.person_identities) lists, per email, the identities the
// person goes by and wins over everything else.

// Identity kinds of the people mapping.
const (
	KindOSUser   = "os_user"   // "dana" (any machine) or "dana@build-7" (one machine)
	KindHost     = "host"      // a machine's hostname: everything on it is this person's
	KindGitEmail = "git_email" // a git user.email seen on agent events
	KindGitHub   = "github"    // a GitHub login (Copilot seats)
	KindEmail    = "email"     // another email (personal, old domain, vendor account)
	KindAPIKey   = "api_key"   // a vendor API key name (Anthropic usage by key)
)

// Kinds lists the mapping kinds, in the order the console shows them.
var Kinds = []string{KindOSUser, KindGitEmail, KindHost, KindGitHub, KindEmail, KindAPIKey}

// canonKind maps the short kinds used in person keys and old aliases.
func canonKind(k string) string {
	switch k = norm(k); k {
	case "os", "user_os", "osuser":
		return KindOSUser
	case "key", "apikey":
		return KindAPIKey
	case "git":
		return KindGitEmail
	case "hostname":
		return KindHost
	}
	return k
}

// IsKind reports whether k is a mapping kind.
func IsKind(k string) bool {
	for _, x := range Kinds {
		if x == k {
			return true
		}
	}
	return false
}

// How a person was matched to what effigentd saw, strongest first.
const (
	ViaOSUser   = "os_user"   // the OS user is mapped (people mapping)
	ViaGitEmail = "git_email" // the git email is mapped, or is a known work email
	ViaOwner    = "owner"     // the machine's owner (console)
	ViaHost     = "host"      // the machine's hostname is mapped
	ViaNone     = ""          // not matched: the machine itself
)

// viaRank: 3 = the person, 2 = their machine, 1 = nothing.
func viaRank(v string) int {
	switch v {
	case ViaOSUser, ViaGitEmail:
		return 3
	case ViaOwner, ViaHost:
		return 2
	}
	return 1
}

// ViaLabel is how the console names an attribution.
var ViaLabel = map[string]string{
	ViaOSUser: "mapped OS user", ViaGitEmail: "git email", ViaOwner: "machine owner", ViaHost: "machine (hostname)", ViaNone: "not matched",
}

// Person is one entry of the people mapping. Aliases are "kind:value"; a
// bare value (older settings) matches any kind.
type Person struct {
	Email   string   `json:"email"`
	Name    string   `json:"name,omitempty"`
	Aliases []string `json:"aliases"`
}

// Directory resolves identities to person keys.
type Directory struct {
	byKind  map[string]string // "kind:value" -> person email
	byAlias map[string]string // bare value or email -> person email
	names   map[string]string
	known   map[string]bool // emails that are real people: the mapping, seats, machine owners
}

// NewDirectory indexes the people mapping. An identity claimed by two
// people resolves to the first.
func NewDirectory(people []Person) Directory {
	d := Directory{byKind: map[string]string{}, byAlias: map[string]string{}, names: map[string]string{}, known: map[string]bool{}}
	for _, p := range people {
		e := norm(p.Email)
		if e == "" {
			continue
		}
		d.known[e] = true
		if _, ok := d.byAlias[e]; !ok {
			d.byAlias[e] = e
		}
		if p.Name != "" {
			d.names[e] = p.Name
		}
		for _, a := range p.Aliases {
			a = norm(a)
			if k, v, ok := strings.Cut(a, ":"); ok && v != "" && !strings.Contains(k, "@") {
				key := canonKind(k) + ":" + v
				if _, taken := d.byKind[key]; !taken {
					d.byKind[key] = e
				}
				if k := canonKind(k); k == KindEmail || k == KindGitEmail { // an email is an email, whichever list it's on
					if _, taken := d.byAlias[v]; !taken {
						d.byAlias[v] = e
					}
				}
				continue
			}
			if _, taken := d.byAlias[a]; a != "" && !taken {
				d.byAlias[a] = e
			}
		}
	}
	return d
}

// AddKnown marks emails as belonging to real people (vendor seats, machine
// owners), so a git email equal to one of them counts as that person.
func (d Directory) AddKnown(emails ...string) {
	for _, e := range emails {
		if e = norm(e); strings.Contains(e, "@") && !strings.Contains(e, ":") {
			d.known[e] = true
		}
	}
}

// Known reports whether an email is a known person.
func (d Directory) Known(email string) bool { return d.known[norm(email)] }

func norm(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// lookup finds a mapped identity: kind-specific first, then a bare alias.
func (d Directory) lookup(kind, v string) (string, bool) {
	if e, ok := d.byKind[kind+":"+v]; ok {
		return e, true
	}
	e, ok := d.byAlias[v]
	return e, ok
}

// Resolve returns the person key for a value of a kind (email, github, host,
// os, key, user, git_email…). Unmatched values keep the kind they came with.
func (d Directory) Resolve(kind, value string) string {
	v := norm(value)
	if v == "" {
		return ""
	}
	k := canonKind(kind)
	if e, ok := d.lookup(k, v); ok {
		return e
	}
	if strings.Contains(v, "@") && (k == KindEmail || k == KindGitEmail || k == "user" || k == "") {
		return v
	}
	return norm(kind) + ":" + v
}

// Name is the directory's name for a person key, if any.
func (d Directory) Name(key string) string { return d.names[key] }

// IsPerson reports whether a key is a resolved person (an email), not an
// unmatched login, machine or key.
func IsPerson(key string) bool { return strings.Contains(key, "@") && !strings.Contains(key, ":") }

// SeatKind is the identity kind a vendor keys seats and usage on.
func SeatKind(vendor string) string {
	if vendor == Copilot {
		return "github"
	}
	return "email"
}

// EndpointPerson is who uses a machine: its owner, else a mapping of its
// hostname or (a single) OS user, else the machine itself ("host:…").
func (d Directory) EndpointPerson(owner, hostname string, osUsers []string) string {
	k, _ := d.endpointPerson(owner, hostname, osUsers)
	return k
}

func (d Directory) endpointPerson(owner, hostname string, osUsers []string) (string, string) {
	if owner != "" {
		if k := d.Resolve("user", owner); IsPerson(k) {
			return k, ViaOwner
		}
	}
	if e, ok := d.lookup(KindHost, norm(hostname)); ok && hostname != "" {
		return e, ViaHost
	}
	var found string
	for _, u := range osUsers {
		if k := d.osUser(u, hostname); k != "" {
			if found != "" && found != k {
				found = "" // several people share the machine: don't guess
				break
			}
			found = k
		}
	}
	if found != "" {
		return found, ViaOSUser
	}
	if owner != "" {
		return d.Resolve("user", owner), ViaNone
	}
	return d.Resolve("host", hostname), ViaNone
}

// osUser resolves an OS user on a host: "user@host" first, then "user".
func (d Directory) osUser(user, host string) string {
	u, h := norm(user), norm(host)
	if u == "" {
		return ""
	}
	if h != "" {
		if e, ok := d.byKind[KindOSUser+":"+u+"@"+h]; ok {
			return e
		}
	}
	if e, ok := d.lookup(KindOSUser, u); ok {
		return e
	}
	return ""
}

// ObsPerson is who is behind an observation and how that was decided:
// a mapped OS user, then the git email (mapped, or a known person's email),
// then the machine (owner, hostname mapping, a single mapped OS user seen in
// approvals), else the machine itself (not matched).
func (d Directory) ObsPerson(o Observation) (key, via string) {
	if o.OSUser != "" {
		if e := d.osUser(o.OSUser, o.Hostname); e != "" {
			return e, ViaOSUser
		}
	}
	if g := norm(o.GitEmail); g != "" {
		if e, ok := d.byKind[KindGitEmail+":"+g]; ok {
			return e, ViaGitEmail
		}
		if e, ok := d.byKind[KindEmail+":"+g]; ok {
			return e, ViaGitEmail
		}
		if e, ok := d.byAlias[g]; ok {
			return e, ViaGitEmail
		}
		if d.known[g] {
			return g, ViaGitEmail
		}
	}
	return d.endpointPerson(o.Owner, o.Hostname, o.OSUsers)
}
