// effigentd watches AI agents, their MCP servers and the tools they run, and
// (on Linux, via Tetragon + BPF LSM) blocks what the policy denies.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/effigent/effigent/internal/endpoint/api"
	"github.com/effigent/effigent/internal/endpoint/cpclient"
	"github.com/effigent/effigent/internal/endpoint/domains"
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/endpoint/procscan"
	"github.com/effigent/effigent/internal/endpoint/sink"
	"github.com/effigent/effigent/internal/endpoint/tetragon"
)

var (
	tgConnected   atomic.Bool
	policyVersion atomic.Int64
)

// bpfLSMEnabled reports whether the kernel can enforce (not just observe).
func bpfLSMEnabled() bool {
	b, err := os.ReadFile("/sys/kernel/security/lsm")
	return err == nil && strings.Contains(","+strings.TrimSpace(string(b))+",", ",bpf,")
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "run":
			runAgent(os.Args[2:])
			return
		case "enroll":
			enrollCmd(os.Args[2:])
			return
		case "status":
			statusCmd(os.Args[2:])
			return
		case "hook":
			hookCmd(os.Args[2:])
			return
		case "install-hooks":
			installHooksCmd(os.Args[2:])
			return
		}
	}
	if runAsServiceIfNeeded(daemon) {
		return
	}
	daemon()
}

// daemon is the long-running endpoint agent.
func daemon() {
	var (
		tetragonAddr = flag.String("tetragon", "127.0.0.1:54321", "Tetragon gRPC address")
		sensor       = flag.String("sensor", defaultSensor(), "tetragon (Linux kernel enforcement) | hooks (agent pre-tool hooks only, e.g. macOS)")
		policyFile   = flag.String("policy", "", "policy YAML (default: built-in)")
		listen       = flag.String("listen", "127.0.0.1:7777", "REST API address (\"\" to disable)")
		output       = flag.String("output", "pretty", "stdout format: pretty | json | none")
		logFile      = flag.String("log-file", "", "also append events as JSON lines to this file")
		backendURL   = flag.String("backend-url", "", "POST event batches to this URL (token from $EFFIGENT_BACKEND_TOKEN)")
		backendMin   = flag.String("backend-min-severity", "", "only send events at or above: info | medium | high")
		procfs       = flag.String("procfs", defaultProcfs(), "host /proc for detecting already-running agents (\"\" to disable)")
		verbose      = flag.Bool("v", false, "also report exits of tools inside agent trees")
		keepPolicies = flag.Bool("keep-policies-on-exit", false, "leave agents' kernel policies loaded when effigentd stops (fail-closed); they are reconciled on next start")
		stateDir     = flag.String("state-dir", cpclient.DefaultStateDir(), "enrollment state; when enrolled, policy comes from the control plane")
		syncEvery    = flag.Duration("sync-interval", 5*time.Second, "how often an enrolled endpoint checks for a new policy")
		dnsRefresh   = flag.Duration("dns-refresh", 30*time.Second, "how often domain_deny hostnames are re-resolved")
		dnsServers   = flag.String("dns-servers", strings.Join(domains.DefaultUpstreams, ","), "resolvers queried for domain_deny next to the system resolver (comma-separated host:port, \"\" for the system resolver only)")
	)
	flag.Parse()
	logger := log.New(os.Stderr, "effigentd: ", log.LstdFlags)

	pol, raw, err := policy.Load(*policyFile)
	if err != nil {
		logger.Fatal(err)
	}

	var sinks sink.Multi
	switch *output {
	case "pretty":
		sinks = append(sinks, sink.NewPretty(os.Stdout, isTTY()))
	case "json":
		sinks = append(sinks, sink.NewJSONL(os.Stdout))
	case "none":
	default:
		logger.Fatalf("unknown -output %q", *output)
	}
	if *logFile != "" {
		f, err := sink.OpenFile(*logFile)
		if err != nil {
			logger.Fatal(err)
		}
		sinks = append(sinks, f)
	}
	var backend *sink.HTTP
	if *backendURL != "" {
		backend = sink.NewHTTP(sink.HTTPConfig{URL: *backendURL, Token: os.Getenv("EFFIGENT_BACKEND_TOKEN"), MinSeverity: *backendMin})
		sinks = append(sinks, backend)
	}
	cp, _ := cpclient.LoadState(*stateDir)
	if cp != nil {
		// Enrolled: ship every event to the control plane too.
		// Batches the control plane can't take wait on disk (up to 256 MB) and are sent when it's back.
		sinks = append(sinks, sink.NewHTTP(sink.HTTPConfig{URL: cp.Server + "/ep/v1/events", Token: cp.Secret, Interval: 2 * time.Second,
			SpoolDir: filepath.Join(*stateDir, "spool")}))
		logger.Printf("enrolled as %s with %s", cp.EndpointID, cp.Server)
	}
	defer sinks.Close()

	hooksOnly := *sensor == "hooks"
	var tg *tetragon.Client
	var enf engine.Enforcer // stays nil in hooks mode: nothing to load into a kernel
	if !hooksOnly {
		tg, err = tetragon.Dial(*tetragonAddr)
		if err != nil {
			logger.Fatal(err)
		}
		defer tg.Close()
		enf = tg
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { <-serviceStop; stop() }() // Windows service stop/shutdown

	eng := engine.New(pol, raw, enf, sinks.Write, logger.Printf, *verbose)
	var upstreams []string
	for _, u := range strings.Split(*dnsServers, ",") {
		if u = strings.TrimSpace(u); u != "" {
			upstreams = append(upstreams, u)
		}
	}
	resolver := domains.New(upstreams, logger.Printf)
	eng.UseResolver(ctx, resolver, *procfs)
	go resolver.Run(ctx, *dnsRefresh, eng.OnDomainsChanged)

	var client *cpclient.Client // nil when not enrolled
	if cp != nil {
		client = &cpclient.Client{
			State: cp, Dir: *stateDir, Logf: logger.Printf, AgentVersion: version,
			Apply: func(ctx context.Context, body []byte) error {
				_, err := eng.SetPolicy(ctx, body)
				return err
			},
			OnApply: func(v int64) {
				policyVersion.Store(v)
				logger.Printf("applied policy v%d from the control plane", v)
				sinks.Write(event.Event{Time: time.Now(), Type: event.PolicyLoad, Severity: "info",
					Rule: fmt.Sprintf("v%d", v), Message: fmt.Sprintf("policy v%d from the control plane is active", v)})
			},
		}
	}

	if *listen != "" {
		srv := &http.Server{Addr: *listen, Handler: (&api.Server{
			Engine: eng, Token: os.Getenv("EFFIGENT_API_TOKEN"), Managed: cp != nil,
			Hook: hookHandler(eng, func() *cpclient.Client { return client }),
			Stats: func() map[string]any {
				out := map[string]any{
					"tetragon_connected": tgConnected.Load(),
					"sensor":             *sensor,
					"bpf_lsm":            bpfLSMEnabled(),
					"policy_version":     policyVersion.Load(),
					"version":            version,
				}
				if cp != nil {
					out["endpoint_id"], out["control_plane"], out["tenant"] = cp.EndpointID, cp.Server, cp.Tenant
				}
				if backend != nil {
					s, d := backend.Stats()
					out["backend_sent"], out["backend_dropped"] = s, d
				}
				return out
			},
		}).Handler()}
		go func() {
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Fatalf("api: %v", err)
			}
		}()
		defer srv.Shutdown(context.Background())
		logger.Printf("API on http://%s", *listen)
	}

	if client != nil {
		if err := client.LoadCached(ctx); err != nil {
			logger.Printf("cached policy: %v", err)
		}
		go client.Run(ctx, *syncEvery)
	}

	if hooksOnly {
		logger.Printf("sensor: agent hooks only (no kernel enforcement on %s)", runtime.GOOS)
		<-ctx.Done()
		return
	}

	events := make(chan event.Raw, 4096)
	first := true
	go tg.Run(ctx, events, func() {
		logger.Printf("connected to Tetragon at %s", *tetragonAddr)
		tgConnected.Store(true)
		if first && *procfs != "" {
			if procs, ppid, err := procscan.Scan(*procfs); err != nil {
				logger.Printf("procfs scan: %v", err)
			} else {
				eng.Bootstrap(ctx, procs, ppid)
			}
		}
		first = false
		eng.Reconcile(ctx)
	}, logger.Printf)

	if *procfs != "" {
		go func() {
			t := time.NewTicker(30 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					eng.Sweep(ctx, procscan.Alive(*procfs))
				}
			}
		}()
	}

	eng.Run(ctx, events)

	if *keepPolicies {
		logger.Printf("leaving %d agents' kernel policies loaded (-keep-policies-on-exit)", len(eng.Agents()))
		return
	}
	// Leave no enforcement behind for agents we no longer watch.
	cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, r := range eng.Agents() {
		for _, n := range r.Policies {
			_ = tg.Delete(cleanup, n)
		}
	}
}

// defaultSensor is the kernel sensor on Linux and agent hooks elsewhere.
func defaultSensor() string {
	if runtime.GOOS == "linux" {
		return "tetragon"
	}
	return "hooks"
}

// defaultProcfs enables /proc scanning only on Linux, where effigentd is
// expected to run on the same host (pid namespace) as Tetragon.
func defaultProcfs() string {
	if runtime.GOOS == "linux" {
		return "/proc"
	}
	return ""
}

func isTTY() bool {
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
