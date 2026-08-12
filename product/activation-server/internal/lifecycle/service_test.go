package lifecycle

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"u-claw-activation-server/internal/security"
)

type fixtureRepository struct {
	license        License
	recovery       RecoveryRecord
	expireCalls    int
	grant          *TokenGrant
	expireMutation func(*License)
	auditOutcomes  []string
}

type recoveryEnvelope struct{ calls int }

func (envelope *recoveryEnvelope) Decrypt(context.Context, security.EnvelopeBinding, []byte) ([]byte, error) {
	envelope.calls++
	return []byte("recovered"), nil
}

func (repository fixtureRepository) GetLicense(context.Context, string) (License, error) {
	return repository.license, nil
}

func (repository *fixtureRepository) ExpireLicense(_ context.Context, _ string, now time.Time) (License, error) {
	repository.expireCalls++
	if repository.license.Status == "active" && !now.Before(repository.license.ExpiresAt) {
		repository.license.Status = "expired"
		repository.license.Revision++
		repository.license.UpdatedAt = now
	}
	if repository.expireMutation != nil {
		repository.expireMutation(&repository.license)
	}
	return repository.license, nil
}
func (repository *fixtureRepository) GetActivationForRecovery(context.Context, string) (RecoveryRecord, error) {
	return repository.recovery, nil
}
func (repository *fixtureRepository) RecordRecovery(_ context.Context, _, _, outcome string) error {
	repository.auditOutcomes = append(repository.auditOutcomes, outcome)
	return nil
}
func (repository *fixtureRepository) CreateTokenGrant(_ context.Context, grant TokenGrant) (TokenGrant, error) {
	if repository.grant != nil {
		if repository.grant.DeviceID != grant.DeviceID || repository.grant.LicenseID != grant.LicenseID || repository.grant.JTI != grant.JTI {
			return TokenGrant{}, ErrIdempotencyConflict
		}
		return *repository.grant, nil
	}
	repository.grant = &grant
	return grant, nil
}

func TestStatusSignsLauncherCompatibleReceipt(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 13, 1, 2, 3, 4, time.UTC)
	secret := "fixture-startup-secret-material-0001"
	salt := []byte("0123456789abcdef")
	hash := sha256.New()
	_, _ = hash.Write([]byte("uclaw-startup-secret-v1\x00"))
	_, _ = hash.Write(salt)
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(secret))
	license := License{
		LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", Revision: 2,
		NotBefore: now.Add(-time.Hour), ExpiresAt: now.Add(48 * time.Hour), UpdatedAt: now.Add(-time.Minute),
		StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil),
	}
	service, err := NewService(ServiceOptions{
		Repository: &fixtureRepository{license: license}, KeyID: "status-key-001", PrivateKey: privateKey, TokenSigningKey: []byte("01234567890123456789012345678901"),
		Now: func() time.Time { return now }, MaximumGrace: 24 * time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := service.Status(context.Background(), license.LicenseID, secret)
	if err != nil {
		t.Fatal(err)
	}
	parts := splitReceipt(response.Receipt.Value)
	if len(parts) != 2 {
		t.Fatalf("receipt parts = %d", len(parts))
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		t.Fatal("receipt signature invalid")
	}
	var fields []any
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 13 || fields[0] != "uclaw-license-status-v1" || fields[12] != "status-key-001" {
		t.Fatalf("canonical fields = %#v", fields)
	}
	if response.Status.ReplacementLicenseID != nil {
		t.Fatal("active replacement must be null")
	}
}

func TestDeviceTokenIdempotentReplayIsDeterministic(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 13, 1, 2, 3, 0, time.UTC)
	secret := "fixture-startup-secret-material-0001"
	salt := []byte("0123456789abcdef")
	hash := sha256.New()
	hash.Write([]byte("uclaw-startup-secret-v1\x00"))
	hash.Write(salt)
	hash.Write([]byte{0})
	hash.Write([]byte(secret))
	repository := &fixtureRepository{license: License{LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", Revision: 1, NotBefore: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour), UpdatedAt: now, StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil)}}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, TokenSigningKey: []byte("01234567890123456789012345678901"), Now: func() time.Time { return now }, MaximumGrace: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	input := DeviceTokenInput{DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", IdempotencyKey: "token-fixture-001", StartupSecret: secret}
	first, err := service.DeviceToken(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return now.Add(time.Minute) }
	second, err := service.DeviceToken(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("replay changed token: first=%+v second=%+v", first, second)
	}
	input.DeviceID = "dev_fixture_002"
	if _, err := service.DeviceToken(context.Background(), input); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("conflict=%v", err)
	}
}

func TestRecoverRejectsInactiveLicenseBeforeDecrypting(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := "fixture-startup-secret-material-0001"
	salt := []byte("0123456789abcdef")
	hash := sha256.New()
	hash.Write([]byte("uclaw-startup-secret-v1\x00"))
	hash.Write(salt)
	hash.Write([]byte{0})
	hash.Write([]byte(secret))
	for _, status := range []string{"disabled", "revoked", "reissued"} {
		t.Run(status, func(t *testing.T) {
			envelope := &recoveryEnvelope{}
			repository := &fixtureRepository{
				license:  License{LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: status, StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil)},
				recovery: RecoveryRecord{ActivationID: "act_fixture_001", DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", ArtifactEnvelope: []byte("sealed"), ArtifactKeyVersion: "kms-v1"},
			}
			service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, TokenSigningKey: []byte("01234567890123456789012345678901"), MaximumGrace: time.Hour, Envelope: envelope})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = service.Recover(context.Background(), RecoverInput{ActivationID: "act_fixture_001", StartupSecret: secret, RequestID: "request_fixture_001"}); !errors.Is(err, ErrAuthentication) {
				t.Fatalf("error=%v", err)
			}
			if envelope.calls != 0 {
				t.Fatalf("decrypt calls=%d", envelope.calls)
			}
		})
	}
}

func TestStatusPersistsExpiryBeforeSigningReceipt(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 13, 1, 2, 3, 0, time.UTC)
	secret := "fixture-startup-secret-material-0001"
	salt := []byte("0123456789abcdef")
	hash := sha256.New()
	_, _ = hash.Write([]byte("uclaw-startup-secret-v1\x00"))
	_, _ = hash.Write(salt)
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(secret))
	repository := &fixtureRepository{license: License{
		LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", Revision: 4,
		NotBefore: now.Add(-48 * time.Hour), ExpiresAt: now.Add(-time.Second), UpdatedAt: now.Add(-time.Hour),
		StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil),
	}}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, TokenSigningKey: []byte("01234567890123456789012345678901"), Now: func() time.Time { return now }, MaximumGrace: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	response, err := service.Status(context.Background(), repository.license.LicenseID, secret)
	if err != nil {
		t.Fatal(err)
	}
	if repository.expireCalls != 1 || response.Status.Status != "expired" || response.Status.Revision != 5 || response.Status.UpdatedAt != now.Format(time.RFC3339Nano) {
		t.Fatalf("response=%+v calls=%d", response.Status, repository.expireCalls)
	}
}

func TestStatusReauthenticatesRecordReturnedByExpiryTransaction(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 13, 1, 2, 3, 0, time.UTC)
	secret := "fixture-startup-secret-material-0001"
	salt := []byte("0123456789abcdef")
	hash := sha256.New()
	hash.Write([]byte("uclaw-startup-secret-v1\x00"))
	hash.Write(salt)
	hash.Write([]byte{0})
	hash.Write([]byte(secret))
	repository := &fixtureRepository{license: License{LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", Revision: 1, NotBefore: now.Add(-time.Hour), ExpiresAt: now.Add(-time.Second), UpdatedAt: now, StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil)}}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, TokenSigningKey: []byte("01234567890123456789012345678901"), Now: func() time.Time { return now }, MaximumGrace: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	repository.license.StartupSecretHash = append([]byte(nil), repository.license.StartupSecretHash...)
	// Expiry repository response is independently trusted only after reauthentication.
	repository.expireMutation = func(record *License) { record.StartupSecretHash[0] ^= 1 }
	if _, err := service.Status(context.Background(), repository.license.LicenseID, secret); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("error=%v", err)
	}
}

func splitReceipt(value string) []string {
	for index := range value {
		if value[index] == '.' {
			return []string{value[:index], value[index+1:]}
		}
	}
	return []string{value}
}

func TestStatusMatchesSharedProductionGolden(t *testing.T) {
	var fixture struct {
		Seed, CheckedAt, StartupSecret string
		Response                       Response
	}
	contents, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "fixtures", "activation-status-response-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(contents, &fixture); err != nil {
		t.Fatal(err)
	}
	seed, err := base64.RawStdEncoding.DecodeString(fixture.Seed)
	if err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339Nano, fixture.CheckedAt)
	if err != nil {
		t.Fatal(err)
	}
	salt := []byte("0123456789abcdef")
	hash := sha256.New()
	hash.Write([]byte("uclaw-startup-secret-v1\x00"))
	hash.Write(salt)
	hash.Write([]byte{0})
	hash.Write([]byte(fixture.StartupSecret))
	repository := &fixtureRepository{license: License{LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", Revision: 2, NotBefore: now.Add(-time.Hour), ExpiresAt: now.Add(48 * time.Hour), UpdatedAt: now.Add(-time.Minute), StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil)}}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: ed25519.NewKeyFromSeed(seed), TokenSigningKey: []byte("01234567890123456789012345678901"), Now: func() time.Time { return now }, MaximumGrace: 24 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	response, err := service.Status(context.Background(), repository.license.LicenseID, fixture.StartupSecret)
	if err != nil {
		t.Fatal(err)
	}
	if response != fixture.Response {
		t.Fatalf("response drifted from shared golden")
	}
}
