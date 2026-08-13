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
	license          License
	recovery         RecoveryRecord
	expireCalls      int
	expireMutation   func(*License)
	auditOutcomes    []string
	authorizeErr     error
	recoveryAuditErr error
	auditContext     context.Context
	auditCtxErr      error
	auditDeadline    time.Time
	auditHasLimit    bool
	authorizeCalls   int
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
func (repository *fixtureRepository) AuthorizeRecovery(ctx context.Context, _, _ string) (RecoveryRecord, error) {
	repository.authorizeCalls++
	repository.auditContext = ctx
	repository.auditCtxErr = ctx.Err()
	repository.auditDeadline, repository.auditHasLimit = ctx.Deadline()
	repository.auditOutcomes = append(repository.auditOutcomes, "authorized")
	if repository.authorizeErr != nil {
		return RecoveryRecord{}, repository.authorizeErr
	}
	return repository.recovery, nil
}
func (repository *fixtureRepository) RecordRecovery(ctx context.Context, _, _, outcome string) error {
	repository.auditContext = ctx
	repository.auditCtxErr = ctx.Err()
	repository.auditDeadline, repository.auditHasLimit = ctx.Deadline()
	repository.auditOutcomes = append(repository.auditOutcomes, outcome)
	return repository.recoveryAuditErr
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
		Repository: &fixtureRepository{license: license}, KeyID: "status-key-001", PrivateKey: privateKey,
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
			service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, MaximumGrace: time.Hour, Envelope: envelope})
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

func TestRecoverDoesNotReturnMaterialWhenSuccessAuditFails(t *testing.T) {
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
	repository := &fixtureRepository{
		license:          License{LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil)},
		recovery:         RecoveryRecord{ActivationID: "act_fixture_001", DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", ArtifactEnvelope: []byte("sealed"), ArtifactKeyVersion: "kms-v1"},
		recoveryAuditErr: errors.New("audit unavailable"),
	}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, MaximumGrace: time.Hour, Envelope: &recoveryEnvelope{}})
	if err != nil {
		t.Fatal(err)
	}
	material, err := service.Recover(context.Background(), RecoverInput{ActivationID: "act_fixture_001", StartupSecret: secret, RequestID: "request_fixture_001"})
	if !errors.Is(err, ErrUnavailable) || material != nil {
		t.Fatalf("material=%q error=%v", material, err)
	}
	if len(repository.auditOutcomes) != 2 || repository.auditOutcomes[0] != "authorized" || repository.auditOutcomes[1] != "succeeded" {
		t.Fatalf("audit outcomes=%v", repository.auditOutcomes)
	}
}

func TestRecoverRecordsAuthorizationThenFailureWhenDecryptFails(t *testing.T) {
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
	repository := &fixtureRepository{
		license:  License{LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil)},
		recovery: RecoveryRecord{ActivationID: "act_fixture_001", DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", ArtifactEnvelope: []byte("sealed"), ArtifactKeyVersion: "kms-v1"},
	}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, MaximumGrace: time.Hour, Envelope: failingRecoveryEnvelope{}})
	if err != nil {
		t.Fatal(err)
	}
	material, err := service.Recover(context.Background(), RecoverInput{ActivationID: "act_fixture_001", StartupSecret: secret, RequestID: "request_fixture_001"})
	if !errors.Is(err, ErrUnavailable) || material != nil {
		t.Fatalf("material=%q error=%v", material, err)
	}
	if len(repository.auditOutcomes) != 2 || repository.auditOutcomes[0] != "authorized" || repository.auditOutcomes[1] != "failed" {
		t.Fatalf("audit outcomes=%v", repository.auditOutcomes)
	}
}

type failingRecoveryEnvelope struct{}

func (failingRecoveryEnvelope) Decrypt(context.Context, security.EnvelopeBinding, []byte) ([]byte, error) {
	return nil, errors.New("decrypt failed")
}

func TestRecoverAuthorizesAfterSecretAuthenticationAndBeforeDecrypting(t *testing.T) {
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
	repository := &fixtureRepository{
		license:  License{LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil)},
		recovery: RecoveryRecord{ActivationID: "act_fixture_001", DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", ArtifactEnvelope: []byte("sealed"), ArtifactKeyVersion: "kms-v1"},
	}
	envelope := &recoveryEnvelope{}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, MaximumGrace: time.Hour, Envelope: envelope})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Recover(context.Background(), RecoverInput{ActivationID: "act_fixture_001", StartupSecret: "wrong-secret-material-that-is-long-enough", RequestID: "request_fixture_001"}); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("wrong secret error=%v", err)
	}
	if repository.authorizeCalls != 0 || envelope.calls != 0 {
		t.Fatalf("wrong secret authorize=%d decrypt=%d", repository.authorizeCalls, envelope.calls)
	}
	if _, err = service.Recover(context.Background(), RecoverInput{ActivationID: "act_fixture_001", StartupSecret: secret, RequestID: "request_fixture_002"}); err != nil {
		t.Fatal(err)
	}
	if repository.authorizeCalls != 1 || envelope.calls != 1 {
		t.Fatalf("valid recovery authorize=%d decrypt=%d", repository.authorizeCalls, envelope.calls)
	}
}

func TestRecoverSuccessAuditUsesIndependentBoundedContext(t *testing.T) {
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
	repository := &fixtureRepository{
		license:  License{LicenseID: "lic_fixture_001", DeviceID: "dev_fixture_001", Status: "active", StartupSecretSalt: salt, StartupSecretHash: hash.Sum(nil)},
		recovery: RecoveryRecord{ActivationID: "act_fixture_001", DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", ArtifactEnvelope: []byte("sealed"), ArtifactKeyVersion: "kms-v1"},
	}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, MaximumGrace: time.Hour, Envelope: &recoveryEnvelope{}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	material, err := service.Recover(ctx, RecoverInput{ActivationID: "act_fixture_001", StartupSecret: secret, RequestID: "request_fixture_001"})
	if err != nil || string(material) != "recovered" {
		t.Fatalf("material=%q error=%v", material, err)
	}
	if repository.auditContext == nil || repository.auditCtxErr != nil {
		t.Fatalf("audit context error=%v", repository.auditCtxErr)
	}
	if !repository.auditHasLimit || time.Until(repository.auditDeadline) <= 0 || time.Until(repository.auditDeadline) > 6*time.Second {
		t.Fatalf("audit deadline=%v ok=%v", repository.auditDeadline, repository.auditHasLimit)
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
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, Now: func() time.Time { return now }, MaximumGrace: time.Hour})
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
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: privateKey, Now: func() time.Time { return now }, MaximumGrace: time.Hour})
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
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "status-key-001", PrivateKey: ed25519.NewKeyFromSeed(seed), Now: func() time.Time { return now }, MaximumGrace: 24 * time.Hour})
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
