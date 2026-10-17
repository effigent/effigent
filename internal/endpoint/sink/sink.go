// Package sink delivers events: stdout (pretty or JSON lines), a JSONL file,
// and an HTTP backend (batched, bearer-authenticated, never blocks the engine).
package sink

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/effigent/effigent/internal/endpoint/event"
)

type Sink interface {
	Write(event.Event)
	Close() error
}

type Multi []Sink

func (m Multi) Write(e event.Event) {
	for _, s := range m {
		s.Write(e)
	}
}

func (m Multi) Close() error {
	for _, s := range m {
		_ = s.Close()
	}
	return nil
}

// ---- stdout / file ----

type JSONL struct {
	mu  sync.Mutex
	w   io.WriteCloser
	enc *json.Encoder
}

func NewJSONL(w io.WriteCloser) *JSONL { return &JSONL{w: w, enc: json.NewEncoder(w)} }

func OpenFile(path string) (*JSONL, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return NewJSONL(f), nil
}

func (s *JSONL) Write(e event.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.enc.Encode(e)
}

func (s *JSONL) Close() error { return s.w.Close() }

type Pretty struct {
	mu    sync.Mutex
	w     io.Writer
	color bool
}

func NewPretty(w io.Writer, color bool) *Pretty { return &Pretty{w: w, color: color} }

func (s *Pretty) Write(e event.Event) {
	who := fmt.Sprintf("%s[%d]", e.Agent, e.AgentPID)
	if e.Via != "" {
		who += " › " + e.Via
	}
	if e.Process != nil && e.Process.PID != e.AgentPID {
		who += fmt.Sprintf(" › %s[%d]", base(e.Process.Binary), e.Process.PID)
	}
	what := e.Target
	switch e.Type {
	case event.Exec:
		what = strings.TrimSpace(e.Process.Binary + " " + trunc(e.Process.Args, 100))
	case event.AgentStart:
		what = strings.TrimSpace(e.Process.Binary + " " + trunc(e.Process.Args, 100))
		if e.Mode != "" {
			what += "  (mode: " + e.Mode + ")"
		}
	case event.PolicyLoad:
		what = e.Message
		who = fmt.Sprintf("%s[%d]", e.Agent, e.AgentPID)
	}
	if e.Message != "" && e.Type != event.PolicyLoad {
		what += "  — " + e.Message
	}
	tag := strings.ToUpper(string(e.Type))
	if s.color {
		switch e.Severity {
		case "high":
			tag = "\033[1;31m" + tag + "\033[0m"
		case "medium":
			tag = "\033[33m" + tag + "\033[0m"
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Fprintf(s.w, "%s %-22s %s  %s\n", e.Time.Local().Format("15:04:05.000"), tag, who, what)
}

func (s *Pretty) Close() error { return nil }

func base(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
