package spend

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Suggestions for the people mapping, from what effigentd and the vendors
// saw. Nothing is applied until someone accepts it in the console.

// Sighting is one identity effigentd saw on a machine in the window: an OS
// user and the git email it committed as (either may be empty).
type Sighting struct {
	EndpointID string    `json:"endpoint_id"`
	Hostname   string    `json:"hostname"`
	Owner      string    `json:"owner,omitempty"`
	OSUser     string    `json:"os_user,omitempty"`
	GitEmail   string    `json:"git_email,omitempty"`
	Agents     []string  `json:"agents"`
	Events     int64     `json:"events"`
	LastSeen   time.Time `json:"last_seen"`
	// Person and Via: who it resolves to today ("" = nobody) and how.
	Person string `json:"person,omitempty"`
	Via    string `json:"via,omitempty"`
}

// Suggestion: map Kind:Value to Email. Kind "person" means "add Email to
// People" (a vendor seat that isn't there yet).
type Suggestion struct {
	Kind       string `json:"kind"`
	Value      string `json:"value"`
	Email      string `json:"email"`
	Name       string `json:"name,omitempty"`
	Reason     string `json:"reason"`
	Confidence string `json:"confidence"`
}

// KindPerson is the suggestion kind for a person to add.
const KindPerson = "person"

// ResolveSightings fills each sighting's Person and Via.
func (d Directory) ResolveSightings(ss []Sighting) {
	for i := range ss {
		s := &ss[i]
		k, via := d.ObsPerson(Observation{Hostname: s.Hostname, Owner: s.Owner, OSUser: s.OSUser, GitEmail: s.GitEmail})
		if IsPerson(k) {
			s.Person, s.Via = k, via
		} else {
			s.Person, s.Via = "", ViaNone
		}
	}
}

// Suggest proposes mappings: an OS user whose git email is a known person,
// an OS user named like exactly one person's email, a personal git email on
// a machine that is clearly one person's, a machine whose activity is all one
// person's, vendor seats not in People yet, and Copilot logins that look like
// a person's email.
func Suggest(people []Person, sightings []Sighting, seats []Seat) []Suggestion {
	d := NewDirectory(people)
	names := map[string]string{}
	inPeople := map[string]bool{}
	for _, p := range people {
		inPeople[norm(p.Email)] = true
		names[norm(p.Email)] = p.Name
	}
	for _, s := range seats {
		if SeatKind(s.Vendor) == KindEmail && strings.Contains(s.Identity, "@") {
			d.AddKnown(s.Identity)
			if e := norm(s.Identity); names[e] == "" {
				names[e] = s.Name
			}
		}
	}
	for _, s := range sightings {
		d.AddKnown(s.Owner)
	}
	ss := append([]Sighting{}, sightings...)
	d.ResolveSightings(ss)

	out := map[string]Suggestion{}
	add := func(x Suggestion) {
		key := x.Kind + ":" + x.Value
		if x.Value == "" || x.Email == "" {
			return
		}
		if x.Kind != KindPerson {
			if _, mapped := d.byKind[canonKind(x.Kind)+":"+x.Value]; mapped {
				return
			}
		}
		if cur, ok := out[key]; ok {
			if cur.Email != x.Email {
				cur.Confidence = confidenceLow // two candidates: let a person decide
				cur.Reason += fmt.Sprintf("; also looks like %s", x.Email)
				out[key] = cur
			} else if rankConf(x.Confidence) > rankConf(cur.Confidence) {
				out[key] = x
			}
			return
		}
		if x.Name == "" {
			x.Name = names[x.Email]
		}
		out[key] = x
	}

	// people an OS user name resolves to, across machines (to tell "dana"
	// from "dana@build-7" when the same login is two people)
	byUser := map[string]map[string]bool{}
	gitPerson := func(g string) (string, bool) {
		g = norm(g)
		if g == "" {
			return "", false
		}
		if k := d.Resolve(KindGitEmail, g); IsPerson(k) && (k != g || d.known[g]) {
			return k, true
		}
		return "", false
	}
	for _, s := range ss {
		if s.OSUser == "" {
			continue
		}
		if p, ok := gitPerson(s.GitEmail); ok {
			u := norm(s.OSUser)
			if byUser[u] == nil {
				byUser[u] = map[string]bool{}
			}
			byUser[u][p] = true
		}
	}

	locals := localParts(d)
	for _, s := range ss {
		u, host := norm(s.OSUser), norm(s.Hostname)
		// A: an unmapped OS user that commits as a known person
		if u != "" && d.osUser(u, host) == "" {
			if p, ok := gitPerson(s.GitEmail); ok {
				value := u
				if len(byUser[u]) > 1 || isGenericUser(u) {
					value = u + "@" + host
				}
				conf := confidenceHigh
				if !inPeople[p] {
					conf = confidenceMedium
				}
				add(Suggestion{Kind: KindOSUser, Value: value, Email: p, Confidence: conf,
					Reason: fmt.Sprintf("OS user %s on %s commits as %s", u, s.Hostname, norm(s.GitEmail))})
			} else if e := locals[squash(u)]; e != "" && !isGenericUser(u) {
				// B: named like exactly one person's email
				add(Suggestion{Kind: KindOSUser, Value: u, Email: e, Confidence: confidenceMedium,
					Reason: fmt.Sprintf("OS user %s on %s matches the name in %s", u, s.Hostname, e)})
			}
		}
		// C: a git email that isn't a known person's
		if g := norm(s.GitEmail); g != "" && strings.Contains(g, "@") {
			if _, ok := gitPerson(g); !ok {
				switch {
				case s.Via == ViaOSUser || s.Via == ViaOwner || s.Via == ViaHost:
					add(Suggestion{Kind: KindGitEmail, Value: g, Email: s.Person, Confidence: confidenceMedium,
						Reason: fmt.Sprintf("Used on %s, which is %s's (%s)", s.Hostname, s.Person, ViaLabel[s.Via])})
				case locals[squash(localPart(g))] != "":
					add(Suggestion{Kind: KindGitEmail, Value: g, Email: locals[squash(localPart(g))], Confidence: confidenceLow,
						Reason: fmt.Sprintf("%s has the same name as %s", g, locals[squash(localPart(g))])})
				}
			}
		}
	}

	// D: a machine with no owner or mapping, where everything identified is one
	// person's but some activity isn't identified (older effigentd, no git)
	type hostView struct {
		people     map[string]bool
		unresolved bool
		owner      string
	}
	hosts := map[string]*hostView{}
	for _, s := range ss {
		h := norm(s.Hostname)
		if h == "" {
			continue
		}
		v := hosts[h]
		if v == nil {
			v = &hostView{people: map[string]bool{}, owner: s.Owner}
			hosts[h] = v
		}
		if s.Person != "" && viaRank(s.Via) == 3 {
			v.people[s.Person] = true
		} else {
			v.unresolved = true
		}
	}
	for h, v := range hosts {
		if v.owner != "" || !v.unresolved || len(v.people) != 1 {
			continue
		}
		if _, mapped := d.lookup(KindHost, h); mapped {
			continue
		}
		p := sortedKeys(v.people)[0]
		add(Suggestion{Kind: KindHost, Value: h, Email: p, Confidence: confidenceMedium,
			Reason: fmt.Sprintf("Every identified agent run on %s is %s's", h, p)})
	}

	// E: vendor seats
	for _, s := range seats {
		id := norm(s.Identity)
		switch SeatKind(s.Vendor) {
		case KindEmail:
			if strings.Contains(id, "@") && !inPeople[id] {
				if k := d.Resolve(KindEmail, id); k != id {
					continue // an alias of someone already
				}
				add(Suggestion{Kind: KindPerson, Value: id, Email: id, Name: s.Name, Confidence: confidenceHigh,
					Reason: fmt.Sprintf("Has a %s seat", cmpOr(VendorLabel[s.Vendor], s.Vendor))})
			}
		case KindGitHub:
			if id == "" || IsPerson(d.Resolve(KindGitHub, id)) {
				continue
			}
			if e := locals[squash(stripGitHubSuffix(id))]; e != "" {
				add(Suggestion{Kind: KindGitHub, Value: id, Email: e, Confidence: confidenceLow,
					Reason: fmt.Sprintf("%s seat %s looks like %s", cmpOr(VendorLabel[s.Vendor], s.Vendor), id, e)})
			}
		}
	}

	res := make([]Suggestion, 0, len(out))
	for _, x := range out {
		res = append(res, x)
	}
	sort.Slice(res, func(i, j int) bool {
		if a, b := rankConf(res[i].Confidence), rankConf(res[j].Confidence); a != b {
			return a > b
		}
		if res[i].Kind != res[j].Kind {
			return res[i].Kind < res[j].Kind
		}
		return res[i].Value < res[j].Value
	})
	return res
}

func rankConf(c string) int {
	switch c {
	case confidenceHigh:
		return 3
	case confidenceMedium:
		return 2
	}
	return 1
}

// localParts maps a squashed email local part ("dana.k" -> "danak") to the
// one known email that has it ("" when several do).
func localParts(d Directory) map[string]string {
	out := map[string]string{}
	for e := range d.known {
		l := squash(localPart(e))
		if len(l) < 3 {
			continue
		}
		if cur, ok := out[l]; ok && cur != e {
			out[l] = ""
			continue
		}
		out[l] = e
	}
	return out
}

func localPart(e string) string {
	l, _, _ := strings.Cut(e, "@")
	l, _, _ = strings.Cut(l, "+")
	return l
}

// squash keeps letters and digits: "Dana.K" and "dana_k" compare equal.
func squash(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// stripGitHubSuffix drops a common enterprise suffix (dana-k_acme -> dana-k).
func stripGitHubSuffix(login string) string {
	if i := strings.LastIndex(login, "_"); i > 0 {
		return login[:i]
	}
	return login
}

// isGenericUser: shared logins that say nothing about the person.
func isGenericUser(u string) bool {
	switch u {
	case "root", "admin", "administrator", "ubuntu", "ec2-user", "user", "dev", "developer", "node", "runner", "ci", "build", "jenkins", "vagrant", "docker", "app", "www-data", "nobody":
		return true
	}
	return false
}
