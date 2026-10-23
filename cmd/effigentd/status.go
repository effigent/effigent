package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"
)

// statusCmd implements `effigentd status`: is the daemon up, connected to
// Tetragon, able to block, enrolled, and on which policy version.
func statusCmd(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	addr := fs.String("api", "127.0.0.1:7777", "effigentd local API address")
	asJSON := fs.Bool("json", false, "print raw JSON")
	_ = fs.Parse(args)

	c := &http.Client{Timeout: 3 * time.Second}
	res, err := c.Get("http://" + *addr + "/health")
	if err != nil {
		fatalf("effigentd is not running (%v). Check: systemctl status effigentd", err)
	}
	defer res.Body.Close()
	var h map[string]any
	if err := json.NewDecoder(res.Body).Decode(&h); err != nil {
		fatalf("unexpected response from effigentd: %v", err)
	}
	if *asJSON {
		b, _ := json.MarshalIndent(h, "", "  ")
		fmt.Println(string(b))
	}
	yes := func(k string) bool { v, _ := h[k].(bool); return v }
	mark := func(ok bool) string {
		if ok {
			return "ok "
		}
		return "-- "
	}
	if !*asJSON {
		fmt.Printf("%s effigentd %v running\n", mark(true), h["version"])
		hooksOnly := h["sensor"] == "hooks"
		if hooksOnly {
			fmt.Printf("%s Agent hooks mode (no kernel enforcement)\n", mark(true))
		} else {
			fmt.Printf("%s Tetragon connected\n", mark(yes("tetragon_connected")))
		}
		if why, _ := h["observe_only"].(string); why != "" {
			fmt.Printf("%s Kernel layer observe-only (kernel enforcement off): %s; agent hooks still enforce\n", mark(false), why)
		} else if hooksOnly {
		} else if yes("bpf_lsm") {
			fmt.Printf("%s Blocking available (BPF LSM enabled)\n", mark(true))
		} else {
			fmt.Printf("%s Blocking unavailable: BPF LSM is off, so agents are watched but not blocked\n", mark(false))
		}
		if id, ok := h["endpoint_id"].(string); ok {
			fmt.Printf("%s Enrolled as %s with %v (%v)\n", mark(true), id, h["control_plane"], h["tenant"])
			fmt.Printf("%s Policy version %v\n", mark(h["policy_version"] != float64(0)), h["policy_version"])
		} else {
			fmt.Printf("%s Not enrolled (local policy only)\n", mark(false))
		}
		fmt.Printf("    Agents being watched right now: %v\n", h["agents"])
		if n, _ := h["unmanaged_agents"].(float64); n > 0 {
			fmt.Printf("%s Claude Cowork is running in its own virtual machine (%v): reported, not under policy\n", mark(false), n)
		}
	}
	if h["sensor"] != "hooks" && !yes("tetragon_connected") {
		os.Exit(1)
	}
}
