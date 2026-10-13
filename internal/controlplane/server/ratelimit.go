package server

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// limiter is a per-key token bucket. Keys are e.g. "ip:1.2.3.4", "ep:<id>",
// "user:<id>". Buckets idle for 10 minutes are dropped.
type limiter struct {
	mu      sync.Mutex
	rate    float64 // tokens per second
	burst   float64
	buckets map[string]*bucket
	last    time.Time
}

type bucket struct {
	tokens float64
	at     time.Time
}

func newLimiter(perMinute, burst int) *limiter {
	return &limiter{rate: float64(perMinute) / 60, burst: float64(burst), buckets: map[string]*bucket{}}
}

// allow takes one token for key; when empty it returns the wait until the next token.
func (l *limiter) allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.last) > time.Minute {
		for k, b := range l.buckets {
			if now.Sub(b.at) > 10*time.Minute {
				delete(l.buckets, k)
			}
		}
		l.last = now
	}
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: l.burst, at: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.burst, b.tokens+now.Sub(b.at).Seconds()*l.rate)
	b.at = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
}

// clientIP is the caller's address. Behind App Runner the proxy appends the
// real client to X-Forwarded-For, so the LAST entry is trustworthy; earlier
// entries are whatever the client claimed.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func tooMany(w http.ResponseWriter, wait time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
	writeErr(w, http.StatusTooManyRequests, "rate limit exceeded; retry later")
}

// Limits, chosen so normal use never hits them:
//   - any request: 600/min per IP (burst 120)
//   - enrollment: 10/min per IP (burst 5) — tokens are unguessable, this stops noise
//   - endpoint protocol: 240/min per endpoint (a healthy endpoint uses ~30)
//   - console API: 300/min per user
type limits struct {
	perIP, enroll, endpoint, console *limiter
}

func newLimits() *limits {
	return &limits{
		perIP:    newLimiter(600, 120),
		enroll:   newLimiter(10, 5),
		endpoint: newLimiter(240, 60),
		console:  newLimiter(300, 60),
	}
}

func (s *Server) rateLimitIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		ip := clientIP(r)
		if ok, wait := s.limits.perIP.allow("ip:" + ip); !ok {
			tooMany(w, wait)
			return
		}
		if r.URL.Path == "/ep/v1/enroll" {
			if ok, wait := s.limits.enroll.allow("enroll:" + ip); !ok {
				tooMany(w, wait)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
