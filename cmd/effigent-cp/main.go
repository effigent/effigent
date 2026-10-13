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
	"syscall"
	"time"

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
	auth, err := server.NewAuthenticator(ctx, os.Getenv("CLERK_ISSUER"), os.Getenv("EFFIGENT_ADMIN_TOKEN"))
	if err != nil {
		logger.Fatalf("auth: %v", err)
	}

	srv := &server.Server{
		Store: st, Key: key, Auth: auth, Logf: logger.Printf,
		PublicBaseURL: envOr("EFFIGENT_PUBLIC_URL", "http://"+*listen),
		ConsoleOrigin: os.Getenv("EFFIGENT_CONSOLE_ORIGIN"),
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
