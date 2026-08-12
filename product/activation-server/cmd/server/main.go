package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"u-claw-activation-server/internal/config"
	"u-claw-activation-server/internal/transport"
)

const shutdownTimeout = 10 * time.Second

const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 10 * time.Second
	writeTimeout      = 10 * time.Second
	idleTimeout       = 60 * time.Second
	maximumHeaderSize = 1 << 20
)

func main() {
	if err := run(); err != nil {
		slog.Error("activation server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	server := newHTTPServer(cfg, unavailableDatabaseReadiness)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveError := make(chan error, 1)
	go func() {
		serveError <- server.ListenAndServe()
	}()

	select {
	case err := <-serveError:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("HTTP server failed")
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			return errors.New("HTTP server shutdown failed")
		}
		return nil
	}
}

func newHTTPServer(cfg config.Config, databaseCheck transport.ReadinessCheck) *http.Server {
	return &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           transport.NewHealthHandler(databaseCheck, signerReadiness(cfg.LicenseSigningKey)),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maximumHeaderSize,
	}
}

func unavailableDatabaseReadiness(context.Context) error {
	return errors.New("database adapter is not initialized")
}

func signerReadiness(privateKey ed25519.PrivateKey) transport.ReadinessCheck {
	return func(context.Context) error {
		if len(privateKey) != ed25519.PrivateKeySize {
			return errors.New("license signer is unavailable")
		}
		message := make([]byte, 32)
		if _, err := rand.Read(message); err != nil {
			return errors.New("license signer is unavailable")
		}
		signature := ed25519.Sign(privateKey, message)
		if !ed25519.Verify(privateKey.Public().(ed25519.PublicKey), message, signature) {
			return errors.New("license signer is unavailable")
		}
		return nil
	}
}
