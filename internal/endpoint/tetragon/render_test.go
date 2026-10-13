package tetragon

import (
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

func lsm(t *testing.T, r policy.Rule) string {
	t.Helper()
	docs, err := Render("eff-t-1-g1", 1, r)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if strings.HasSuffix(d.Name, "-lsm") {
			return string(d.YAML)
		}
	}
	t.Fatal("no -lsm policy")
	return ""
}

func TestDNSGuardRendersPortSelectors(t *testing.T) {
	y := lsm(t, policy.Rule{Mode: policy.Denylist, NetDeny: []string{"93.184.215.14"}, DNSGuard: []string{"8.8.8.8"}})
	for _, want := range []string{"93.184.215.14/32", "operator: SPort", "- \"853\"", "8.8.8.8/32", "- \"443\""} {
		if !strings.Contains(y, want) {
			t.Errorf("missing %q in:\n%s", want, y)
		}
	}
}

func TestNoGuardWithoutDomainDeny(t *testing.T) {
	if y := lsm(t, policy.Rule{Mode: policy.Denylist, NetDeny: []string{"1.1.1.1"}}); strings.Contains(y, "SPort") {
		t.Fatalf("guard rendered without domain_deny:\n%s", y)
	}
}
