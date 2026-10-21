// Package peer identifies the process on the other end of effigentd's hook
// socket: its pid, uid and gid come from the kernel (SO_PEERCRED), and the
// container and Kubernetes pod it runs in from that pid's cgroup, never from
// anything the caller says about itself. Agents in containers reach the
// node's daemon through this socket (see deploy/helm/effigent).
package peer

import (
	"bufio"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Info is who called, as the kernel tells it.
type Info struct {
	PID, UID, GID int
	// ContainerID is the 64-hex container id from the caller's cgroup ("" on
	// the host itself); PodUID the Kubernetes pod's uid when the cgroup is a
	// kubepods one.
	ContainerID string
	PodUID      string
	// Root is the caller's root directory as effigentd sees it
	// (<procfs>/<pid>/root) when the caller is in another mount namespace (a
	// container): files the hook reads for the call are read there. "" = same
	// file system as effigentd.
	Root string
	// User and Home are the caller's account, looked up by UID in the
	// caller's own /etc/passwd (a container's users aren't the host's).
	User, Home string
	// Pod is "namespace/name" and Container the container's name, from
	// Tetragon's pod info for this container ("" when unknown).
	Pod, Container string
	// Agent and AgentPID: the tracked agent (kernel sensor) the caller runs
	// under, found through its parent processes; "" when none is tracked.
	// It wins over the agent named in the hook's URL.
	Agent    string
	AgentPID int
}

var (
	containerRe = regexp.MustCompile(`(?:^|[/:\-])([0-9a-f]{64})(?:\.scope)?(?:/|$)`)
	podRe       = regexp.MustCompile(`pod([0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12})`)
)

// ParseCgroup finds the container id and pod uid in a /proc/<pid>/cgroup
// file: cgroup v2 (`0::/kubepods.slice/…-pod<uid>.slice/cri-containerd-<id>.scope`,
// `0::/docker/<id>`, `0::/system.slice/docker-<id>.scope`) and v1 lines alike.
func ParseCgroup(b []byte) (containerID, podUID string) {
	for _, line := range strings.Split(string(b), "\n") {
		// hierarchy-id:controllers:path
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		p := parts[2]
		if containerID == "" {
			// the innermost container id on the path
			if m := containerRe.FindAllStringSubmatch(p, -1); len(m) > 0 {
				containerID = m[len(m)-1][1]
			}
		}
		if podUID == "" {
			if m := podRe.FindStringSubmatch(p); m != nil {
				podUID = strings.ReplaceAll(m[1], "_", "-")
			}
		}
	}
	return containerID, podUID
}

// Resolve fills in what procfs says about pid: container, pod uid, root
// and account. procfs is the host's /proc as effigentd sees it ("/proc", or
// "/host/proc" in the DaemonSet).
func Resolve(procfs string, pid, uid, gid int, pods *Pods) Info {
	in := Info{PID: pid, UID: uid, GID: gid}
	if procfs == "" {
		procfs = "/proc"
	}
	dir := filepath.Join(procfs, strconv.Itoa(pid))
	if b, err := os.ReadFile(filepath.Join(dir, "cgroup")); err == nil {
		in.ContainerID, in.PodUID = ParseCgroup(b)
	}
	// Another mount namespace: its files are under /proc/<pid>/root.
	theirs, err1 := os.Readlink(filepath.Join(dir, "ns", "mnt"))
	ours, err2 := os.Readlink("/proc/self/ns/mnt")
	if err1 == nil && err2 == nil && theirs != ours {
		in.Root = filepath.Join(dir, "root")
	}
	in.User, in.Home = lookupUser(in.Root, uid)
	if pods != nil {
		in.Pod, in.Container = pods.Lookup(in.ContainerID, in.PodUID)
	}
	return in
}

// Ancestors returns pid's parent, grandparent… (nearest first, at most 64),
// from <procfs>/<pid>/status.
func Ancestors(procfs string, pid int) []int {
	if procfs == "" {
		procfs = "/proc"
	}
	var out []int
	for range 64 {
		b, err := os.ReadFile(filepath.Join(procfs, strconv.Itoa(pid), "status"))
		if err != nil {
			break
		}
		ppid := 0
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(line, "PPid:"); ok {
				ppid, _ = strconv.Atoi(strings.TrimSpace(v))
				break
			}
		}
		if ppid <= 0 || ppid == pid {
			break
		}
		out = append(out, ppid)
		pid = ppid
	}
	return out
}

// lookupUser reads the account for uid from root's /etc/passwd ("" root:
// effigentd's own). Unknown: "uid:<n>" and no home.
func lookupUser(root string, uid int) (name, home string) {
	f, err := OpenIn(root, "/etc/passwd")
	if err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		want := strconv.Itoa(uid)
		for sc.Scan() {
			// name:x:uid:gid:gecos:home:shell
			p := strings.Split(sc.Text(), ":")
			if len(p) >= 6 && p[2] == want {
				return p[0], p[5]
			}
		}
	}
	if root == "" {
		// our own system: directory services (LDAP, sssd) too
		if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
			return u.Username, u.HomeDir
		}
	}
	return "uid:" + strconv.Itoa(uid), ""
}

// Pods maps containers and pod uids to their pod, from Tetragon's process
// events (which carry Kubernetes pod info on clusters).
type Pods struct {
	mu   sync.Mutex
	byID map[string]podEntry // container id (or Tetragon's truncated docker id) -> pod
	byUD map[string]podEntry // pod uid -> pod
}

type podEntry struct {
	pod, container string
	at             time.Time
}

const maxPods = 4096

func NewPods() *Pods { return &Pods{byID: map[string]podEntry{}, byUD: map[string]podEntry{}} }

// Observe records one process event's pod: containerID may be a full id or
// Tetragon's "containerd://<id>" / truncated docker id.
func (p *Pods) Observe(containerID, podUID, namespace, name, container string) {
	if p == nil || name == "" {
		return
	}
	if i := strings.Index(containerID, "://"); i >= 0 {
		containerID = containerID[i+3:]
	}
	e := podEntry{pod: namespace + "/" + name, container: container, at: time.Now()}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.byID) > maxPods || len(p.byUD) > maxPods {
		p.prune()
	}
	if containerID != "" {
		p.byID[containerID] = e
	}
	if podUID != "" {
		p.byUD[podUID] = podEntry{pod: e.pod, at: e.at}
	}
}

// Lookup returns the pod ("namespace/name") and container name for a
// container id (a prefix match: Tetragon may shorten ids) or pod uid.
func (p *Pods) Lookup(containerID, podUID string) (pod, container string) {
	if p == nil {
		return "", ""
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if containerID != "" {
		if e, ok := p.byID[containerID]; ok {
			return e.pod, e.container
		}
		for id, e := range p.byID {
			if len(id) >= 12 && strings.HasPrefix(containerID, id) {
				return e.pod, e.container
			}
		}
	}
	if e, ok := p.byUD[podUID]; ok && podUID != "" {
		return e.pod, ""
	}
	return "", ""
}

// prune drops entries not seen for an hour (callers hold mu).
func (p *Pods) prune() {
	cut := time.Now().Add(-time.Hour)
	for k, e := range p.byID {
		if e.at.Before(cut) {
			delete(p.byID, k)
		}
	}
	for k, e := range p.byUD {
		if e.at.Before(cut) {
			delete(p.byUD, k)
		}
	}
}
