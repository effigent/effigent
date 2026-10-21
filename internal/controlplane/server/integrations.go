package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/effigent/effigent/internal/controlplane/store"
)

// Webhook event types. A new webhook gets the approval events by default;
// the rest are opt-in: approval.voted is each vote of a two-person
// request before the last, action.blocked can be busy (a kernel block per
// attempt), pricing_leaks.runaway_cost is for whoever watches spend,
// endpoint.offline/online fire every time a laptop sleeps, and
// anomaly.first_seen is each first-seen behaviour signal.
var webhookEvents = []string{
	"approval.requested", "approval.decided", "approval.voted", "action.blocked",
	"endpoint.enrolled", "endpoint.revoked", "policy.published", "policy.proposed",
	"pricing_leaks.runaway_cost",
	"endpoint.hooks_missing", "endpoint.offline", "endpoint.online",
	"anomaly.first_seen",
}

// cappedEvents get at most webhookCap deliveries per webhook per minute.
var cappedEvents = map[string]bool{"action.blocked": true, "anomaly.first_seen": true}

var defaultWebhookEvents = []string{"approval.requested", "approval.decided"}

// webhookCap is how many action.blocked (and, separately,
// anomaly.first_seen) events per minute one webhook receives; the rest are
// counted as dropped (shown in the console).
const webhookCap = 60

// ---- API keys (console, people only) ----

func (s *Server) listAPIKeys(w http.ResponseWriter, r *http.Request, p Principal) {
	ks, err := s.Store.ListAPIKeys(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ks)
}

func (s *Server) createAPIKey(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Name    string   `json:"name"`
		Scopes  []string `json:"scopes"`
		TTLDays int      `json:"ttl_days"` // 0 = no expiry
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	req.Name = clip(strings.TrimSpace(req.Name), 80)
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "give the key a name (e.g. windmill)")
		return
	}
	if len(req.Scopes) == 0 {
		writeErr(w, http.StatusBadRequest, "pick at least one scope: "+strings.Join(apiKeyScopes, ", "))
		return
	}
	var scopes []string
	for _, sc := range req.Scopes {
		if !slices.Contains(apiKeyScopes, sc) {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("unknown scope %q (%s)", sc, strings.Join(apiKeyScopes, ", ")))
			return
		}
		if !slices.Contains(scopes, sc) {
			scopes = append(scopes, sc)
		}
	}
	if !slices.Contains(scopes, "read") {
		scopes = append(scopes, "read") // acting on something means reading it first
	}
	var exp *time.Time
	if req.TTLDays > 0 {
		t := time.Now().Add(time.Duration(min(req.TTLDays, 3650)) * 24 * time.Hour)
		exp = &t
	}
	k, err := s.Store.CreateAPIKey(r.Context(), p.Tenant, req.Name, p.UserID, scopes, exp)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "api_key.create", k.ID, map[string]any{"name": k.Name, "scopes": k.Scopes, "prefix": k.Prefix})
	writeJSON(w, http.StatusCreated, k)
}

func (s *Server) revokeAPIKey(w http.ResponseWriter, r *http.Request, p Principal) {
	if err := s.Store.RevokeAPIKey(r.Context(), p.Tenant, r.PathValue("id")); errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such API key")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "api_key.revoke", r.PathValue("id"), nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- webhooks (console, people only) ----

type webhookView struct {
	store.Webhook
	URLHint string `json:"url_hint"`
	Secret  string `json:"secret,omitempty"` // only when just created
}

// urlHint shows where a webhook goes without its path/query (which may hold a token).
func urlHint(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "…"
	}
	return u.Scheme + "://" + u.Host + "/…"
}

func (s *Server) listWebhooks(w http.ResponseWriter, r *http.Request, p Principal) {
	hs, err := s.Store.ListWebhooks(r.Context(), p.Tenant)
	if err != nil {
		s.fail(w, err)
		return
	}
	out := make([]webhookView, 0, len(hs))
	for _, h := range hs {
		out = append(out, webhookView{Webhook: h, URLHint: urlHint(h.URL)})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) checkWebhookURL(raw string) error {
	u, err := url.Parse(raw)
	switch {
	case err != nil || u.Host == "":
		return errors.New("not a URL")
	case u.User != nil:
		return errors.New("put credentials in the query string or path, not user:password@")
	case u.Scheme != "https" && !(s.AllowInsecureWebhooks && u.Scheme == "http"):
		return errors.New("webhooks must use https")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !s.AllowInsecureWebhooks && !publicIP(ip) {
		return errors.New("webhooks can't point at private or internal addresses")
	}
	return nil
}

func (s *Server) createWebhook(w http.ResponseWriter, r *http.Request, p Principal) {
	var req struct {
		Name   string   `json:"name"`
		URL    string   `json:"url"`
		Events []string `json:"events"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if err := s.checkWebhookURL(req.URL); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Events) == 0 {
		req.Events = defaultWebhookEvents
	}
	var events []string
	for _, e := range req.Events {
		if !slices.Contains(webhookEvents, e) {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("unknown event %q (%s)", e, strings.Join(webhookEvents, ", ")))
			return
		}
		if !slices.Contains(events, e) {
			events = append(events, e)
		}
	}
	if hs, err := s.Store.ListWebhooks(r.Context(), p.Tenant); err == nil && len(hs) >= 10 {
		writeErr(w, http.StatusBadRequest, "at most 10 webhooks per workspace")
		return
	}
	h, err := s.Store.CreateWebhook(r.Context(), p.Tenant, clip(strings.TrimSpace(req.Name), 80), req.URL, events, p.UserID)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "webhook.create", h.ID, map[string]any{"name": h.Name, "url": urlHint(h.URL), "events": h.Events})
	writeJSON(w, http.StatusCreated, webhookView{Webhook: h, URLHint: urlHint(h.URL), Secret: h.Secret})
}

func (s *Server) deleteWebhook(w http.ResponseWriter, r *http.Request, p Principal) {
	if err := s.Store.DeleteWebhook(r.Context(), p.Tenant, r.PathValue("id")); errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such webhook")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	s.audit(r, p, "webhook.delete", r.PathValue("id"), nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// testWebhook sends a signed test event right away and reports the answer.
func (s *Server) testWebhook(w http.ResponseWriter, r *http.Request, p Principal) {
	h, err := s.Store.GetWebhook(r.Context(), p.Tenant, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such webhook")
		return
	} else if err != nil {
		s.fail(w, err)
		return
	}
	id, body := s.webhookBody(p.Tenant, "test", map[string]any{"message": "Test event from Effigent", "webhook_id": h.ID})
	status, derr := s.sendWebhook(r.Context(), h.URL, h.Secret, "test", id, body)
	s.audit(r, p, "webhook.test", h.ID, map[string]any{"status": status})
	res := map[string]any{"status": status, "ok": derr == nil}
	if derr != nil {
		res["error"] = derr.Error()
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) listDeliveries(w http.ResponseWriter, r *http.Request, p Principal) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	ds, err := s.Store.ListDeliveries(r.Context(), p.Tenant, r.PathValue("id"), limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ds)
}

// ---- dispatch ----

func (s *Server) webhookBody(tenant, typ string, data any) (id, body string) {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	id = "evt_" + hex.EncodeToString(b)
	raw, _ := json.Marshal(map[string]any{"id": id, "type": typ, "created_at": time.Now().UTC(), "tenant": tenant, "data": data})
	return id, string(raw)
}

// emit queues an event for every webhook of the tenant that wants it. It
// only writes to the database: delivery happens in the worker.
func (s *Server) emit(ctx context.Context, tenant, typ string, data any) {
	hs, err := s.Store.ListWebhooks(ctx, tenant)
	if err != nil {
		s.Logf("webhooks for %s: %v", tenant, err)
		return
	}
	var id, body string
	for _, h := range hs {
		if !h.Enabled || !slices.Contains(h.Events, typ) {
			continue
		}
		// Only the noisy events are capped (each its own budget): approvals
		// and the rest always go out.
		if cappedEvents[typ] && !s.webhookLimiter().allow(h.ID+"|"+typ) {
			_ = s.Store.AddWebhookDropped(ctx, h.ID, 1)
			continue
		}
		if body == "" {
			id, body = s.webhookBody(tenant, typ, data)
		}
		if err := s.Store.EnqueueDelivery(ctx, h.ID, id, typ, body); err != nil {
			s.Logf("webhook %s: enqueue %s: %v", h.ID, typ, err)
		}
	}
}

// capLimiter counts events per webhook per minute.
type capLimiter struct {
	mu   sync.Mutex
	win  time.Time
	seen map[string]int
}

func (c *capLimiter) allow(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if now := time.Now(); now.Sub(c.win) > time.Minute {
		c.win, c.seen = now, map[string]int{}
	}
	c.seen[id]++
	return c.seen[id] <= webhookCap
}

func (s *Server) webhookLimiter() *capLimiter {
	s.whOnce.Do(func() { s.whCap = &capLimiter{seen: map[string]int{}} })
	return s.whCap
}

// retryAfter is the wait before attempt n+1 (n attempts made); nil = give up.
func retryAfter(n int) *time.Time {
	waits := []time.Duration{10 * time.Second, time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour}
	if n > len(waits) {
		return nil
	}
	t := time.Now().Add(waits[n-1])
	return &t
}

// runWebhooks delivers queued events until ctx ends. Rows are claimed with a
// lease, so several control-plane instances (or a crashed one) are fine.
func (s *Server) runWebhooks(ctx context.Context) {
	tick := time.NewTicker(s.webhookPoll())
	defer tick.Stop()
	for {
		ds, err := s.Store.ClaimDeliveries(ctx, 20, time.Minute)
		if err != nil && ctx.Err() == nil {
			s.Logf("webhook queue: %v", err)
		}
		var wg sync.WaitGroup
		for _, d := range ds {
			wg.Add(1)
			go func(d store.Delivery) {
				defer wg.Done()
				status, err := s.sendWebhook(ctx, d.URL, d.Secret, d.EventType, d.EventID, d.Body)
				errText := ""
				if err != nil {
					errText = clip(err.Error(), 300)
				}
				var next *time.Time
				if err != nil && retryable(status) {
					next = retryAfter(d.Attempts + 1)
				}
				if ferr := s.Store.FinishDelivery(ctx, d, status, errText, err == nil, next); ferr != nil && ctx.Err() == nil {
					s.Logf("webhook delivery %d: %v", d.ID, ferr)
				}
			}(d)
		}
		wg.Wait()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (s *Server) webhookPoll() time.Duration {
	if s.WebhookPoll > 0 {
		return s.WebhookPoll
	}
	return 2 * time.Second
}

// retryable: network errors (status 0), timeouts, rate limits, server errors.
func retryable(status int) bool {
	return status == 0 || status == 408 || status == 429 || status >= 500
}

// sendWebhook POSTs one signed event. The signature is Stripe-style:
// X-Effigent-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>.
func (s *Server) sendWebhook(ctx context.Context, rawURL, secret, typ, id, body string) (int, error) {
	if err := s.checkWebhookURL(rawURL); err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "." + body))
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Effigent-Webhooks/1")
	req.Header.Set("X-Effigent-Event", typ)
	req.Header.Set("X-Effigent-Delivery", id)
	req.Header.Set("X-Effigent-Signature", "t="+ts+",v1="+hex.EncodeToString(mac.Sum(nil)))
	res, err := s.webhookClient().Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(res.Body, 300))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return res.StatusCode, fmt.Errorf("answered %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return res.StatusCode, nil
}

// webhookClient never follows redirects and refuses to connect to private,
// loopback, link-local (cloud metadata) or other internal addresses — checked
// on the address actually dialed, so DNS rebinding can't get around it.
func (s *Server) webhookClient() *http.Client {
	s.whClientOnce.Do(s.buildWebhookClient)
	return s.whClient
}

func (s *Server) buildWebhookClient() {
	d := &net.Dialer{Timeout: 5 * time.Second, Control: func(network, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		if ip := net.ParseIP(host); ip == nil || (!s.AllowInsecureWebhooks && !publicIP(ip)) {
			return fmt.Errorf("refusing to deliver to internal address %s", host)
		}
		return nil
	}}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = d.DialContext
	t.Proxy = nil
	s.whClient = &http.Client{Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func publicIP(ip net.IP) bool {
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() || cgnat.Contains(ip))
}
