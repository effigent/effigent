package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

// DefaultHookSocket is where effigentd serves the hook API for containers
// (-hook-socket); agent pods mount its directory from the node.
const DefaultHookSocket = "/var/run/effigent/hook.sock"

// daemonTransport picks how `effigentd hook` reaches the daemon:
//
//	EFFIGENT_HOOK_SOCKET=/path          the hook socket (containers, pods)
//	EFFIGENT_DAEMON_URL=unix:///path    the same
//	EFFIGENT_DAEMON_URL=http://h:port   a daemon's TCP API elsewhere
//	EFFIGENT_API=host:port              (older name for the TCP address)
//
// Otherwise the hook socket when it exists (Linux), else 127.0.0.1:7777.
// It returns the base URL and the client to use.
func daemonTransport(timeout time.Duration) (string, *http.Client) {
	sock := strings.TrimSpace(os.Getenv("EFFIGENT_HOOK_SOCKET"))
	base := ""
	if u := strings.TrimSpace(os.Getenv("EFFIGENT_DAEMON_URL")); u != "" && sock == "" {
		if p, ok := strings.CutPrefix(u, "unix://"); ok {
			sock = p
		} else {
			base = strings.TrimSuffix(u, "/")
		}
	}
	if sock == "" && base == "" {
		if a := os.Getenv("EFFIGENT_API"); a != "" {
			base = "http://" + a
		} else if runtime.GOOS == "linux" && isSocket(DefaultHookSocket) {
			sock = DefaultHookSocket
		} else {
			base = "http://127.0.0.1:7777"
		}
	}
	if sock == "" {
		return base, &http.Client{Timeout: timeout}
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}
	return "http://effigentd", &http.Client{Timeout: timeout, Transport: tr}
}

func isSocket(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode()&os.ModeSocket != 0
}
