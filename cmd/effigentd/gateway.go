package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/gateway"
)

// sessions joins what the agents' hooks and the model gateway each know
// about a session: the hooks say who runs it (OS user, git email), the
// gateway that its model calls go through it (require_gateway).
type sessions struct {
	mu sync.Mutex
	m  map[string]*sessionInfo // agent/session
}

type sessionInfo struct {
	id        gateway.Identity
	hookAt    time.Time
	gatewayAt time.Time
}

// viaGatewayWindow: a session whose model calls the gateway carried this
// recently counts as going through it. Every tool call follows a model call,
// so an active session is seen far more often.
const viaGatewayWindow = 30 * time.Minute

func newSessions() *sessions { return &sessions{m: map[string]*sessionInfo{}} }

func (s *sessions) get(agent, session string) *sessionInfo {
	k := agent + "/" + session
	si := s.m[k]
	if si == nil {
		if len(s.m) > 20000 {
			s.prune()
		}
		si = &sessionInfo{}
		s.m[k] = si
	}
	return si
}

func (s *sessions) prune() {
	for k, si := range s.m {
		if time.Since(si.hookAt) > 24*time.Hour && time.Since(si.gatewayAt) > 24*time.Hour {
			delete(s.m, k)
		}
	}
}

// hook records a hook call's identity.
func (s *sessions) hook(agent, session string, id gateway.Identity) {
	if session == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	si := s.get(agent, session)
	si.id, si.hookAt = id, time.Now()
}

// sawGateway records a model call through the gateway.
func (s *sessions) sawGateway(agent, session string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.get(agent, session).gatewayAt = time.Now()
}

func (s *sessions) identity(agent, session string) (gateway.Identity, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	si := s.m[agent+"/"+session]
	if si == nil || si.hookAt.IsZero() {
		return gateway.Identity{}, false
	}
	return si.id, true
}

func (s *sessions) viaGateway(agent, session string) bool {
	if session == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	si := s.m[agent+"/"+session]
	return si != nil && !si.gatewayAt.IsZero() && time.Since(si.gatewayAt) < viaGatewayWindow
}

// startGateway serves the model gateway on addr (loopback only) until ctx ends.
func startGateway(ctx context.Context, addr string, eng *engine.Engine, sess *sessions, logger *log.Logger) (stop func(), err error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("-gateway %q: %v", addr, err)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, fmt.Errorf("-gateway %q: the model gateway listens on loopback only (e.g. %s)", addr, gateway.DefaultAddr)
	}
	g, err := gateway.New(gateway.Config{
		Rule: eng.RuleFor, Emit: eng.Emit, Session: sess.identity, Seen: sess.sawGateway,
		Peer: gateway.PeerUser, Logf: logger.Printf,
	})
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("model gateway: %v", err)
	}
	// No write timeout: a streamed answer runs as long as the model writes.
	srv := &http.Server{Handler: g, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 5 * time.Minute}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Printf("model gateway: %v", err)
		}
	}()
	logger.Printf("model gateway on http://%s", addr)
	return func() {
		c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}, nil
}
