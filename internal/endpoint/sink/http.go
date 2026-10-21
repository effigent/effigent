package sink

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// ---- HTTP backend ----

type HTTPConfig struct {
	URL         string
	Token       string        // sent as "Authorization: Bearer <token>"
	BatchSize   int           // flush when this many events are buffered
	Interval    time.Duration // ...or this often
	QueueSize   int           // events buffered in memory before dropping
	MinSeverity string        // drop events below this severity ("" = send all)
	// SpoolDir keeps batches the backend couldn't take (down, 5xx, 429) on
	// disk and sends them when it is back; "" = drop them.
	SpoolDir      string
	SpoolMaxBytes int64         // default 256 MB; beyond it the oldest batches are dropped
	RetryWait     time.Duration // before the first retry (default 500ms; then 1s, 2s)
	// CloseTimeout bounds the last send on Close (default 10s); what doesn't
	// make it in time goes to the spool. A stopping daemon has seconds.
	CloseTimeout time.Duration
}

// HTTP POSTs {"batch_id": …, "events": [...]} batches. It never blocks the
// engine. While the backend is unreachable, batches go to the disk spool
// (when set) and are replayed oldest first once it answers again; the batch
// id lets the backend store a replayed batch only once. Events are dropped
// (and counted) only when the memory queue is full, the spool is over its
// size, or the backend refuses a batch outright (4xx other than 429).
type HTTP struct {
	cfg     HTTPConfig
	q       chan event.Event
	done    chan struct{}
	client  *http.Client
	dropped atomic.Uint64
	sent    atomic.Uint64
	spooled atomic.Uint64

	down      bool // the last attempt failed; spool without trying until nextProbe
	nextProbe time.Time
	backoff   time.Duration
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
	if cfg.RetryWait <= 0 {
		cfg.RetryWait = 500 * time.Millisecond
	}
	if cfg.CloseTimeout <= 0 {
		cfg.CloseTimeout = 10 * time.Second
	}
	if cfg.SpoolMaxBytes <= 0 {
		cfg.SpoolMaxBytes = 256 << 20
	}
	if cfg.SpoolDir != "" {
		// spooled events carry command lines and paths: the daemon's eyes only
		if err := errors.Join(os.MkdirAll(cfg.SpoolDir, 0o700), os.Chmod(cfg.SpoolDir, 0o700)); err != nil {
			log.Printf("http sink: spool disabled: %v", err)
			cfg.SpoolDir = ""
		}
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

// Stats: events the backend accepted, dropped, and written to the spool.
func (h *HTTP) Stats() (sent, dropped uint64) { return h.sent.Load(), h.dropped.Load() }

func (h *HTTP) Spooled() uint64 { return h.spooled.Load() }

func newBatchID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *HTTP) loop() {
	defer close(h.done)
	t := time.NewTicker(h.cfg.Interval)
	defer t.Stop()
	batch := make([]event.Event, 0, h.cfg.BatchSize)
	flush := func(final bool) {
		if len(batch) > 0 {
			body, err := json.Marshal(map[string]any{"batch_id": newBatchID(), "events": batch})
			if err != nil {
				h.dropped.Add(uint64(len(batch)))
			} else {
				h.deliver(body, len(batch), final)
			}
			batch = batch[:0]
		}
		if !final {
			h.replay()
		}
	}
	for {
		select {
		case e, ok := <-h.q:
			if !ok {
				flush(true)
				return
			}
			batch = append(batch, e)
			if len(batch) >= h.cfg.BatchSize {
				flush(false)
			}
		case <-t.C:
			flush(false)
		}
	}
}

// deliver sends one batch, or spools it while the backend is down.
func (h *HTTP) deliver(body []byte, n int, final bool) {
	if h.down && time.Now().Before(h.nextProbe) && h.cfg.SpoolDir != "" {
		h.spool(body, n)
		return
	}
	attempts, timeout := 4, 10*time.Second
	if final || h.down {
		attempts = 1 // shutting down, or probing a backend that was down
	}
	if final {
		timeout = h.cfg.CloseTimeout
	}
	retry, err := h.post(body, attempts, timeout)
	switch {
	case err == nil:
		h.sent.Add(uint64(n))
		h.down, h.backoff = false, 0
	case retry && h.cfg.SpoolDir != "":
		h.markDown()
		h.spool(body, n)
	default:
		if retry {
			h.markDown()
		}
		h.dropped.Add(uint64(n))
		log.Printf("http sink: dropped %d events: %v", n, err)
	}
}

func (h *HTTP) markDown() {
	h.backoff = min(max(2*h.backoff, 2*time.Second), time.Minute)
	h.down, h.nextProbe = true, time.Now().Add(h.backoff)
}

// post sends a body; retry says whether the failure may pass (network, 5xx, 429).
func (h *HTTP) post(body []byte, attempts int, timeout time.Duration) (retry bool, err error) {
	wait := h.cfg.RetryWait
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			time.Sleep(wait)
			wait *= 2
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.cfg.URL, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "effigentd")
		if h.cfg.Token != "" {
			req.Header.Set("Authorization", "Bearer "+h.cfg.Token)
		}
		res, e := h.client.Do(req)
		cancel()
		if e != nil {
			retry, err = true, e
			continue
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode < 300 {
			return false, nil
		}
		err = fmt.Errorf("backend returned %s", res.Status)
		if res.StatusCode < 500 && res.StatusCode != http.StatusTooManyRequests {
			return false, err // client errors (a revoked endpoint) won't fix themselves
		}
		retry = true
	}
	return retry, err
}

// ---- spool ----

// Spool files are named <unix nanos>-<events>.json and hold one POST body.

type spoolFile struct {
	name   string
	events int
	size   int64
}

func (h *HTTP) spoolFiles() []spoolFile {
	ents, err := os.ReadDir(h.cfg.SpoolDir)
	if err != nil {
		return nil
	}
	var out []spoolFile
	for _, e := range ents {
		base, ok := strings.CutSuffix(e.Name(), ".json")
		_, cnt, ok2 := strings.Cut(base, "-")
		if !ok || !ok2 || e.IsDir() {
			continue
		}
		n, _ := strconv.Atoi(cnt)
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, spoolFile{e.Name(), n, info.Size()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name }) // oldest first
	return out
}

func (h *HTTP) spool(body []byte, n int) {
	files := h.spoolFiles()
	var total int64
	for _, f := range files {
		total += f.size
	}
	for len(files) > 0 && total+int64(len(body)) > h.cfg.SpoolMaxBytes {
		if os.Remove(filepath.Join(h.cfg.SpoolDir, files[0].name)) == nil {
			h.dropped.Add(uint64(files[0].events))
			log.Printf("http sink: spool full, dropped %d oldest events", files[0].events)
		}
		total -= files[0].size
		files = files[1:]
	}
	name := fmt.Sprintf("%020d-%d.json", time.Now().UnixNano(), n)
	tmp := filepath.Join(h.cfg.SpoolDir, "."+name)
	if err := os.WriteFile(tmp, body, 0o600); err != nil || os.Rename(tmp, filepath.Join(h.cfg.SpoolDir, name)) != nil {
		_ = os.Remove(tmp)
		h.dropped.Add(uint64(n))
		log.Printf("http sink: dropped %d events: spool: %v", n, err)
		return
	}
	h.spooled.Add(uint64(n))
}

// replay sends spooled batches, oldest first, while the backend takes them
// (at most 20 per tick, so a long outage drains over a few minutes).
func (h *HTTP) replay() {
	if h.cfg.SpoolDir == "" || (h.down && time.Now().Before(h.nextProbe)) {
		return
	}
	for i, f := range h.spoolFiles() {
		if i >= 20 {
			return
		}
		path := filepath.Join(h.cfg.SpoolDir, f.name)
		body, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		retry, err := h.post(body, 1, 10*time.Second)
		if err != nil && retry {
			h.markDown()
			return
		}
		if err != nil {
			h.dropped.Add(uint64(f.events))
			log.Printf("http sink: dropped %d spooled events: %v", f.events, err)
		} else {
			h.sent.Add(uint64(f.events))
			h.down, h.backoff = false, 0
		}
		_ = os.Remove(path)
	}
}

// Close sends what is queued once; when the backend is down it goes to the
// spool and is sent after the next start.
func (h *HTTP) Close() error {
	close(h.q)
	<-h.done
	return nil
}
