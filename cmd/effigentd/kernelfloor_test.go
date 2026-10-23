package main

import (
	"slices"
	"testing"
)

func TestKernelVersion(t *testing.T) {
	for in, want := range map[string][2]int{
		"5.15.0-100-generic": {5, 15}, "6.11.0": {6, 11}, "5.4.0-1103-aws": {5, 4},
		"4.19": {4, 19}, "5.12.0-rc3": {5, 12}, "6.8.0-1015-azure\n": {6, 8}, "5.10.226-214.880.amzn2.x86_64": {5, 10},
	} {
		major, minor, ok := kernelVersion(in)
		if !ok || major != want[0] || minor != want[1] {
			t.Errorf("kernelVersion(%q) = %d.%d %v, want %v", in, major, minor, ok, want)
		}
	}
	for _, in := range []string{"", "6", "x.y", "linux-6.1"} {
		if _, _, ok := kernelVersion(in); ok {
			t.Errorf("kernelVersion(%q) ok", in)
		}
	}
}

func TestKernelObserveReasons(t *testing.T) {
	for _, c := range []struct {
		release     string
		btf, bpfLSM bool
		want        []string
	}{
		{"6.11.0-1-generic", true, true, nil},
		{"5.12.0", true, true, nil},
		{"5.11.22", true, true, []string{"kernel 5.11.22 older than 5.12"}},
		{"4.18.0-553.el8_10.x86_64", false, false, []string{"kernel 4.18.0-553.el8_10.x86_64 older than 5.12", "no BTF", "BPF LSM off"}},
		{"6.8.0-45-generic", true, false, []string{"BPF LSM off"}},
		{"6.1.0", false, true, []string{"no BTF"}},
		{"", true, true, []string{`kernel version "" not recognised (5.12+ needed)`}},
	} {
		if got := kernelObserveReasons(c.release, c.btf, c.bpfLSM); !slices.Equal(got, c.want) {
			t.Errorf("kernelObserveReasons(%q, %v, %v) = %q, want %q", c.release, c.btf, c.bpfLSM, got, c.want)
		}
	}
}

func TestKernelStatusReportsObserveOnly(t *testing.T) {
	k := kernelStatus("tetragon", "kernel 5.4.0 older than 5.12; BPF LSM off")
	if k["observe_only"] != "kernel 5.4.0 older than 5.12; BPF LSM off" || k["sensor"] != "tetragon" {
		t.Errorf("kernel status: %v", k)
	}
	if _, ok := kernelStatus("tetragon", "")["observe_only"]; ok {
		t.Error("observe_only sent for a kernel that can block")
	}
}
