package peer

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestParseCgroup(t *testing.T) {
	id := "4f1d2c3b4a5968778695a4b3c2d1e0f0123456789abcdef0123456789abcdef0"
	for _, tc := range []struct{ name, in, id, pod string }{
		{"kubelet systemd driver (cgroup v2)",
			"0::/kubepods.slice/kubepods-besteffort.slice/kubepods-besteffort-pod0b7a9c2e_1d3f_4a5b_9c8d_7e6f5a4b3c2d.slice/cri-containerd-" + id + ".scope\n",
			id, "0b7a9c2e-1d3f-4a5b-9c8d-7e6f5a4b3c2d"},
		{"kubelet cgroupfs driver (v1)",
			"12:memory:/kubepods/burstable/pod0b7a9c2e-1d3f-4a5b-9c8d-7e6f5a4b3c2d/" + id + "\n11:cpu:/kubepods/burstable/pod0b7a9c2e-1d3f-4a5b-9c8d-7e6f5a4b3c2d/" + id + "\n",
			id, "0b7a9c2e-1d3f-4a5b-9c8d-7e6f5a4b3c2d"},
		{"docker (cgroupfs)", "0::/docker/" + id + "\n", id, ""},
		{"docker (systemd)", "0::/system.slice/docker-" + id + ".scope\n", id, ""},
		{"seen from another cgroup namespace", "0::/../../" + id + "\n", id, ""},
		{"kind node inside docker: the innermost id wins",
			"0::/system.slice/docker-" + id[:63] + "1.scope/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-besteffort.slice/kubelet-kubepods-besteffort-pod0b7a9c2e_1d3f_4a5b_9c8d_7e6f5a4b3c2d.slice/cri-containerd-" + id + ".scope\n",
			id, "0b7a9c2e-1d3f-4a5b-9c8d-7e6f5a4b3c2d"},
		{"host process", "0::/user.slice/user-1000.slice/session-2.scope\n", "", ""},
		{"empty", "", "", ""},
	} {
		gotID, gotPod := ParseCgroup([]byte(tc.in))
		if gotID != tc.id || gotPod != tc.pod {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", tc.name, gotID, gotPod, tc.id, tc.pod)
		}
	}
}

func TestPods(t *testing.T) {
	p := NewPods()
	full := "4f1d2c3b4a5968778695a4b3c2d1e0f0123456789abcdef0123456789abcdef0"
	p.Observe("containerd://"+full, "uid-1", "agents", "claude-0", "agent")
	if pod, c := p.Lookup(full, ""); pod != "agents/claude-0" || c != "agent" {
		t.Fatalf("by id: %q %q", pod, c)
	}
	if pod, _ := p.Lookup("", "uid-1"); pod != "agents/claude-0" {
		t.Fatalf("by pod uid: %q", pod)
	}
	// Tetragon's docker field is a shortened id
	p.Observe(full[:31], "", "ci", "runner", "job")
	other := full[:31] + "ffffffffffffffffffffffffffffffffd"
	if pod, _ := p.Lookup(other, ""); pod != "ci/runner" {
		t.Fatalf("prefix: %q", pod)
	}
	if pod, _ := p.Lookup("deadbeef", "nope"); pod != "" {
		t.Fatalf("unknown: %q", pod)
	}
	var nilPods *Pods
	nilPods.Observe(full, "", "a", "b", "c")
	if pod, _ := nilPods.Lookup(full, ""); pod != "" {
		t.Fatal("nil Pods")
	}
}

func TestLookupUserInRoot(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("container roots are read on Linux only")
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc", "passwd"), []byte("root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if n, h := lookupUser(root, 1000); n != "node" || h != "/home/node" {
		t.Fatalf("got %q %q", n, h)
	}
	if n, h := lookupUser(root, 4242); n != "uid:4242" || h != "" {
		t.Fatalf("unknown uid: %q %q", n, h)
	}
}
