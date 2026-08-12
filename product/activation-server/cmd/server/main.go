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

	"github.com/jackc/pgx/v5/pgxpool"

	"u-claw-activation-server/internal/activation"
	"u-claw-activation-server/internal/config"
	"u-claw-activation-server/internal/license"
	"u-claw-activation-server/internal/lifecycle"
	"u-claw-activation-server/internal/persistence"
	"u-claw-activation-server/internal/security"
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

	ctx := context.Background()
	pool, err := persistence.OpenPostgres(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := persistence.Migrate(ctx, pool); err != nil {
		return err
	}
	kms, err := productionKMS(cfg)
	if err != nil {
		return err
	}
	public, err := buildPublicHandler(cfg, pool, kms)
	if err != nil {
		return err
	}
	server := newHTTPServer(cfg, func(ctx context.Context) error { return pool.Ping(ctx) }, public, kmsReadiness(kms, cfg.KMSKeyVersion))

	signalContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
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
	case <-signalContext.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			return errors.New("HTTP server shutdown failed")
		}
		return nil
	}
}

func buildPublicHandler(cfg config.Config, pool *pgxpool.Pool, kms security.KMS) (http.Handler, error) {
	repository, err := persistence.NewActivationRepository(pool)
	if err != nil {
		return nil, err
	}
	licenseSigner, err := license.NewSigner(cfg.LicenseKeyID, cfg.LicenseSigningKey)
	if err != nil {
		return nil, err
	}
	envelope := security.NewEnvelopeService(kms, nil)
	activationService, err := activation.NewService(activation.ServiceOptions{
		Repository: repository, Signer: licenseSigner, Envelope: envelope, Pepper: cfg.ActivationPepper,
		KeyID: cfg.LicenseKeyID, KeyVersion: cfg.KMSKeyVersion, LeaseTTL: time.Minute, LicenseTTL: 365 * 24 * time.Hour,
	})
	if err != nil {
		return nil, err
	}
	lifecycleService, err := lifecycle.NewService(lifecycle.ServiceOptions{
		Repository: repository, KeyID: cfg.StatusKeyID, PrivateKey: cfg.StatusSigningKey, TokenSigningKey: cfg.TokenSigningKey, MaximumGrace: 24 * time.Hour, Envelope: envelope,
	})
	if err != nil {
		return nil, err
	}
	return transport.NewPublicHandler(transport.PublicHandlerOptions{Activation: activationService, Lifecycle: lifecycleService}), nil
}

func productionKMS(cfg config.Config) (security.KMS, error) {
	if cfg.KMSProvider != "local-kek-v1" || cfg.KMSKeyVersion == "" {
		return nil, errors.New("production KMS configuration is required")
	}
	kms, err := security.NewKEK(cfg.KMSKEK, nil)
	if err != nil {
		return nil, errors.New("production KMS configuration is invalid")
	}
	return kms, nil
}

func newHTTPServer(cfg config.Config, databaseCheck transport.ReadinessCheck, dependencies ...any) *http.Server {
	var publicHandler http.Handler
	var kmsCheck transport.ReadinessCheck
	for _, dependency := range dependencies {
		switch value := dependency.(type) {
		case http.Handler:
			publicHandler = value
		case transport.ReadinessCheck:
			kmsCheck = value
		}
	}
	checks := []transport.ReadinessCheck{databaseCheck, signerReadiness(cfg.LicenseSigningKey), signerReadiness(cfg.StatusSigningKey)}
	if kmsCheck != nil {
		checks = append(checks, kmsCheck)
	} else {
		checks = append(checks, func(context.Context) error { return errors.New("KMS unavailable") })
	}
	return &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           transport.NewHandler(checks, publicHandler),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maximumHeaderSize,
	}
}

func kmsReadiness(kms security.KMS, keyVersion string) transport.ReadinessCheck {
	return func(ctx context.Context) error {
		probe, ok := kms.(interface {
			Probe(context.Context, string) error
		})
		if !ok || keyVersion == "" {
			return errors.New("KMS unavailable")
		}
		return probe.Probe(ctx, keyVersion)
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
