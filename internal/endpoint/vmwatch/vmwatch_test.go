package vmwatch

import (
	"context"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/event"
)

func TestIsCowork(t *testing.T) {
	cowork := []string{
		"/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine",
		"/Applications/Claude.app/Contents/Resources/smol-bin.arm64.img",
		"/Users/jane/Library/Application Support/Claude/vm_bundles/claudevm.bundle/initrd-micro",
	}
	if !IsCowork(cowork) {
		t.Fatal("Cowork's VM not recognised")
	}
	if !IsCowork([]string{"/Users/jane/Library/Application Support/Claude/claude-code-vm/2.1.258/claude"}) {
		t.Fatal("Claude Code from claude-code-vm not recognised")
	}
	docker := []string{
		"/Applications/Docker.app/Contents/Resources/linuxkit/boot.img",
		"/Users/jane/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw",
	}
	if IsCowork(docker) {
		t.Fatal("Docker Desktop's VM taken for Cowork")
	}
	if IsCowork([]string{"/Applications/Claude.app/Contents/Resources/app.asar"}) {
		t.Fatal("a non-image Claude.app file is not a VM disk")
	}
}

func TestParsePS(t *testing.T) {
	out := []byte("  25519   501 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine\n" +
		"28835   501 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper\n" +
		"garbage\n")
	vms := parsePS(out)
	if len(vms) != 2 {
		t.Fatalf("got %d entries", len(vms))
	}
	if vms[0].PID != 25519 || vms[0].UID != 501 || vms[0].Binary[len(vms[0].Binary)-len(darwinVMBinary):] != darwinVMBinary {
		t.Fatalf("first: %+v", vms[0])
	}
	if vms[1].Binary != "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper" {
		t.Fatalf("path with spaces: %q", vms[1].Binary)
	}
}

func TestLsofNames(t *testing.T) {
	got := lsofNames([]byte("p30357\nfcwd\nn/\nftxt\nn/Applications/Claude.app/Contents/Resources/smol-bin.arm64.img\n"))
	if len(got) != 2 || got[1] != "/Applications/Claude.app/Contents/Resources/smol-bin.arm64.img" {
		t.Fatalf("%q", got)
	}
}

func TestWatcherStartExit(t *testing.T) {
	var now []VM
	var got []event.Event
	w := &watcher{
		list: func(context.Context) ([]VM, error) { return now, nil },
		emit: func(e event.Event) { got = append(got, e) },
		logf: func(string, ...any) {},
		seen: map[uint32]VM{},
	}
	ctx := context.Background()
	w.check(ctx)
	if len(got) != 0 {
		t.Fatalf("events with no VM: %v", got)
	}
	now = []VM{{PID: 7, UID: 501, Binary: "/x/" + darwinVMBinary}}
	w.check(ctx)
	w.check(ctx) // still running: no second start
	if len(got) != 1 || got[0].Type != event.AgentStart || got[0].Agent != Agent || got[0].Mode != "unmanaged" ||
		got[0].Process == nil || got[0].Process.UID != 501 || got[0].Message == "" {
		t.Fatalf("start: %+v", got)
	}
	now = nil
	w.check(ctx)
	if len(got) != 2 || got[1].Type != event.AgentExit || got[1].AgentPID != 7 {
		t.Fatalf("exit: %+v", got)
	}
}
