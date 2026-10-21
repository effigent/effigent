package api

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"

	"github.com/effigent/effigent/internal/endpoint/peer"
)

type peerKey struct{}

// HookSocket serves only the hook API (POST /hook/{agent}, GET /health) on a
// unix socket, for agents that can't reach the TCP API: containers and pods
// that mount the socket's directory (deploy/helm/effigent, deploy/docker).
// Who is calling comes from the kernel (SO_PEERCRED) and resolve, never from
// the request; a caller whose credentials can't be read is refused.
type HookSocket struct {
	Path    string
	Server  *Server
	Resolve func(pid, uid, gid int) *peer.Info
	Logf    func(string, ...any)

	srv *http.Server
}

// Serve listens until ctx ends. The socket is world-writable (0666): any
// local process may ask, and every answer depends on who the kernel says it
// is. The directory is created 0755.
func (h *HookSocket) Serve(ctx context.Context) error {
	if err := os.MkdirAll(filepath.Dir(h.Path), 0o755); err != nil {
		return err
	}
	if st, err := os.Lstat(h.Path); err == nil && st.Mode()&os.ModeSocket != 0 {
		_ = os.Remove(h.Path) // left by a previous run
	}
	ln, err := net.Listen("unix", h.Path)
	if err != nil {
		return err
	}
	if err := os.Chmod(h.Path, 0o666); err != nil {
		ln.Close()
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /hook/{agent}", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := r.Context().Value(peerKey{}).(*peer.Info); !ok {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "the caller's credentials could not be read"})
			return
		}
		h.Server.hook(w, r)
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	h.srv = &http.Server{Handler: mux, ConnContext: func(ctx context.Context, c net.Conn) context.Context {
		pid, uid, gid, err := peer.Cred(c)
		if err != nil || pid <= 0 {
			if h.Logf != nil {
				h.Logf("hook socket: caller unknown: %v", err)
			}
			return ctx
		}
		return context.WithValue(ctx, peerKey{}, h.Resolve(pid, uid, gid))
	}}
	go func() {
		<-ctx.Done()
		_ = h.srv.Close()
		_ = os.Remove(h.Path)
	}()
	if err := h.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
