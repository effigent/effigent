// effigent-cp is the Effigent control plane: endpoint enrollment, signed
// policy distribution, event ingestion and the console API.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/effigent/effigent/internal/controlplane/notify"
	"github.com/effigent/effigent/internal/controlplane/server"
	"github.com/effigent/effigent/internal/controlplane/store"
	"github.com/effigent/effigent/internal/shared/sign"
)

func main() {
	listen := flag.String("listen", envOr("EFFIGENT_LISTEN", "127.0.0.1:8080"), "listen address")
	keyFile := flag.String("key-file", envOr("EFFIGENT_SIGNING_KEY_FILE", "effigent-signing.key"), "policy signing key file (created if missing; ignored when EFFIGENT_SIGNING_KEY is set)")
	flag.Parse()
	logger := log.New(os.Stderr, "effigent-cp: ", log.LstdFlags)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		logger.Fatal("DATABASE_URL is required")
	}
	st, err := store.Open(ctx, dbURL)
	if err != nil {
		logger.Fatalf("database: %v", err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		logger.Fatalf("migrate: %v", err)
	}

	key, err := sign.LoadOrCreateKey(os.Getenv("EFFIGENT_SIGNING_KEY"), *keyFile)
	if err != nil {
		logger.Fatalf("signing key: %v", err)
	}
	auth, err := server.NewAuthenticator(ctx, server.Options{
		ClerkIssuer:       os.Getenv("CLERK_ISSUER"),
		AdminToken:        os.Getenv("EFFIGENT_ADMIN_TOKEN"),
		AdminTenants:      strings.Split(os.Getenv("EFFIGENT_ADMIN_TENANTS"), ","), // "" = admin token disabled
		AuthorizedParties: strings.Split(os.Getenv("CLERK_AUTHORIZED_PARTIES"), ","),
	})
	if err != nil {
		logger.Fatalf("auth: %v", err)
	}

	srv := &server.Server{
		Store: st, Key: key, Auth: auth, Logf: logger.Printf,
		PublicBaseURL: envOr("EFFIGENT_PUBLIC_URL", "http://"+*listen),
		ConsoleOrigin: os.Getenv("EFFIGENT_CONSOLE_ORIGIN"),
		// Email for approval requests; Slack webhooks are set per tenant in the console.
		Notify: &notify.Sender{SMTPURL: os.Getenv("EFFIGENT_SMTP_URL"), SESRegion: os.Getenv("EFFIGENT_SES_REGION"),
			From: os.Getenv("EFFIGENT_EMAIL_FROM")},
		// Local development only (e.g. a Windmill on localhost): http:// and private
		// webhook targets. Never set in production — it reopens SSRF.
		AllowInsecureWebhooks: os.Getenv("EFFIGENT_DEV_INSECURE_WEBHOOKS") == "1",
		// policy assistant (Anthropic); model default claude-haiku-5-5
		AIKey: os.Getenv("EFFIGENT_ANTHROPIC_API_KEY"), AIModel: os.Getenv("EFFIGENT_AI_MODEL"),
	}
	// Slack app credentials are sealed with this key; without it Slack apps can't be connected.
	if srv.SecretsKey, err = server.SecretsKeyFrom(os.Getenv("EFFIGENT_SECRETS_KEY")); err != nil {
		logger.Fatalf("%v", err)
	}
	// Approvals decided in Slack must come from a console admin / security_admin
	// (matched by email through Clerk's Backend API).
	if k := os.Getenv("CLERK_SECRET_KEY"); k != "" {
		srv.Directory = &server.ClerkDirectory{SecretKey: k}
	}
	if srv.AllowInsecureWebhooks {
		logger.Printf("WARNING: EFFIGENT_DEV_INSECURE_WEBHOOKS=1: webhooks may target http:// and private addresses")
	}
	hs := &http.Server{Addr: *listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	logger.Printf("listening on %s", *listen)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatal(err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
