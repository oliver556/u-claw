package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"uclaw-cloud-api/internal/config"
	"uclaw-cloud-api/internal/httpapi"
)

var (
	version = "dev"
	commit  = "none"
	builtAt = "unknown"
)

// main dispatches the production binary mode used by systemd.
func main() {
	mode := "serve"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}

	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	switch mode {
	case "serve":
		if err := runServe(cfg); err != nil {
			log.Fatalf("serve: %v", err)
		}
	case "worker":
		if err := runWorker(cfg); err != nil {
			log.Fatalf("worker: %v", err)
		}
	default:
		log.Fatalf("unknown mode %q; use serve or worker", mode)
	}
}

// runServe starts the public HTTP process and shuts it down on SIGTERM.
func runServe(cfg config.Config) error {
	if cfg.IsProduction() {
		if err := cfg.ValidateForServe(); err != nil {
			return err
		}
	}

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpapi.NewServer(cfg, httpapi.BuildInfo{Version: version, Commit: commit, BuiltAt: builtAt}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("uclaw-cloud-api listening on %s", cfg.HTTPAddr)
		errCh <- server.ListenAndServe()
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// runWorker starts the Phase 0 worker placeholder with production config validation.
func runWorker(cfg config.Config) error {
	if cfg.IsProduction() {
		if err := cfg.ValidateForServe(); err != nil {
			return err
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("uclaw-cloud-worker started with concurrency=1 database_configured=%t", cfg.DatabaseURL != "")
	<-ctx.Done()
	return nil
}
