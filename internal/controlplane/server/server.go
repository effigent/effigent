// Package server is the control plane's HTTP API: the endpoint protocol
// (/ep/v1) and the console API (/api/v1).
package server

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/store"
)

type Server struct {
	Store         *store.Store
	Key           ed25519.PrivateKey
	Auth          *Authenticator
	PublicBaseURL string         // used in install commands, e.g. https://api.effigent.ai
	ConsoleOrigin string         // CORS origin allowed for the console, e.g. https://app.effigent.ai
	Notify        *notify.Sender // announces approval requests (Slack always; email when SMTP is set)
	Logf          func(string, ...any)
	// AllowInsecureWebhooks lets webhooks use http:// and private addresses (tests, local dev).
	AllowInsecureWebhooks bool
	WebhookPoll           time.Duration // how often the delivery worker looks for due events (default 2s)
	// AIKey / AIModel: the Anthropic API key and model for the policy assistant (empty key = off).
	AIKey, AIModel string
	AIBaseURL      string // default https://api.anthropic.com (tests point it elsewhere)
	// Archive stores agent events past their retention (S3); nil = events are
	// never deleted. RetentionDays: how long events stay in the database (min 90).
	Archive       Archiver
	RetentionDays int
	// SlackEnabled turns Slack approval messages on (EFFIGENT_SLACK=1). Off:
	// approvals go out by email only, and Slack can't be connected.
	SlackEnabled bool
	// SecretsKey seals tenant secrets at rest (Slack app credentials); see SecretsKeyFrom.
	SecretsKey []byte
	// Directory maps a Slack approver's email to their console role (Clerk);
	// nil = Slack clicks are refused unless the workspace allows any Slack member.
	Directory Directory
	// SpendBaseURLs points Pricing Leaks vendor clients elsewhere (tests);
	// SpendSyncEvery is how often connectors sync on their own (default 24h).
	SpendBaseURLs  map[string]string
	SpendSyncEvery time.Duration

	limits         *limits
	whOnce         sync.Once
	whCap          *capLimiter
	whClientOnce   sync.Once
	whClient       *http.Client
	workerOnce     sync.Once
	archiveMu      sync.Mutex
	archiveErr     string
	archiveChecked bool
	slackMu        sync.Mutex
	slackUsers     map[string]slackUserEntry
}

func (s *Server) publicKey() ed25519.PublicKey { return s.Key.Public().(ed25519.PublicKey) }

func (s *Server) Handler() http.Handler {
	if s.limits == nil {
		s.limits = newLimits()
	}
	if s.Store != nil {
		s.workerOnce.Do(func() {
			go s.runWebhooks(context.Background())
			go func() { // exceptions whose time is up are republished away
				for range time.Tick(time.Minute) {
					s.expireExceptions(context.Background())
				}
			}()
			go func() { // events past retention move to the archive
				s.checkArchive(context.Background())
				s.runRetention(context.Background())
				for range time.Tick(time.Hour) {
					s.runRetention(context.Background())
				}
			}()
			go s.runSpendSyncs(context.Background()) // Pricing Leaks: nightly vendor syncs
		})
		if s.Auth != nil && s.Auth.APIKeys == nil {
			s.Auth.APIKeys = func(ctx context.Context, secret string) (string, string, []string, error) {
				k, err := s.Store.AuthAPIKey(ctx, secret)
				return k.Tenant, k.ID, k.Scopes, err
			}
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	// endpoint protocol
	mux.HandleFunc("POST /ep/v1/enroll", s.enroll)
	mux.HandleFunc("GET /ep/v1/policy", s.endpointAuth(s.endpointPolicy))
	mux.HandleFunc("POST /ep/v1/heartbeat", s.endpointAuth(s.heartbeat))
	mux.HandleFunc("POST /ep/v1/events", s.endpointAuth(s.ingest))
	mux.HandleFunc("POST /ep/v1/approvals", s.endpointAuth(s.requestApproval))
	// Approve / Deny buttons from emails and Slack (signed one-request links)
	mux.HandleFunc("GET /a/{token}", s.approvalLink)
	mux.HandleFunc("POST /a/{token}", s.approvalLink)
	// clicks on Approve / Deny in messages from a workspace's own Slack app (signed by Slack)
	mux.HandleFunc("POST /slack/interactions", s.slackInteractions)

	// console API
	mux.HandleFunc("GET /api/v1/me", s.console(read, s.me))
	mux.HandleFunc("POST /api/v1/enrollment-tokens", s.scoped("endpoints", write, s.createEnrollmentToken))
	mux.HandleFunc("GET /api/v1/endpoints", s.console(read, s.listEndpoints))
	mux.HandleFunc("DELETE /api/v1/endpoints/{id}", s.scoped("endpoints", write, s.revokeEndpoint))
	mux.HandleFunc("PATCH /api/v1/endpoints/{id}", s.scoped("endpoints", write, s.setEndpointOwner))
	mux.HandleFunc("GET /api/v1/endpoints/{id}/policy", s.console(read, s.endpointCompiledPolicy))
	mux.HandleFunc("GET /api/v1/policy", s.console(read, s.getPolicy))
	mux.HandleFunc("PUT /api/v1/policy", s.scoped("policy", write, s.putPolicy))
	mux.HandleFunc("GET /api/v1/policy/history", s.console(read, s.policyHistory))
	mux.HandleFunc("GET /api/v1/policy/versions/{version}", s.console(read, s.getPolicyVersion))
	mux.HandleFunc("POST /api/v1/policy/assist", s.scoped("policy", write, s.assistPolicy))
	mux.HandleFunc("GET /api/v1/events", s.console(read, s.listEvents))
	mux.HandleFunc("GET /api/v1/events/verify", s.console(read, s.verifyEvents))
	mux.HandleFunc("GET /api/v1/events/archives", s.console(read, s.listEventArchives))
	mux.HandleFunc("POST /api/v1/events/archives/{day}/link", s.console(read, s.eventArchiveLink))
	mux.HandleFunc("GET /api/v1/audit", s.console(read, s.listAudit))
	mux.HandleFunc("GET /api/v1/audit/verify", s.console(read, s.verifyAudit))
	mux.HandleFunc("GET /api/v1/approvals", s.console(read, s.listApprovals))
	mux.HandleFunc("GET /api/v1/approvals/{id}", s.console(read, s.getApproval))
	// read, not write: approver-group members may be plain members; decideApproval checks who may decide
	mux.HandleFunc("POST /api/v1/approvals/{id}/decision", s.scoped("approvals", read, s.decideApproval))
	mux.HandleFunc("GET /api/v1/approval-routing", s.console(read, s.getRouting))
	mux.HandleFunc("PUT /api/v1/approval-routing", s.console(write, s.putRouting))
	mux.HandleFunc("POST /api/v1/approval-routing/test", s.console(read, s.testRouting))
	mux.HandleFunc("GET /api/v1/notifications", s.console(read, s.getNotifications))
	mux.HandleFunc("PUT /api/v1/notifications", s.console(write, s.putNotifications))
	mux.HandleFunc("POST /api/v1/notifications/test", s.console(write, s.testNotifications))
	mux.HandleFunc("PUT /api/v1/notifications/slack-app", s.console(write, s.putSlackApp))
	mux.HandleFunc("DELETE /api/v1/notifications/slack-app", s.console(write, s.deleteSlackApp))
	// per-machine exceptions to the company policy (each change publishes a version)
	mux.HandleFunc("GET /api/v1/exceptions", s.console(read, s.listExceptions))
	mux.HandleFunc("GET /api/v1/exceptions/options", s.console(read, s.exceptionOptions))
	mux.HandleFunc("POST /api/v1/exceptions", s.scoped("policy", write, s.createException))
	mux.HandleFunc("DELETE /api/v1/exceptions/{id}", s.scoped("policy", write, s.deleteException))
	// Pricing Leaks: AI tool spend joined with what effigentd sees. Vendor keys
	// and CSV imports are managed by people only.
	mux.HandleFunc("GET /api/v1/pricing-leaks", s.console(read, s.pricingLeaks))
	mux.HandleFunc("GET /api/v1/pricing-leaks/connectors", s.console(read, s.spendConnectors))
	mux.HandleFunc("PUT /api/v1/pricing-leaks/connectors/{vendor}", s.console(write, s.putSpendConnector))
	mux.HandleFunc("DELETE /api/v1/pricing-leaks/connectors/{vendor}", s.console(write, s.deleteSpendConnector))
	mux.HandleFunc("POST /api/v1/pricing-leaks/sync", s.console(write, s.syncSpendNow))
	mux.HandleFunc("POST /api/v1/pricing-leaks/import", s.console(write, s.importSpendCSV))
	mux.HandleFunc("DELETE /api/v1/pricing-leaks/import/{vendor}", s.console(write, s.clearSpendCSV))
	mux.HandleFunc("PUT /api/v1/pricing-leaks/settings", s.console(write, s.putSpendSettings))
	mux.HandleFunc("GET /api/v1/people", s.console(read, s.listPeople))
	mux.HandleFunc("PUT /api/v1/people/{email}", s.console(write, s.putPerson))
	mux.HandleFunc("DELETE /api/v1/people/{email}", s.console(write, s.deletePerson))
	mux.HandleFunc("POST /api/v1/people/identities", s.console(write, s.addPersonIdentity))
	mux.HandleFunc("DELETE /api/v1/people/identities", s.console(write, s.deletePersonIdentity))
	// integrations: API keys and webhooks are managed by people only
	mux.HandleFunc("GET /api/v1/api-keys", s.console(read, s.listAPIKeys))
	mux.HandleFunc("POST /api/v1/api-keys", s.console(write, s.createAPIKey))
	mux.HandleFunc("DELETE /api/v1/api-keys/{id}", s.console(write, s.revokeAPIKey))
	mux.HandleFunc("GET /api/v1/webhooks", s.console(read, s.listWebhooks))
	mux.HandleFunc("POST /api/v1/webhooks", s.console(write, s.createWebhook))
	mux.HandleFunc("DELETE /api/v1/webhooks/{id}", s.console(write, s.deleteWebhook))
	mux.HandleFunc("POST /api/v1/webhooks/{id}/test", s.console(write, s.testWebhook))
	mux.HandleFunc("GET /api/v1/webhooks/{id}/deliveries", s.console(read, s.listDeliveries))
	return s.rateLimitIP(s.cors(mux))
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.ConsoleOrigin != "" && r.Header.Get("Origin") == s.ConsoleOrigin && strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", s.ConsoleOrigin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Effigent-Tenant")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	s.Logf("internal error: %v", err)
	writeErr(w, http.StatusInternalServerError, "internal error")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
