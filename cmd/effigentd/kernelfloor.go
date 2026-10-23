package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
)

// The kernel layer blocks only on Linux 5.12+ with BTF and BPF LSM: the
// self-protection guard reads inode_setattr / inode_unlink / inode_rename
// arguments in the layout 5.12 introduced (tetragon/render.go), Tetragon needs
// BTF, and LSM hooks need bpf in the active LSM list. Short of that the
// installer still installs, effigentd runs the kernel layer observe-only
// (agent hooks still enforce) and every heartbeat says why.
const kernelFloorMajor, kernelFloorMinor = 5, 12

// kernelVersion reads "5.15.0-100-generic" as (5, 15); ok is false when the
// release doesn't start with major.minor.
func kernelVersion(release string) (major, minor int, ok bool) {
	parts := strings.SplitN(strings.TrimSpace(release), ".", 3)
	if len(parts) < 2 {
		return 0, 0, false
	}
	n := 0
	for n < len(parts[1]) && parts[1][n] >= '0' && parts[1][n] <= '9' {
		n++
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1][:n])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return major, minor, true
}

// kernelObserveReasons lists why the kernel layer can't block on this kernel,
// empty when it can: older than 5.12 (or a release it can't read), no BTF,
// BPF LSM off.
func kernelObserveReasons(release string, btf, bpfLSM bool) []string {
	var why []string
	release = strings.TrimSpace(release)
	if major, minor, ok := kernelVersion(release); !ok {
		why = append(why, "kernel version "+strconv.Quote(release)+" not recognised (5.12+ needed)")
	} else if major < kernelFloorMajor || major == kernelFloorMajor && minor < kernelFloorMinor {
		why = append(why, "kernel "+release+" older than 5.12")
	}
	if !btf {
		why = append(why, "no BTF")
	}
	if !bpfLSM {
		why = append(why, "BPF LSM off")
	}
	return why
}

// kernelRelease is uname -r ("" when /proc isn't readable).
func kernelRelease() string {
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func btfPresent() bool {
	_, err := os.Stat("/sys/kernel/btf/vmlinux")
	return err == nil
}

// kernelObserveOnly is why this machine's kernel layer only observes, "" when
// it can block or there is no kernel layer (not Linux). Read once at start: a
// kernel, its BTF and its LSM list only change with a reboot.
func kernelObserveOnly() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	return strings.Join(kernelObserveReasons(kernelRelease(), btfPresent(), bpfLSMEnabled()), "; ")
}
