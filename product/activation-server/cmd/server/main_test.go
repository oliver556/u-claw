package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"u-claw-activation-server/internal/config"
)

func TestNewHTTPServerUsesSafeLimitsAndInjectedDatabaseCheck(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	databaseCalled := false
	server := newHTTPServer(config.Config{
		ListenAddress:     "127.0.0.1:0",
		LicenseSigningKey: privateKey,
	}, func(context.Context) error {
		databaseCalled = true
		return nil
	})

	if server.ReadHeaderTimeout != readHeaderTimeout || server.ReadTimeout != readTimeout ||
		server.WriteTimeout != writeTimeout || server.IdleTimeout != idleTimeout {
		t.Fatal("HTTP server timeouts do not match bounded defaults")
	}
	if server.MaxHeaderBytes != maximumHeaderSize || server.MaxHeaderBytes > 1<<20 {
		t.Fatalf("MaxHeaderBytes = %d, want bounded default", server.MaxHeaderBytes)
	}
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if !databaseCalled {
		t.Fatal("injected database readiness check was not called")
	}
}

func TestSignerReadinessSignsAndVerifies(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := signerReadiness(privateKey)(context.Background()); err != nil {
		t.Fatal(err)
	}
	corrupted := append(ed25519.PrivateKey(nil), privateKey...)
	corrupted[ed25519.PrivateKeySize-1] ^= 0xff
	if err := signerReadiness(corrupted)(context.Background()); err == nil {
		t.Fatal("corrupted private key passed self-check")
	}
}

func TestUnavailableDatabaseReadinessFailsClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := unavailableDatabaseReadiness(ctx); err == nil {
		t.Fatal("unwired database readiness reported ready")
	}
}
