package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	_ = os.Remove(canary) // unlink isn't a file_open, so this works under the policy
	_ = os.Remove(dir)

	if !enforced {
		msg := fmt.Sprintf("enforcement for %q not confirmed after %s (is the effigentd daemon running?)", *agent, *timeout)
		if *strict {
			fatalf("%s; not starting the agent (--strict)", msg)
		}
		fmt.Fprintf(os.Stderr, "effigentd: warning: %s; starting anyway\n", msg)
	} else if os.Getenv("EFFIGENT_RUN_QUIET") == "" {
		fmt.Fprintf(os.Stderr, "effigentd: %s enforced after %s\n", *agent, time.Since(start).Round(time.Millisecond))
	}
	if err := syscall.Exec(bin, cmd, os.Environ()); err != nil {
		fatalf("exec %s: %v", bin, err)
	}
}

func fatalf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "effigentd: "+format+"\n", a...)
	os.Exit(1)
}
