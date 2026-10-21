//go:build linux

package api

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/effigent/effigent/internal/endpoint/peer"
)

// The hook socket hands the handler the kernel's view of the caller, and
// ignores what the request claims.
func TestHookSocketPeer(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "run", "hook.sock")
	got := make(chan HookCall, 1)
	srv := &Server{Hook: func(ctx context.Context, c HookCall) ([]byte, error) {
		got <- c
		return []byte("{}"), nil
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hs := &HookSocket{Path: sock, Server: srv, Resolve: func(pid, uid, gid int) *peer.Info {
		return &peer.Info{PID: pid, UID: uid, GID: gid, User: "kernel-says"}
	}}
	go func() { _ = hs.Serve(ctx) }()
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if st, err := os.Stat(sock); err != nil || st.Mode().Perm() != 0o666 {
		t.Fatalf("socket: %v %v", st, err)
	}
	c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	req, _ := http.NewRequest(http.MethodPost, "http://effigentd/hook/claude", strings.NewReader(`{"tool_name":"Bash"}`))
	req.Header.Set("X-Effigent-OS-User", "root")
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(b) != "{}" {
		t.Fatalf("%d %s", res.StatusCode, b)
	}
	call := <-got
	if call.Peer == nil || call.Peer.PID != os.Getpid() || call.Peer.UID != os.Getuid() || call.Peer.User != "kernel-says" {
		t.Fatalf("peer: %+v", call.Peer)
	}
	// only the hook API is served
	res, err = c.Get("http://effigentd/policy")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /policy on the socket: %d", res.StatusCode)
	}
}
