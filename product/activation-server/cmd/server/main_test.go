package main

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"u-claw-activation-server/internal/config"
	"u-claw-activation-server/internal/modelproxy"
	"u-claw-activation-server/internal/observability"
	"u-claw-activation-server/internal/security"
	"u-claw-activation-server/internal/transport"
)

func TestPublicMuxRoutesOnlyModelAPIPrefixToModelProxy(t *testing.T) {
	activationHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Handler", "activation")
	})
	modelHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Handler", "model")
	})
	handler := newPublicMux(activationHandler, modelHandler)

	for _, test := range []struct {
		path string
		want string
	}{
		{path: "/v1/activations", want: "activation"},
		{path: "/model-api/v1/models", want: "model"},
		{path: "/model-api/v1/chat/completions", want: "model"},
		{path: "/model-api", want: "activation"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
		if got := response.Header().Get("X-Handler"); got != test.want {
			t.Errorf("path %s routed to %q, want %q", test.path, got, test.want)
		}
	}
}

func TestModelTokenDigestUsesDeviceTokenHMACContract(t *testing.T) {
	pepper := []byte("01234567890123456789012345678901")
	digest, err := modelTokenDigest(pepper)
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, pepper)
	_, _ = mac.Write([]byte("uclaw_dt_fixture"))
	want := mac.Sum(nil)
	got := digest("uclaw_dt_fixture")
	if !hmac.Equal(got[:], want) {
		t.Fatal("model token digest does not match device-token HMAC contract")
	}
}

func TestRuntimeEnvelopeAdaptersShareOneEnvelopeService(t *testing.T) {
	artifact, secretEncryptor := newRuntimeEnvelopes(nil)
	var _ modelproxy.SecretEnvelope = artifact
	if secretEncryptor.envelope != artifact {
		t.Fatal("runtime envelope adapters do not share the activation envelope service")
	}
}

func TestApplicationExposesMetricsOnlyOnExplicitRoute(t *testing.T) {
	metrics := observability.NewMetrics()
	application := newApplication(http.NotFoundHandler(), http.NotFoundHandler(), metrics)
	response := httptest.NewRecorder()
	application.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "uclaw_activation_requests_total") {
		t.Fatalf("metrics response=%d %s", response.Code, response.Body.String())
	}
}

func TestNewHTTPServerUsesSafeLimitsAndInjectedDatabaseCheck(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	databaseCalled := false
	server := newHTTPServer(config.Config{
		ListenAddress:     "127.0.0.1:0",
		LicenseSigningKey: privateKey,
		StatusSigningKey:  privateKey,
	}, func(context.Context) error {
		databaseCalled = true
		return nil
	}, transport.ReadinessCheck(func(context.Context) error { return nil }))

	if server.ReadHeaderTimeout != readHeaderTimeout || server.ReadTimeout != readTimeout ||
		server.WriteTimeout != writeTimeout || server.IdleTimeout != idleTimeout {
		t.Fatal("HTTP server timeouts do not match bounded defaults")
	}
	if server.MaxHeaderBytes != maximumHeaderSize || server.MaxHeaderBytes > 1<<20 {
		t.Fatalf("MaxHeaderBytes = %d, want bounded default", server.MaxHeaderBytes)
	}
	if server.WriteTimeout <= 60*time.Second {
		t.Fatalf("WriteTimeout = %s, must exceed model proxy 60s timeout", server.WriteTimeout)
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

func TestProductionKMSUsesConfiguredKEKAndRejectsUnsafeProviders(t *testing.T) {
	for _, cfg := range []config.Config{
		{},
		{KMSProvider: "test", KMSKeyVersion: "kms-v1", NewAPIKMSKeyVersion: "new-api-v1", KMSKEK: make([]byte, 32)},
		{KMSProvider: "local-kek-v1", KMSKeyVersion: "kms-v1", NewAPIKMSKeyVersion: "new-api-v1", KMSKEK: make([]byte, 31)},
		{KMSProvider: "local-kek-v1", KMSKeyVersion: "kms-v1", KMSKEK: make([]byte, 32)},
	} {
		if _, err := productionKMS(cfg); err == nil {
			t.Fatalf("unsafe config accepted: %#v", cfg)
		}
	}
	kms, err := productionKMS(config.Config{KMSProvider: "local-kek-v1", KMSKeyVersion: "kms-v1", NewAPIKMSKeyVersion: "new-api-v1", KMSKEK: []byte("01234567890123456789012345678901")})
	if err != nil {
		t.Fatal(err)
	}
	probe, ok := kms.(interface {
		Probe(context.Context, string) error
	})
	if !ok || probe.Probe(context.Background(), "kms-v1") != nil {
		t.Fatal("production KMS probe failed")
	}
	var _ security.KMS = kms
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

func TestRunHealthcheckRequiresReadyResponse(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		wantOK bool
	}{
		{name: "ready", status: http.StatusOK, wantOK: true},
		{name: "not ready", status: http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/health/ready" {
					t.Errorf("path = %s", r.URL.Path)
				}
				w.WriteHeader(test.status)
			}))
			defer server.Close()
			err := runHealthcheck(server.URL+"/health/ready", server.Client())
			if (err == nil) != test.wantOK {
				t.Fatalf("runHealthcheck error = %v, wantOK = %t", err, test.wantOK)
			}
		})
	}
}
