// Package vmwatch reports agents that run inside their own virtual machine,
// where neither agent hooks nor the OS sensor can see their tool calls.
//
// Claude Cowork (the Claude desktop app) runs Claude Code in a Linux VM on
// the user's Mac (Apple Virtualization framework). The Mac's managed settings,
// and so effigentd's hook, aren't present inside it, and the VM's 127.0.0.1
// isn't ours. effigentd can't enforce there; it reports the VM as an agent
// that is not under policy, so the console shows it instead of nothing.
package vmwatch

import (
	"bufio"
	"bytes"
	"context"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// Agent is the name Claude Cowork's VM is reported under.
const Agent = "claude-cowork"

// Message explains, on every agent_start, why the agent isn't enforced.
const Message = "Claude Cowork runs Claude Code inside its own virtual machine: Effigent's hooks don't reach " +
	"inside it, so its commands, web requests and changes to the folders shared with it are not checked by policy"

// VM is one running virtual machine process that belongs to an agent.
type VM struct {
	PID    uint32
	UID    uint32
	Binary string
}

// Lister returns the agent VMs running now.
type Lister func(ctx context.Context) ([]VM, error)

// Default is the lister for this OS, nil where there is none yet.
func Default() Lister {
	if runtime.GOOS == "darwin" {
		return (&darwinLister{other: map[uint32]string{}}).list
	}
	return nil
}

// Watcher reports each agent VM once when it appears (agent_start) and when
// it goes away (agent_exit).
type Watcher struct {
	list   Lister
	emit   func(event.Event)
	logf   func(string, ...any)
	mu     sync.Mutex
	seen   map[uint32]VM
	failed bool
}

// New returns a watcher; list may be nil (nothing to watch on this OS).
func New(list Lister, emit func(event.Event), logf func(string, ...any)) *Watcher {
	return &Watcher{list: list, emit: emit, logf: logf, seen: map[uint32]VM{}}
}

// Run checks every interval until ctx is done.
func (w *Watcher) Run(ctx context.Context, every time.Duration) {
	if w.list == nil {
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		w.check(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Running is how many agent VMs are running now.
func (w *Watcher) Running() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.seen)
}

func (w *Watcher) check(ctx context.Context) {
	vms, err := w.list(ctx)
	if err != nil {
		if !w.failed { // say it once, not every interval
			w.logf("vm watch: %v", err)
		}
		w.failed = true
		return
	}
	w.failed = false
	w.mu.Lock()
	defer w.mu.Unlock()
	now := time.Now()
	live := map[uint32]bool{}
	for _, vm := range vms {
		live[vm.PID] = true
		if _, ok := w.seen[vm.PID]; ok {
			continue
		}
		w.seen[vm.PID] = vm
		w.logf("%s detected in a virtual machine (pid %d); not under policy", Agent, vm.PID)
		w.emit(event.Event{Time: now, Type: event.AgentStart, Severity: "medium", Agent: Agent, AgentPID: vm.PID,
			Mode: "unmanaged", Kind: "agent", Process: proc(vm), Message: Message})
	}
	for pid, vm := range w.seen {
		if live[pid] {
			continue
		}
		delete(w.seen, pid)
		w.emit(event.Event{Time: now, Type: event.AgentExit, Severity: "info", Agent: Agent, AgentPID: pid,
			Mode: "unmanaged", Kind: "agent", Process: proc(vm)})
	}
}

func proc(vm VM) *event.Proc {
	return &event.Proc{PID: vm.PID, Binary: vm.Binary, UID: vm.UID}
}

// The Apple Virtualization framework runs each VM in this XPC service.
const darwinVMBinary = "com.apple.Virtualization.VirtualMachine"

type darwinLister struct {
	other map[uint32]string // VM pids that aren't Cowork's (Docker Desktop…) → binary, so lsof runs once per VM
}

func (d *darwinLister) list(ctx context.Context) ([]VM, error) {
	out, err := exec.CommandContext(ctx, "/bin/ps", "-axww", "-o", "pid=,uid=,comm=").Output()
	if err != nil {
		return nil, err
	}
	var vms []VM
	live := map[uint32]bool{}
	for _, vm := range parsePS(out) {
		if !strings.HasSuffix(vm.Binary, "/"+darwinVMBinary) {
			continue
		}
		live[vm.PID] = true
		if d.other[vm.PID] == vm.Binary {
			continue
		}
		// Docker Desktop, UTM and others use the same service: only a VM with
		// Claude's disk images open is Cowork's.
		files, err := exec.CommandContext(ctx, "/usr/sbin/lsof", "-n", "-P", "-Fn", "-p", strconv.Itoa(int(vm.PID))).Output()
		if err != nil && len(files) == 0 {
			continue // exited in between, or lsof can't read it: try again next time
		}
		if IsCowork(lsofNames(files)) {
			vms = append(vms, vm)
		} else {
			d.other[vm.PID] = vm.Binary
		}
	}
	for pid := range d.other {
		if !live[pid] {
			delete(d.other, pid)
		}
	}
	return vms, nil
}

// IsCowork reports whether a VM process with these open files is Claude
// Cowork's: its kernel, initrd and disk images live in Claude.app and in the
// app's data folder.
func IsCowork(files []string) bool {
	for _, f := range files {
		if strings.Contains(f, "/Library/Application Support/Claude/vm_bundles/") ||
			strings.Contains(f, "/Library/Application Support/Claude/claude-code-vm/") ||
			(strings.Contains(f, "/Claude.app/Contents/") && strings.HasSuffix(f, ".img")) {
			return true
		}
	}
	return false
}

// parsePS reads `ps -o pid=,uid=,comm=` lines; comm is the executable path
// and may contain spaces.
func parsePS(out []byte) []VM {
	var vms []VM
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		pid, err1 := strconv.ParseUint(f[0], 10, 32)
		uid, err2 := strconv.ParseUint(f[1], 10, 32)
		if err1 != nil || err2 != nil {
			continue
		}
		line := strings.TrimSpace(sc.Text())
		bin := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(line, f[0])), f[1]))
		vms = append(vms, VM{PID: uint32(pid), UID: uint32(uid), Binary: bin})
	}
	return vms
}

// lsofNames returns the file names from `lsof -Fn` output (lines "n<name>").
func lsofNames(out []byte) []string {
	var names []string
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(l, "n") {
			names = append(names, l[1:])
		}
	}
	return names
}
