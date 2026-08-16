package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type lifecycleFixture struct {
	root       string
	anchorRoot string
	now        time.Time
	material   verifiedLicenseMaterial
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	query      func(verifiedLicenseMaterial) (licenseStatusResponse, error)
}

func newLifecycleFixture(t *testing.T) *lifecycleFixture {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 10, 0, 0, 0, 0, time.UTC)
	return &lifecycleFixture{
		root:       t.TempDir(),
		anchorRoot: t.TempDir(),
		now:        now,
		privateKey: privateKey,
		publicKey:  publicKey,
		material: verifiedLicenseMaterial{
			DeviceID:       "dev_fixture_001",
			LicenseID:      "lic_fixture_001",
			StartupSecret:  "fixture-runtime-secret-generated-per-test-001",
			USBFingerprint: strings.Repeat("a", 64),
			ExpiresAt:      now.Add(7 * 24 * time.Hour),
		},
	}
}

func (fixture *lifecycleFixture) response(t *testing.T, status licenseLifecycleStatus, checkedAt time.Time, graceUntil time.Time) licenseStatusResponse {
	t.Helper()
	summary := licenseStatusSummary{
		LicenseID: fixture.material.LicenseID, DeviceID: fixture.material.DeviceID, Status: status, Revision: 1,
		NotBefore: fixture.now.Add(-time.Hour).Format(time.RFC3339Nano), ExpiresAt: fixture.material.ExpiresAt.Format(time.RFC3339Nano),
		UpdatedAt: fixture.now.Add(-time.Minute).Format(time.RFC3339Nano),
	}
	if status == licenseStatusReissued {
		summary.ReplacementLicenseID = "lic_replacement_001"
	}
	payload := []any{
		"uclaw-license-status-v1", 1, summary.LicenseID, summary.DeviceID, summary.Status, summary.Revision,
		summary.NotBefore, summary.ExpiresAt, nullableString(summary.ReplacementLicenseID), summary.UpdatedAt,
		checkedAt.Format(time.RFC3339Nano), graceUntil.Format(time.RFC3339Nano), "test-status-key",
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return licenseStatusResponse{
		Status: summary,
		Receipt: licenseStatusReceipt{Value: base64.RawURLEncoding.EncodeToString(encoded) + "." +
			base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, encoded))},
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func TestActivationServerProductionStatusResponseIsLauncherCompatible(t *testing.T) {
	var golden struct {
		PublicKey, CheckedAt string
		Response             licenseStatusResponse
	}
	contents, err := os.ReadFile(filepath.Join("..", "tests", "fixtures", "activation-status-response-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(contents, &golden); err != nil {
		t.Fatal(err)
	}
	publicKey, err := base64.RawStdEncoding.DecodeString(golden.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339Nano, golden.CheckedAt)
	if err != nil {
		t.Fatal(err)
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, golden.Response.Status.ExpiresAt)
	if err != nil {
		t.Fatal(err)
	}
	material := verifiedLicenseMaterial{DeviceID: golden.Response.Status.DeviceID, LicenseID: golden.Response.Status.LicenseID, ExpiresAt: expiresAt}
	receipt, err := verifyLicenseStatusResponse(golden.Response, material, now, map[string]ed25519.PublicKey{"status-key-001": publicKey})
	if err != nil {
		t.Fatal(err)
	}
	if !sameLicenseStatus(golden.Response.Status, receipt.Status) || receipt.Raw != golden.Response.Receipt.Value {
		t.Fatal("activation server response drifted from launcher contract")
	}
}

func (fixture *lifecycleFixture) verify() error {
	return VerifyLicenseLifecycle(licenseLifecycleVerificationOptions{
		PackageRoot: fixture.root,
		AnchorRoot:  fixture.anchorRoot,
		Material:    fixture.material,
		Now:         func() time.Time { return fixture.now },
		QueryStatus: func(material verifiedLicenseMaterial) (licenseStatusResponse, error) {
			if fixture.query == nil {
				return licenseStatusResponse{}, ErrLicenseStatusUnavailable
			}
			return fixture.query(material)
		},
		TrustedPublicKeys: map[string]ed25519.PublicKey{"test-status-key": fixture.publicKey},
		Random:            rand.Reader,
	})
}

func TestVerifyLicenseLifecycleAcceptsOnlineActiveAndWritesOpaqueCache(t *testing.T) {
	fixture := newLifecycleFixture(t)
	receipt := fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour))
	fixture.query = func(material verifiedLicenseMaterial) (licenseStatusResponse, error) {
		if material != fixture.material {
			t.Fatalf("query material = %#v", material)
		}
		return receipt, nil
	}
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
	cache, err := os.ReadFile(filepath.Join(fixture.root, "license", lifecycleCacheFilename))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{fixture.material.StartupSecret, fixture.material.USBFingerprint, receipt.Receipt.Value, "signature", "authorization"} {
		if strings.Contains(strings.ToLower(string(cache)), strings.ToLower(forbidden)) {
			t.Fatalf("cache leaked forbidden value %q", forbidden)
		}
	}
}

func TestVerifyLicenseLifecycleDistinguishesOnlineUnavailableAndTerminalStates(t *testing.T) {
	tests := []struct {
		status licenseLifecycleStatus
		want   error
	}{
		{licenseStatusProvisioning, ErrLicenseProvisioning},
		{licenseStatusRevoked, ErrLicenseRevoked},
		{licenseStatusReissued, ErrLicenseReissued},
		{licenseStatusExpired, ErrLicenseExpired},
		{licenseStatusDisabled, ErrLicenseDisabled},
	}
	for _, test := range tests {
		t.Run(string(test.status), func(t *testing.T) {
			fixture := newLifecycleFixture(t)
			fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
				return fixture.response(t, test.status, fixture.now, fixture.now), nil
			}
			if err := fixture.verify(); !errors.Is(err, test.want) || errors.Is(err, ErrLicenseStatusUnavailable) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestVerifyLicenseLifecycleFailsClosedOnFirstOfflineStart(t *testing.T) {
	fixture := newLifecycleFixture(t)
	if err := fixture.verify(); !errors.Is(err, ErrLicenseOfflineCacheMissing) {
		t.Fatalf("returned %v", err)
	}
}

func TestVerifyLicenseLifecycleBoundsOfflineGraceByServerPolicyAnd24Hours(t *testing.T) {
	fixture := newLifecycleFixture(t)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		return fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour)), nil
	}
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
	fixture.query = nil
	fixture.now = fixture.now.Add(24*time.Hour - time.Nanosecond)
	if err := fixture.verify(); err != nil {
		t.Fatalf("inside 24h grace returned %v", err)
	}
	fixture.now = fixture.now.Add(time.Nanosecond)
	if err := fixture.verify(); !errors.Is(err, ErrLicenseOfflineGraceExpired) {
		t.Fatalf("24h boundary returned %v", err)
	}

	short := newLifecycleFixture(t)
	short.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		return short.response(t, licenseStatusActive, short.now, short.now.Add(time.Hour)), nil
	}
	if err := short.verify(); err != nil {
		t.Fatal(err)
	}
	short.query = nil
	short.now = short.now.Add(time.Hour)
	if err := short.verify(); !errors.Is(err, ErrLicenseOfflineGraceExpired) {
		t.Fatalf("server grace boundary returned %v", err)
	}
}

func TestVerifyLicenseLifecycleRejectsClockRollbackAndCacheTamper(t *testing.T) {
	fixture := newLifecycleFixture(t)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		return fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour)), nil
	}
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
	fixture.query = nil
	fixture.now = fixture.now.Add(-time.Minute)
	if err := fixture.verify(); !errors.Is(err, ErrLicenseClockRollback) {
		t.Fatalf("rollback returned %v", err)
	}

	fixture = newLifecycleFixture(t)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		return fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour)), nil
	}
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(fixture.root, "license", lifecycleCacheFilename)
	cache, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cache[len(cache)/2] ^= 1
	if err := os.WriteFile(path, cache, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.query = nil
	if err := fixture.verify(); !errors.Is(err, ErrLicenseOfflineCacheInvalid) {
		t.Fatalf("tamper returned %v", err)
	}
}

func TestVerifyLicenseLifecycleDoesNotFallbackOnInvalidOnlineReceipt(t *testing.T) {
	fixture := newLifecycleFixture(t)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		return fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour)), nil
	}
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
	invalid := fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour))
	parts := strings.Split(invalid.Receipt.Value, ".")
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	signature[0] ^= 1
	invalid.Receipt.Value = parts[0] + "." + base64.RawURLEncoding.EncodeToString(signature)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) { return invalid, nil }
	if err := fixture.verify(); !errors.Is(err, ErrLicenseStatusReceiptInvalid) {
		t.Fatalf("invalid receipt returned %v", err)
	}
}

func TestVerifyLicenseLifecycleRejectsNonCanonicalReceiptBase64(t *testing.T) {
	fixture := newLifecycleFixture(t)
	response := fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour))
	parts := strings.Split(response.Receipt.Value, ".")
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := strings.IndexByte(alphabet, parts[1][len(parts[1])-1])
	if last < 0 || last&15 != 0 {
		t.Fatalf("unexpected canonical signature suffix %q", parts[1][len(parts[1])-1])
	}
	parts[1] = parts[1][:len(parts[1])-1] + string(alphabet[last+1])
	response.Receipt.Value = strings.Join(parts, ".")
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) { return response, nil }
	if err := fixture.verify(); !errors.Is(err, ErrLicenseStatusReceiptInvalid) {
		t.Fatalf("non-canonical receipt returned %v", err)
	}
}

func TestVerifyLicenseLifecycleReturnsTypedSignedIdentityMismatches(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*licenseStatusResponse)
		want   error
	}{
		{"device", func(response *licenseStatusResponse) { response.Status.DeviceID = "dev_mismatch_001" }, ErrLicenseStatusDeviceMismatch},
		{"license", func(response *licenseStatusResponse) { response.Status.LicenseID = "lic_mismatch_001" }, ErrLicenseStatusLicenseMismatch},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLifecycleFixture(t)
			response := fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour))
			test.mutate(&response)
			response = resignLifecycleResponse(t, fixture, response, fixture.now, fixture.now.Add(24*time.Hour))
			fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) { return response, nil }
			err := fixture.verify()
			if !errors.Is(err, test.want) || errors.Is(err, ErrLicenseStatusReceiptInvalid) {
				t.Fatalf("mismatch returned %v", err)
			}
			for _, forbidden := range []string{response.Status.DeviceID, response.Status.LicenseID, fixture.material.StartupSecret} {
				if strings.Contains(err.Error(), forbidden) {
					t.Fatalf("error leaked %q: %v", forbidden, err)
				}
			}
		})
	}
}

func TestVerifyLicenseLifecycleNeverAcceptsTerminalCacheOffline(t *testing.T) {
	for _, test := range []struct {
		status licenseLifecycleStatus
		want   error
	}{{licenseStatusRevoked, ErrLicenseRevoked}, {licenseStatusReissued, ErrLicenseReissued}} {
		t.Run(string(test.status), func(t *testing.T) {
			fixture := newLifecycleFixture(t)
			fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
				return fixture.response(t, test.status, fixture.now, fixture.now), nil
			}
			if err := fixture.verify(); !errors.Is(err, test.want) {
				t.Fatalf("online terminal returned %v", err)
			}
			fixture.query = nil
			fixture.now = fixture.now.Add(time.Minute)
			if err := fixture.verify(); !errors.Is(err, test.want) {
				t.Fatalf("offline terminal returned %v", err)
			}
		})
	}
}

func TestVerifyLicenseLifecycleRejectsRestoredActiveSnapshotAfterTerminalStatus(t *testing.T) {
	fixture := newLifecycleFixture(t)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		return fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour)), nil
	}
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(fixture.root, "license", lifecycleCacheFilename)
	activeSnapshot, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	terminalAt := fixture.now.Add(time.Minute)
	terminalResponse := fixture.response(t, licenseStatusRevoked, terminalAt, terminalAt)
	terminalResponse.Status.Revision = 2
	terminalResponse = resignLifecycleResponse(t, fixture, terminalResponse, terminalAt, terminalAt)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) { return terminalResponse, nil }
	fixture.now = fixture.now.Add(time.Minute)
	if err := fixture.verify(); !errors.Is(err, ErrLicenseRevoked) {
		t.Fatalf("revocation returned %v", err)
	}
	if err := os.WriteFile(cachePath, activeSnapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.query = nil
	if err := fixture.verify(); !errors.Is(err, ErrLicenseRevoked) {
		t.Fatalf("restored active snapshot returned %v", err)
	}
}

func TestVerifyLicenseLifecycleRejectsOldActiveCacheAfterObservedTimeAdvances(t *testing.T) {
	fixture := newLifecycleFixture(t)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		return fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour)), nil
	}
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(fixture.root, "license", lifecycleCacheFilename)
	oldCache, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	fixture.query = nil
	fixture.now = fixture.now.Add(time.Minute)
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, oldCache, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.now = fixture.now.Add(time.Minute)
	if err := fixture.verify(); !errors.Is(err, ErrLicenseOfflineCacheInvalid) {
		t.Fatalf("restored active cache returned %v", err)
	}
}

func TestVerifyLicenseLifecycleRejectsLowerRevisionOnlineReplay(t *testing.T) {
	fixture := newLifecycleFixture(t)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		response := fixture.response(t, licenseStatusRevoked, fixture.now, fixture.now)
		response.Status.Revision = 2
		return resignLifecycleResponse(t, fixture, response, fixture.now, fixture.now), nil
	}
	if err := fixture.verify(); !errors.Is(err, ErrLicenseRevoked) {
		t.Fatalf("terminal prime returned %v", err)
	}
	fixture.now = fixture.now.Add(time.Minute)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) {
		return fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(time.Hour)), nil
	}
	if err := fixture.verify(); !errors.Is(err, ErrLicenseStatusReceiptInvalid) {
		t.Fatalf("lower revision replay returned %v", err)
	}
}

func TestVerifyLicenseLifecycleRejectsExpiredOnlineActiveReceipt(t *testing.T) {
	fixture := newLifecycleFixture(t)
	checkedAt := fixture.now
	response := fixture.response(t, licenseStatusActive, checkedAt, checkedAt.Add(time.Hour))
	fixture.now = checkedAt.Add(time.Hour)
	fixture.query = func(verifiedLicenseMaterial) (licenseStatusResponse, error) { return response, nil }
	if err := fixture.verify(); !errors.Is(err, ErrLicenseOfflineGraceExpired) {
		t.Fatalf("expired online receipt returned %v", err)
	}
}

func resignLifecycleResponse(t *testing.T, fixture *lifecycleFixture, response licenseStatusResponse, checkedAt, graceUntil time.Time) licenseStatusResponse {
	t.Helper()
	payload := []any{
		"uclaw-license-status-v1", 1, response.Status.LicenseID, response.Status.DeviceID, response.Status.Status, response.Status.Revision,
		response.Status.NotBefore, response.Status.ExpiresAt, nullableString(response.Status.ReplacementLicenseID), response.Status.UpdatedAt,
		checkedAt.Format(time.RFC3339Nano), graceUntil.Format(time.RFC3339Nano), "test-status-key",
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	response.Receipt.Value = base64.RawURLEncoding.EncodeToString(encoded) + "." +
		base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, encoded))
	return response
}

func TestLicenseStatusHTTPClientUsesLoopbackTestBoundaryWithoutLeakingAuthorization(t *testing.T) {
	fixture := newLifecycleFixture(t)
	response := fixture.response(t, licenseStatusActive, fixture.now, fixture.now.Add(24*time.Hour))
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/licenses/"+fixture.material.LicenseID+"/status" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer "+fixture.material.StartupSecret {
			t.Fatal("missing startup authorization")
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(response)
	}))
	defer server.Close()
	query, err := newLicenseStatusHTTPClient(licenseStatusHTTPClientOptions{
		Endpoint:          server.URL + "/v1/licenses/",
		AllowLoopbackHTTP: true,
		HTTPClient:        server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := query(fixture.material)
	if err != nil || !sameLicenseStatus(got.Status, response.Status) || got.Receipt.Value != response.Receipt.Value {
		t.Fatalf("response=%#v err=%v", got, err)
	}
}

func TestLicenseStatusHTTPClientRequiresProductionHTTPSAndConfiguredEndpoint(t *testing.T) {
	for _, test := range []struct {
		name     string
		endpoint string
		allow    bool
	}{
		{"missing", "", false},
		{"remote-http", "http://example.test/status/", false},
		{"loopback-without-test-flag", "http://127.0.0.1:18080/status/", false},
		{"near-loopback", "http://127.0.0.2:18080/status/", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := newLicenseStatusHTTPClient(licenseStatusHTTPClientOptions{Endpoint: test.endpoint, AllowLoopbackHTTP: test.allow}); !errors.Is(err, ErrLicenseLifecycleConfigAbsent) {
				t.Fatalf("returned %v", err)
			}
		})
	}
	if _, err := newLicenseStatusHTTPClient(licenseStatusHTTPClientOptions{Endpoint: "https://license.example.test/v1/status/"}); err != nil {
		t.Fatal(err)
	}
}

func TestLicenseStatusHTTPClientSeparatesTransportAuthenticationAndInvalidResponse(t *testing.T) {
	fixture := newLifecycleFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":{"message":"` + fixture.material.StartupSecret + ` Authorization"}}`))
	}))
	query, err := newLicenseStatusHTTPClient(licenseStatusHTTPClientOptions{
		Endpoint: server.URL + "/", AllowLoopbackHTTP: true, HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := query(fixture.material); !errors.Is(err, ErrLicenseStatusAuthentication) || strings.Contains(err.Error(), fixture.material.StartupSecret) {
		t.Fatalf("authentication returned %v", err)
	}
	server.Close()
	if _, err := query(fixture.material); !errors.Is(err, ErrLicenseStatusUnavailable) {
		t.Fatalf("transport returned %v", err)
	}

	invalid := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/plain")
		_, _ = writer.Write([]byte("not json " + fixture.material.StartupSecret))
	}))
	defer invalid.Close()
	query, err = newLicenseStatusHTTPClient(licenseStatusHTTPClientOptions{
		Endpoint: invalid.URL + "/", AllowLoopbackHTTP: true, HTTPClient: invalid.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := query(fixture.material); !errors.Is(err, ErrLicenseStatusResponseInvalid) || strings.Contains(err.Error(), fixture.material.StartupSecret) {
		t.Fatalf("invalid response returned %v", err)
	}
}
