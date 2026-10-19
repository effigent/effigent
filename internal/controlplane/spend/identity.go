package spend

import "strings"

// Identity matching. Vendors key people differently: Cursor and Anthropic by
// email, Copilot by GitHub login, Anthropic API keys by key name, OpenAI by
// its own user id (resolved to an email at sync). effigentd knows machines:
// cp.endpoints.owner (an email or console user id, set in the console), the
// hostname, and the OS users seen in approval requests.
//
// Every value is turned into a person key: the person's work email when we
// know it, else "<kind>:<value>" (github:dana-k, host:build-7, key:ci-bot),
// so unrelated values never merge by accident. The workspace's people
// directory (cp.spend_settings) lists, per email, the other names the person
// goes by — GitHub logins, OS users, hostnames, personal emails, API key
// names — and wins over everything else.

// Person is one entry of the people directory.
type Person struct {
	Email   string   `json:"email"`
	Name    string   `json:"name,omitempty"`
	Aliases []string `json:"aliases"`
}

// Directory resolves identities to person keys.
type Directory struct {
	byAlias map[string]string // lowercased alias or email -> person email
	names   map[string]string
}

// NewDirectory indexes the people directory. An alias claimed by two
// people resolves to the first.
func NewDirectory(people []Person) Directory {
	d := Directory{byAlias: map[string]string{}, names: map[string]string{}}
	for _, p := range people {
		e := norm(p.Email)
		if e == "" {
			continue
		}
		if _, ok := d.byAlias[e]; !ok {
			d.byAlias[e] = e
		}
		if p.Name != "" {
			d.names[e] = p.Name
		}
		for _, a := range p.Aliases {
			a = norm(a)
			if _, rest, ok := strings.Cut(a, ":"); ok && rest != "" && !strings.Contains(a, "@") {
				a = rest // "github:dana" in the directory means the login dana
			}
			if _, taken := d.byAlias[a]; a != "" && !taken {
				d.byAlias[a] = e
			}
		}
	}
	return d
}

func norm(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// Resolve returns the person key for a value of a kind (email, github, host,
// os, key, user).
func (d Directory) Resolve(kind, value string) string {
	v := norm(value)
	if v == "" {
		return ""
	}
	if e, ok := d.byAlias[v]; ok {
		return e
	}
	if kind == "email" || strings.Contains(v, "@") {
		return v
	}
	return kind + ":" + v
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

// EndpointPerson is who uses a machine: its owner, else a directory match on
// its hostname or (a single) OS user, else the machine itself ("host:…").
func (d Directory) EndpointPerson(owner, hostname string, osUsers []string) string {
	if owner != "" {
		if k := d.Resolve("user", owner); IsPerson(k) {
			return k
		}
	}
	if k := d.Resolve("host", hostname); IsPerson(k) {
		return k
	}
	var found string
	for _, u := range osUsers {
		if k := d.Resolve("os", u); IsPerson(k) {
			if found != "" && found != k {
				found = "" // several people share the machine: don't guess
				break
			}
			found = k
		}
	}
	if found != "" {
		return found
	}
	if owner != "" {
		return d.Resolve("user", owner)
	}
	return d.Resolve("host", hostname)
}
