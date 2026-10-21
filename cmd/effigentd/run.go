package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

// runAgent implements `effigentd run --agent NAME [--timeout 10s] [--strict] -- cmd args...`.
//
// The daemon sees this process start and loads the agent's kernel policies
// for its pid (~1s). We wait until the kernel refuses to open the canary
// file — proof the policies are live — then exec the agent in place (same
// pid), so not a single instruction of the agent runs unenforced.
func runAgent(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	agent := fs.String("agent", "", "agent name from the policy (selects its rule)")
	timeout := fs.Duration("timeout", 10*time.Second, "how long to wait for enforcement")
	strict := fs.Bool("strict", false, "refuse to start the agent if enforcement is not confirmed")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: effigentd run --agent NAME [--timeout 10s] [--strict] -- command [args...]")
		fs.PrintDefaults()
	}
	_ = fs.Parse(args)
	cmd := fs.Args()
	if *agent == "" || len(cmd) == 0 {
		fs.Usage()
		os.Exit(2)
	}
	bin, err := exec.LookPath(cmd[0])
	if err != nil {
		fatalf("%v", err)
	}

	// Gated binaries (FR Q3): put PATH shims in front so bare invocations route
	// through `effigentd gate`, and refuse to launch the agent command itself if
	// it is a gated binary (that would run as effigentd, exempt from the kernel
	// gate). Best effort: if the daemon can't be reached the kernel still blocks
	// a direct exec, so the agent simply can't use the binary.
	runEnv := os.Environ()
	if gated := gatedPaths(*agent); len(gated) > 0 {
		if real, rerr := filepath.EvalSymlinks(bin); rerr == nil {
			if slices.Contains(gated, real) || slices.Contains(gated, bin) {
				fatalf("%q is a gated binary; run it through `effigentd gate -- %s …`, not as the agent command (that would bypass the gate)", cmd[0], cmd[0])
			}
		}
		runEnv = withShims(*agent, gated, runEnv)
	}

	dir, err := os.MkdirTemp("", "effigent-run-")
	if err != nil {
		fatalf("%v", err)
	}
	canary := filepath.Join(dir, filepath.Base(policy.CanarySuffix))
	if err := os.WriteFile(canary, nil, 0o600); err != nil {
		fatalf("%v", err)
	}
	start := time.Now()
	enforced := false
	for time.Since(start) < *timeout {
		f, err := os.Open(canary)
		if errors.Is(err, syscall.EPERM) {
			enforced = true
			break
		}
		if err == nil {
			f.Close()
		}
		time.Sleep(20 * time.Millisecond)
	}
	// The agent's tools run as child processes: the rules must follow forks,
	// not only cover this pid. Check that with a child before saying so.
	children := false
	if enforced {
		children = childRefused(canary)
	}
	_ = os.Remove(canary) // unlink isn't a file_open, so this works under the policy
	_ = os.Remove(dir)

	switch {
	case !enforced:
		msg := fmt.Sprintf("enforcement for %q not confirmed after %s (is the effigentd daemon running?)", *agent, *timeout)
		if *strict {
			fatalf("%s; not starting the agent (--strict)", msg)
		}
		fmt.Fprintf(os.Stderr, "effigentd: warning: %s; starting anyway\n", msg)
	case !children:
		msg := fmt.Sprintf("the kernel rules for %q cover this process but not the processes it starts, so the agent's commands would NOT be enforced on this machine", *agent)
		if *strict {
			fatalf("%s; not starting the agent (--strict)", msg)
		}
		fmt.Fprintf(os.Stderr, "effigentd: WARNING: %s; starting anyway\n", msg)
	case os.Getenv("EFFIGENT_RUN_QUIET") == "":
		fmt.Fprintf(os.Stderr, "effigentd: %s enforced after %s\n", *agent, time.Since(start).Round(time.Millisecond))
	}
	if err := syscall.Exec(bin, cmd, runEnv); err != nil {
		fatalf("exec %s: %v", bin, err)
	}
}

// gatedPaths asks the daemon which binaries are gated for this agent (FR Q3).
// Best effort: any error means no shims (the kernel still blocks a direct exec).
func gatedPaths(agent string) []string {
	addr := os.Getenv("EFFIGENT_API")
	if addr == "" {
		addr = "127.0.0.1:7777"
	}
	req, err := http.NewRequest(http.MethodGet, "http://"+addr+"/gated/"+agent, nil)
	if err != nil {
		return nil
	}
	res, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	var d struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&d); err != nil {
		return nil
	}
	return d.Paths
}

// withShims builds a shim directory of symlinks (basename -> effigentd), prepends
// it to PATH, and sets EFFIGENT_AGENT / EFFIGENT_SHIM_DIR, so the agent's bare
// invocations of a gated binary route through `effigentd gate` (FR Q3). The
// symlinks resolve to the real effigentd binary, so a noexec shim dir is fine.
// On any failure it returns env unchanged (the kernel still blocks direct exec).
func withShims(agent string, gated, env []string) []string {
	self, err := os.Executable()
	if err != nil {
		return env
	}
	if resolved, rerr := filepath.EvalSymlinks(self); rerr == nil {
		self = resolved
	}
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		base = os.TempDir()
	}
	dir, err := os.MkdirTemp(base, "effigent-shims-")
	if err != nil {
		return env
	}
	made := false
	for _, p := range gated {
		name := filepath.Base(p)
		if name == "" || name == "." || name == "/" {
			continue
		}
		link := filepath.Join(dir, name)
		_ = os.Remove(link)
		if os.Symlink(self, link) == nil {
			made = true
		}
	}
	if !made {
		_ = os.RemoveAll(dir)
		return env
	}
	out := make([]string, 0, len(env)+2)
	for _, kv := range env {
		switch {
		case strings.HasPrefix(kv, "PATH="):
			out = append(out, "PATH="+dir+string(os.PathListSeparator)+strings.TrimPrefix(kv, "PATH="))
		case strings.HasPrefix(kv, "EFFIGENT_AGENT="), strings.HasPrefix(kv, "EFFIGENT_SHIM_DIR="):
			// replaced below
		default:
			out = append(out, kv)
		}
	}
	if !hasPrefix(out, "PATH=") {
		out = append(out, "PATH="+dir+string(os.PathListSeparator)+"/usr/local/bin:/usr/bin:/bin")
	}
	out = append(out, "EFFIGENT_AGENT="+agent, "EFFIGENT_SHIM_DIR="+dir)
	return out
}

func hasPrefix(env []string, prefix string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			return true
		}
	}
	return false
}

// childRefused starts a short-lived child (`effigentd run-probe CANARY`) and
// reports whether the kernel refused it the canary too — proof the policy
// follows forks. A few tries: the child's tracking can lag its fork briefly.
func childRefused(canary string) bool {
	self, err := os.Executable()
	if err != nil {
		return false
	}
	for i := 0; i < 5; i++ {
		c := exec.Command(self, "run-probe", canary)
		c.Stdin, c.Stdout, c.Stderr = nil, nil, nil
		if err := c.Run(); err == nil {
			return true // exit 0: refused
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// runProbe is the child half of childRefused: exit 0 when opening the canary
// is refused (EPERM), 1 when it opens, 2 on any other error.
func runProbe(args []string) {
	if len(args) != 1 {
		os.Exit(2)
	}
	f, err := os.Open(args[0])
	switch {
	case errors.Is(err, syscall.EPERM):
		os.Exit(0)
	case err == nil:
		f.Close()
		os.Exit(1)
	}
	os.Exit(2)
}

func fatalf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "effigentd: "+format+"\n", a...)
	os.Exit(1)
}
