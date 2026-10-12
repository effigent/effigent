// Package sink delivers events: stdout (pretty or JSON lines), a JSONL file,
// and an HTTP backend (batched, bearer-authenticated, never blocks the engine).
package sink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

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

// ---- HTTP backend ----

type HTTPConfig struct {
	URL         string
	Token       string        // sent as "Authorization: Bearer <token>"
	BatchSize   int           // flush when this many events are buffered
	Interval    time.Duration // ...or this often
	QueueSize   int           // events buffered in memory before dropping
	MinSeverity string        // drop events below this severity ("" = send all)
}

// HTTP POSTs {"events":[...]} batches. It never blocks the engine: when the
// backend is down and the queue is full, events are dropped and counted.
type HTTP struct {
	cfg     HTTPConfig
	q       chan event.Event
	done    chan struct{}
	client  *http.Client
	dropped atomic.Uint64
	sent    atomic.Uint64
}

func NewHTTP(cfg HTTPConfig) *HTTP {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 200
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 5 * time.Second
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 10000
	}
	h := &HTTP{cfg: cfg, q: make(chan event.Event, cfg.QueueSize), done: make(chan struct{}),
		client: &http.Client{Timeout: 10 * time.Second}}
	go h.loop()
	return h
}

var sevRank = map[string]int{"": 0, "info": 0, "medium": 1, "high": 2}

func (h *HTTP) Write(e event.Event) {
	if sevRank[e.Severity] < sevRank[h.cfg.MinSeverity] {
		return
	}
	select {
	case h.q <- e:
	default:
		h.dropped.Add(1)
	}
}

func (h *HTTP) Stats() (sent, dropped uint64) { return h.sent.Load(), h.dropped.Load() }

func (h *HTTP) loop() {
	defer close(h.done)
	t := time.NewTicker(h.cfg.Interval)
	defer t.Stop()
	batch := make([]event.Event, 0, h.cfg.BatchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := h.post(batch); err != nil {
			h.dropped.Add(uint64(len(batch)))
			log.Printf("http sink: dropped %d events: %v", len(batch), err)
		} else {
			h.sent.Add(uint64(len(batch)))
		}
		batch = batch[:0]
	}
	for {
		select {
		case e, ok := <-h.q:
			if !ok {
				flush()
				return
			}
			batch = append(batch, e)
			if len(batch) >= h.cfg.BatchSize {
				flush()
			}
		case <-t.C:
			flush()
		}
	}
}

func (h *HTTP) post(batch []event.Event) error {
	body, err := json.Marshal(map[string]any{"events": batch})
	if err != nil {
		return err
	}
	var last error
	for attempt, wait := 0, 500*time.Millisecond; attempt < 4; attempt, wait = attempt+1, wait*2 {
		if attempt > 0 {
			time.Sleep(wait)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.cfg.URL, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "effigentd")
		if h.cfg.Token != "" {
			req.Header.Set("Authorization", "Bearer "+h.cfg.Token)
		}
		res, err := h.client.Do(req)
		cancel()
		if err != nil {
			last = err
			continue
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode < 300 {
			return nil
		}
		last = fmt.Errorf("backend returned %s", res.Status)
		if res.StatusCode < 500 && res.StatusCode != http.StatusTooManyRequests {
			return last // client errors won't fix themselves
		}
	}
	return last
}

// Close flushes what is queued (best effort, bounded by post's retries).
func (h *HTTP) Close() error {
	close(h.q)
	<-h.done
	return nil
}
