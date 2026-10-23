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

// TestDocsFlagLSM: the engine skips LSM documents on a kernel without BPF LSM,
// so every document with lsmhooks must say so and the kprobe one must not.
func TestDocsFlagLSM(t *testing.T) {
	docs, err := Render("eff-t-1-g1", 1, policy.Rule{Mode: policy.Denylist, ExecDeny: []string{"/usr/bin/curl"},
		SelfProtect: &policy.SelfProtect{Paths: []string{"/var/lib/effigent"}, KillPIDs: []uint32{1}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if has := strings.Contains(string(d.YAML), "lsmhooks:"); d.LSM != has {
			t.Errorf("%s: LSM %v, lsmhooks in the YAML %v", d.Name, d.LSM, has)
		}
	}
	if len(docs) < 3 {
		t.Fatalf("%d docs", len(docs))
	}
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

// doc returns the YAML of the policy whose name ends in suffix, or "".
func doc(t *testing.T, r policy.Rule, suffix string) string {
	t.Helper()
	docs, err := Render("eff-t-1-g1", 1, r)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if strings.HasSuffix(d.Name, suffix) {
			return string(d.YAML)
		}
	}
	return ""
}

// TestSelfProtectGuard: the self-protection hooks render into the -lsm doc
// with the expected LSM
// hooks and arg resolution.
func TestSelfProtectGuard(t *testing.T) {
	r := policy.Rule{Mode: policy.Denylist, SelfProtect: &policy.SelfProtect{
		KillPIDs: []uint32{42, 99},
		Paths:    []string{"/var/lib/effigent", "/usr/local/bin/effigentd"},
	}}
	g := doc(t, r, "-guard")
	if g == "" {
		t.Fatal("no -guard policy")
	}
	for _, want := range []string{
		"hook: file_permission", "operator: Mask", "- \"2\"",
		"hook: inode_setattr",
		"hook: inode_unlink",
		"hook: inode_rename",
		"/var/lib/effigent", "/usr/local/bin/effigentd",
		"action: Override", "argError: -1",
	} {
		if !strings.Contains(g, want) {
			t.Errorf("missing %q in -guard:\n%s", want, g)
		}
	}
	// inode_rename must guard both the old (index 1) and new (index 3) dentry.
	rename := g[strings.Index(g, "hook: inode_rename"):]
	if !strings.Contains(rename, "index: 3") {
		t.Errorf("inode_rename does not guard the new dentry (index 3):\n%s", rename)
	}
	// task_kill lives in its own -guardk doc so neither guard doc exceeds four
	// hooks (a single LSM TracingPolicy enforces only a few).
	k := doc(t, r, "-guardk")
	for _, want := range []string{"hook: task_kill", "resolve: tgid", "- \"42\"", "- \"99\"", "action: Override"} {
		if !strings.Contains(k, want) {
			t.Errorf("missing %q in -guardk:\n%s", want, k)
		}
	}
	// The guard must not leak into -lsm (it fails to enforce when merged).
	if strings.Contains(doc(t, r, "-lsm"), "task_kill") || strings.Contains(doc(t, r, "-lsm"), "inode_unlink") {
		t.Error("guard hook leaked into -lsm")
	}
}

// TestGatedExec: a gated binary renders a bprm selector that blocks a direct
// exec (matchArgs Equal the path) unless the caller is effigentd
// (matchBinaries NotIn the exempt paths). FR Q3.
func TestGatedExec(t *testing.T) {
	y := lsm(t, policy.Rule{Mode: policy.Denylist,
		GatedExec: []string{"/usr/bin/aws"}, GateExempt: []string{"/usr/local/bin/effigentd"}})
	for _, want := range []string{
		"hook: bprm_check_security", "matchBinaries", "operator: NotIn",
		"/usr/local/bin/effigentd", "/usr/bin/aws", "action: Override",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("missing %q in -lsm:\n%s", want, y)
		}
	}
}

// TestGatedExecAllowlist: in allowlist mode the gated path and effigentd are
// folded into the allow set (so the gate's exec passes the allow selector),
// and the separate gated selector still blocks a direct exec.
func TestGatedExecAllowlist(t *testing.T) {
	y := lsm(t, policy.Rule{Mode: policy.Allowlist, ExecAllow: []string{"/bin/ls"},
		GatedExec: []string{"/usr/bin/aws"}, GateExempt: []string{"/usr/local/bin/effigentd"}})
	// allow selector folds in the gated binary + effigentd
	if !strings.Contains(y, "NotEqual") || !strings.Contains(y, "/usr/bin/aws") || !strings.Contains(y, "/usr/local/bin/effigentd") {
		t.Errorf("gated binary/effigentd not folded into allow set:\n%s", y)
	}
	// and a NotIn matchBinaries selector gates the direct exec
	if !strings.Contains(y, "operator: NotIn") {
		t.Errorf("no gated (NotIn) selector in allowlist mode:\n%s", y)
	}
}

// TestNoGatedWithoutExempt: a gated_exec list with no exempt paths injected
// renders no gated selector (it would otherwise block the gate too).
func TestNoGatedWithoutExempt(t *testing.T) {
	y := lsm(t, policy.Rule{Mode: policy.Denylist, GatedExec: []string{"/usr/bin/aws"}})
	if strings.Contains(y, "matchBinaries") {
		t.Errorf("gated selector rendered without exempt paths:\n%s", y)
	}
}

// TestGuardOverrideEvenInMonitor: self-protection always blocks, even in
// monitor mode where every other selector is Post — an agent must never be
// able to disable effigentd.
func TestGuardOverrideEvenInMonitor(t *testing.T) {
	r := policy.Rule{Mode: policy.Monitor, SelfProtect: &policy.SelfProtect{Paths: []string{"/var/lib/effigent"}}}
	g := doc(t, r, "-guard")
	if !strings.Contains(g, "hook: file_permission") || !strings.Contains(g, "action: Override") {
		t.Errorf("guard not Override in monitor mode:\n%s", g)
	}
}

// TestNoGuardWithoutSelfProtect: no SelfProtect, no -guard doc at all.
func TestNoGuardWithoutSelfProtect(t *testing.T) {
	if g := doc(t, policy.Rule{Mode: policy.Denylist, ExecDeny: []string{"/usr/bin/curl"}}, "-guard"); g != "" {
		t.Errorf("unexpected -guard doc:\n%s", g)
	}
}

// TestGuardKillOmittedWithoutPIDs: on a daemon that can't resolve pids (macOS
// dev), the task_kill hook isn't rendered but path protection still is.
func TestGuardKillOmittedWithoutPIDs(t *testing.T) {
	g := doc(t, policy.Rule{Mode: policy.Denylist, SelfProtect: &policy.SelfProtect{Paths: []string{"/usr/local/bin/effigentd"}}}, "-guard")
	if strings.Contains(g, "task_kill") {
		t.Errorf("task_kill rendered without KillPIDs:\n%s", g)
	}
	if !strings.Contains(g, "hook: file_permission") {
		t.Errorf("path protection missing:\n%s", g)
	}
}
