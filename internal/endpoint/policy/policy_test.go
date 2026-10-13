package policy

import (
	"slices"
	"strings"
	"testing"
)

func TestDomainDenyIsNormalized(t *testing.T) {
	p, err := Parse([]byte("defaults:\n  domain_deny: [Pastebin.COM., example.com]\nagents:\n  - name: a\n    binary_names: [a]\n    domain_deny: [evil.example]\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := p.RuleFor("").DomainDeny; !slices.Equal(got, []string{"pastebin.com", "example.com"}) {
		t.Fatalf("defaults = %v", got)
	}
	if got := p.Domains(); !slices.Equal(got, []string{"pastebin.com", "example.com", "evil.example"}) {
		t.Fatalf("Domains = %v", got)
	}
}

func TestDomainDenyRejectsWhatItCannotEnforce(t *testing.T) {
	for in, want := range map[string]string{
		"1.2.3.4":             "network_deny",
		"10.0.0.0/8":          "network_deny",
		"*.example.com":       "list each hostname",
		"https://example.com": "bare hostname",
		"example.com:443":     "bare hostname",
		"localhost":           "single-label",
		"exa_mple.com":        "not a valid hostname",
	} {
		_, err := Parse([]byte("defaults:\n  domain_deny: [\"" + in + "\"]\n"))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want an error mentioning %q", in, err, want)
		}
	}
}

func TestDNSGuardIsNotAPolicyField(t *testing.T) {
	if _, err := Parse([]byte("defaults:\n  dns_guard: [1.1.1.1]\n")); err == nil {
		t.Fatal("dns_guard must not be settable from YAML")
	}
}
