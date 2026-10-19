package spend

import (
	"strings"
	"testing"
)

func TestObsPerson(t *testing.T) {
	d := NewDirectory([]Person{
		{Email: "dana@acme.io", Aliases: []string{"os_user:dana", "git_email:dana@home.dev"}},
		{Email: "omer@acme.io", Aliases: []string{"os_user:ubuntu@build-7", "host:omer-mbp"}},
		{Email: "raj@acme.io"},
	})
	d.AddKnown("noa@acme.io")
	cases := []struct {
		o         Observation
		key, via  string
		wantMatch bool
	}{
		{Observation{Hostname: "shared", OSUser: "dana"}, "dana@acme.io", ViaOSUser, true},
		{Observation{Hostname: "build-7", OSUser: "ubuntu"}, "omer@acme.io", ViaOSUser, true},
		{Observation{Hostname: "build-8", OSUser: "ubuntu"}, "host:build-8", ViaNone, false},                                // user@host only on build-7
		{Observation{Hostname: "shared", OSUser: "x", GitEmail: "DANA@home.dev"}, "dana@acme.io", ViaGitEmail, true},        // mapped git email
		{Observation{Hostname: "shared", GitEmail: "noa@acme.io"}, "noa@acme.io", ViaGitEmail, true},                        // known (seat) email
		{Observation{Hostname: "shared", GitEmail: "raj@acme.io", Owner: "dana@acme.io"}, "raj@acme.io", ViaGitEmail, true}, // the person beats the machine owner
		{Observation{Hostname: "shared", GitEmail: "stranger@gmail.com", Owner: "dana@acme.io"}, "dana@acme.io", ViaOwner, true},
		{Observation{Hostname: "omer-mbp", GitEmail: "stranger@gmail.com"}, "omer@acme.io", ViaHost, true},
		{Observation{Hostname: "lab", OSUsers: []string{"dana", "ubuntu"}}, "dana@acme.io", ViaOSUser, true},
	}
	for _, c := range cases {
		k, via := d.ObsPerson(c.o)
		if k != c.key || via != c.via || IsPerson(k) != c.wantMatch {
			t.Errorf("ObsPerson(%+v) = %q, %q; want %q, %q", c.o, k, via, c.key, c.via)
		}
	}
}

// A shared machine: two people, each with their own OS user, both run Claude
// Code. The owner of the machine must not get the other person's activity.
func TestAnalyzeSharedMachine(t *testing.T) {
	in := Input{Now: now, Connected: []string{Cursor},
		People: []Person{{Email: "a@acme.io", Aliases: []string{"os_user:alice"}}, {Email: "b@acme.io", Aliases: []string{"os_user:bob"}}},
		Seats:  []Seat{{Vendor: Cursor, Identity: "b@acme.io", Plan: "business"}},
	}
	for i := 0; i < 10; i++ {
		in.Obs = append(in.Obs,
			Observation{Hostname: "devbox", Owner: "a@acme.io", OSUser: "alice", Agent: "cursor-agent", Day: daysAgo(i)},
			Observation{Hostname: "devbox", Owner: "a@acme.io", OSUser: "bob", Agent: "claude-code", Day: daysAgo(i)})
	}
	r := Analyze(in)
	var gotShadowA, gotUnusedB bool
	for _, l := range r.Leaks {
		if l.Type == ShadowSpend && l.Person == "a@acme.io" && l.Vendor == Cursor {
			gotShadowA = true
			if l.Attribution != ViaOSUser {
				t.Errorf("attribution %q", l.Attribution)
			}
		}
		if l.Type == UnusedSeat && l.Person == "b@acme.io" {
			gotUnusedB = true
		}
	}
	if !gotShadowA {
		t.Errorf("alice runs Cursor without a seat: want shadow spend, got %+v", r.Leaks)
	}
	if !gotUnusedB {
		t.Errorf("bob's Cursor seat is unused on the machine: want unused seat, got %+v", r.Leaks)
	}
	for _, p := range r.People {
		if p.Person == "b@acme.io" && p.Via != ViaOSUser {
			t.Errorf("b via %q", p.Via)
		}
	}
}

func TestSuggest(t *testing.T) {
	people := []Person{
		{Email: "dana@acme.io", Name: "Dana", Aliases: []string{"os_user:dana"}},
		{Email: "omer.levi@acme.io", Name: "Omer"},
		{Email: "raj@acme.io"},
	}
	seats := []Seat{
		{Vendor: Cursor, Identity: "noa@acme.io", Name: "Noa"},
		{Vendor: Cursor, Identity: "dana@acme.io"},
		{Vendor: Copilot, Identity: "omerlevi_acme"},
		{Vendor: Copilot, Identity: "ghost"},
	}
	sightings := []Sighting{
		{Hostname: "omer-mbp", OSUser: "olevi", GitEmail: "omer.levi@acme.io"}, // A
		{Hostname: "build-7", OSUser: "ubuntu", GitEmail: "raj@acme.io"},       // A, generic login -> user@host
		{Hostname: "noa-ws", OSUser: "noa"},                                    // B (noa is a seat email)
		{Hostname: "dana-mbp", OSUser: "dana", GitEmail: "dana@personal.dev"},  // C via the mapped OS user
		{Hostname: "dana-mbp"},            // D: unidentified activity on dana's machine
		{Hostname: "lab", OSUser: "root"}, // nothing
	}
	got := map[string]Suggestion{}
	for _, s := range Suggest(people, sightings, seats) {
		got[s.Kind+":"+s.Value] = s
	}
	want := map[string]string{
		"os_user:olevi":               "omer.levi@acme.io",
		"os_user:ubuntu@build-7":      "raj@acme.io",
		"os_user:noa":                 "noa@acme.io",
		"git_email:dana@personal.dev": "dana@acme.io",
		"host:dana-mbp":               "dana@acme.io",
		"person:noa@acme.io":          "noa@acme.io",
		"github:omerlevi_acme":        "omer.levi@acme.io",
	}
	for k, e := range want {
		if got[k].Email != e {
			t.Errorf("%s: got %+v, want %s", k, got[k], e)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("unexpected suggestion %s: %+v", k, got[k])
		}
	}
	if got["person:noa@acme.io"].Name != "Noa" || got["os_user:olevi"].Confidence != confidenceHigh {
		t.Errorf("details: %+v %+v", got["person:noa@acme.io"], got["os_user:olevi"])
	}
	if !strings.Contains(got["os_user:olevi"].Reason, "commits as") {
		t.Errorf("reason %q", got["os_user:olevi"].Reason)
	}
	// once accepted, a suggestion goes away
	people[0].Aliases = append(people[0].Aliases, "git_email:dana@personal.dev", "host:dana-mbp")
	for _, s := range Suggest(people, sightings, seats) {
		if s.Value == "dana@personal.dev" || s.Value == "dana-mbp" {
			t.Errorf("still suggested after mapping: %+v", s)
		}
	}
}
