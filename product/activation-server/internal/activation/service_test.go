package activation

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"u-claw-activation-server/internal/license"
	"u-claw-activation-server/internal/security"
)

type fakeRepository struct {
	beginResult   BeginBindingResult
	beginErr      error
	complete      BoundRecord
	completeErr   error
	beginInput    BeginBindingInput
	completeIn    CompleteBindingInput
	beginCalls    int
	finishCalls   int
	validateErr   error
	validateCalls int
}

func (repository *fakeRepository) ValidateBinding(context.Context, ValidateBindingInput) error {
	repository.validateCalls++
	if repository.validateErr != nil {
		return repository.validateErr
	}
	return repository.beginErr
}

func (repository *fakeRepository) BeginBinding(_ context.Context, input BeginBindingInput) (BeginBindingResult, error) {
	repository.beginCalls++
	repository.beginInput = input
	if repository.beginResult.Record.ActivationID == "" && repository.beginErr == nil {
		repository.beginResult = BeginBindingResult{Disposition: BindingAcquired, Record: input.Record}
	}
	return repository.beginResult, repository.beginErr
}

func (repository *fakeRepository) CompleteBinding(_ context.Context, input CompleteBindingInput) (BoundRecord, error) {
	repository.finishCalls++
	repository.completeIn = input
	if repository.complete.ActivationID == "" && repository.completeErr == nil {
		repository.complete = input.Record
	}
	return repository.complete, repository.completeErr
}

func (repository *fakeRepository) CommitActivation(context.Context, CommitInput) error { return nil }

type fakeSigner struct{ calls int }

func (signer *fakeSigner) Sign(payload license.SigningPayload) (string, error) {
	signer.calls++
	return "fixture-signature", nil
}

type fakeEnvelope struct {
	encryptCalls int
	decryptCalls int
}

type incrementingReader struct{ next byte }

func (reader *incrementingReader) Read(output []byte) (int, error) {
	for index := range output {
		output[index] = reader.next
		reader.next++
	}
	return len(output), nil
}

func (envelope *fakeEnvelope) Encrypt(_ context.Context, _ security.EnvelopeBinding, plaintext []byte) ([]byte, error) {
	envelope.encryptCalls++
	return append([]byte("sealed:"), plaintext...), nil
}

func (envelope *fakeEnvelope) Decrypt(_ context.Context, _ security.EnvelopeBinding, encoded []byte) ([]byte, error) {
	envelope.decryptCalls++
	return bytes.TrimPrefix(encoded, []byte("sealed:")), nil
}

func TestActivateFirstBindingUsesTwoPhasesAndReturnsPersistedEnvelope(t *testing.T) {
	repository := &fakeRepository{}
	signer := &fakeSigner{}
	envelope := &fakeEnvelope{}
	service := newTestService(t, repository, signer, envelope)

	result, err := service.Activate(context.Background(), fixtureInput())
	if err != nil {
		t.Fatal(err)
	}
	if repository.beginCalls != 1 || repository.finishCalls != 1 || signer.calls != 1 {
		t.Fatalf("calls begin=%d complete=%d signer=%d", repository.beginCalls, repository.finishCalls, signer.calls)
	}
	if repository.completeIn.LeaseToken != repository.beginInput.Record.LeaseToken {
		t.Fatal("completion did not use acquired lease token")
	}
	if !bytes.Equal(result.Envelope, repository.completeIn.Record.ArtifactEnvelope) {
		t.Fatal("result did not return persisted final envelope")
	}
	if len(result.Material) == 0 || bytes.Contains(result.Material, []byte(`"signature":""`)) {
		t.Fatal("activation material is empty or unsigned")
	}
	var material activationMaterial
	if err := json.Unmarshal(result.Material, &material); err != nil {
		t.Fatal(err)
	}
	if material.Status != "active" || material.License.SchemaVersion != 1 ||
		material.License.Signature.Algorithm != "ed25519" || material.License.Signature.KeyID != "test-license-key" ||
		material.StartupCredential.SchemaVersion != 1 || material.BuiltinCredential.SchemaVersion != 1 ||
		material.BuiltinCredential.ExpiresAt == "" {
		t.Fatalf("material does not match frozen activation response: %+v", material)
	}
	salt, err := hex.DecodeString(material.License.StartupSecretProof.StartupSecretSalt)
	if err != nil {
		t.Fatal(err)
	}
	if got := startupSecretHash(material.StartupCredential.StartupSecret, salt); hex.EncodeToString(got[:]) != material.License.StartupSecretProof.StartupSecretHash {
		t.Fatal("startup secret does not match persisted proof")
	}
}

func TestActivateRejectsInvalidOpenAPIInputBeforeDependencies(t *testing.T) {
	tests := map[string]func(*ActivateInput){
		"short username":        func(input *ActivateInput) { input.Username = "ab" },
		"long username":         func(input *ActivateInput) { input.Username = strings.Repeat("a", 129) },
		"noncanonical code":     func(input *ActivateInput) { input.ActivationCode = "01234-56789-ABCDE-FGHJK-MNPQRS" },
		"uppercase fingerprint": func(input *ActivateInput) { input.FingerprintSHA256 = strings.Repeat("A", 64) },
		"bad semver":            func(input *ActivateInput) { input.ClientVersion = "v1" },
		"short idempotency":     func(input *ActivateInput) { input.IdempotencyKey = "short" },
		"bad request ID":        func(input *ActivateInput) { input.RequestID = "bad request" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			repository := &fakeRepository{}
			signer := &fakeSigner{}
			envelope := &fakeEnvelope{}
			service := newTestService(t, repository, signer, envelope)
			input := fixtureInput()
			mutate(&input)
			if _, err := service.Activate(context.Background(), input); !errors.Is(err, ErrActivationInvalid) {
				t.Fatalf("error=%v", err)
			}
			if repository.validateCalls != 0 || envelope.encryptCalls != 0 || signer.calls != 0 {
				t.Fatal("invalid input reached dependencies")
			}
		})
	}
}

func TestActivateRejectsNonStrictPendingMaterial(t *testing.T) {
	for _, pending := range [][]byte{
		[]byte(`{"startupSecret":"secret","builtinToken":"token","extra":true}`),
		[]byte(`{"startupSecret":"secret","builtinToken":"token"} {}`),
	} {
		repository := &fakeRepository{beginResult: BeginBindingResult{Disposition: BindingAcquired, Record: BoundRecord{
			ActivationID: "00000000-0000-4000-8000-000000000001", DeviceID: "00000000-0000-4000-8000-000000000002",
			LicenseID: "00000000-0000-4000-8000-000000000003", PendingMaterialKeyVersion: "kms-v1",
			PendingMaterialEnvelope: append([]byte("sealed:"), pending...),
		}}}
		service := newTestService(t, repository, &fakeSigner{}, &fakeEnvelope{})
		if _, err := service.Activate(context.Background(), fixtureInput()); !errors.Is(err, ErrActivationServiceUnavailable) {
			t.Fatalf("error=%v", err)
		}
	}
}

func TestActivateReturnsSameBoundEnvelopeWithoutSigningAgain(t *testing.T) {
	envelope := &fakeEnvelope{}
	record := BoundRecord{
		ActivationID: "00000000-0000-4000-8000-000000000001", UsernameID: "00000000-0000-4000-8000-000000000010",
		DeviceID: "00000000-0000-4000-8000-000000000002", LicenseID: "00000000-0000-4000-8000-000000000003",
		FingerprintVersion: "uclaw-usb-v1", FingerprintSHA256: strings.Repeat("a", 64), KeyID: "test-license-key",
		NotBefore: time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC), ExpiresAt: time.Date(2027, 8, 13, 0, 0, 0, 0, time.UTC), Revision: 1,
		StartupSecretSalt: bytes.Repeat([]byte{1}, 16), ArtifactKeyVersion: "kms-v1", Stage: "server_bound",
	}
	record.StartupSecretHash = startupSecretHash(strings.Repeat("s", 32), record.StartupSecretSalt)
	boundMaterial, err := json.Marshal(newActivationMaterial(record, pendingMaterial{StartupSecret: strings.Repeat("s", 32), BuiltinToken: strings.Repeat("t", 32)}, "fixture-signature"))
	if err != nil {
		t.Fatal(err)
	}
	record.ArtifactEnvelope = append([]byte("sealed:"), boundMaterial...)
	repository := &fakeRepository{beginResult: BeginBindingResult{
		Disposition: BindingBound,
		Record:      record,
	}}
	signer := &fakeSigner{}
	service := newTestService(t, repository, signer, envelope)

	result, err := service.Activate(context.Background(), fixtureInput())
	if err != nil {
		t.Fatal(err)
	}
	if signer.calls != 0 || repository.finishCalls != 0 {
		t.Fatal("bound recovery performed signing or completion")
	}
	if !bytes.Equal(result.Envelope, repository.beginResult.Record.ArtifactEnvelope) || !bytes.Equal(result.Material, boundMaterial) {
		t.Fatal("bound recovery did not return identical persisted material")
	}
}

func TestActivateMapsRepositoryGuardsWithoutCallingCrypto(t *testing.T) {
	for _, expected := range []error{ErrActivationInvalid, ErrNewAPINotConfigured, ErrIdempotencyConflict, ErrActivationCodeAlreadyBound, ErrActivationInProgress} {
		t.Run(expected.Error(), func(t *testing.T) {
			repository := &fakeRepository{validateErr: expected}
			signer := &fakeSigner{}
			envelope := &fakeEnvelope{}
			service := newTestService(t, repository, signer, envelope)
			_, err := service.Activate(context.Background(), fixtureInput())
			if !errors.Is(err, expected) {
				t.Fatalf("error = %v, want %v", err, expected)
			}
			if signer.calls != 0 || envelope.encryptCalls != 0 || envelope.decryptCalls != 0 || repository.beginCalls != 0 {
				t.Fatal("guard failure reached signing/decryption")
			}
		})
	}
}

func TestActivateCompletesRecoveredExpiredLeaseFromPendingEnvelope(t *testing.T) {
	envelope := &fakeEnvelope{}
	service := newTestService(t, &fakeRepository{}, &fakeSigner{}, envelope)
	input := fixtureInput()
	firstRepository := service.repository.(*fakeRepository)
	first, err := service.Activate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	pending := firstRepository.beginInput.Record
	pending.ArtifactEnvelope = nil
	pending.ArtifactKeyVersion = ""
	pending.LeaseToken = "00000000-0000-4000-8000-000000000099"
	recoveryRepository := &fakeRepository{beginResult: BeginBindingResult{Disposition: BindingAcquired, Record: pending}}
	recovery := newTestService(t, recoveryRepository, &fakeSigner{}, envelope)
	second, err := recovery.Activate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if recoveryRepository.finishCalls != 1 || len(second.Envelope) == 0 {
		t.Fatal("expired lease was not recovered and completed")
	}
	if !bytes.Equal(first.Material, second.Material) {
		t.Fatal("recovered pending material changed")
	}
}

func newTestService(t *testing.T, repository Repository, signer LicenseSigner, envelope Envelope) *Service {
	t.Helper()
	service, err := NewService(ServiceOptions{
		Repository: repository,
		Signer:     signer,
		Envelope:   envelope,
		Pepper:     []byte("0123456789abcdef0123456789abcdef"),
		KeyID:      "test-license-key", KeyVersion: "kms-v1",
		LeaseTTL:   time.Minute,
		LicenseTTL: 365 * 24 * time.Hour,
		Now:        func() time.Time { return time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC) },
		Random:     &incrementingReader{next: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func fixtureInput() ActivateInput {
	return ActivateInput{
		Username: "UCLAW-00000001", ActivationCode: "0123456789ABCDEFGHJKMNPQRS",
		FingerprintVersion: "uclaw-usb-v1", FingerprintSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ClientVersion: "1.0.0", IdempotencyKey: "activation-fixture-001", RequestID: "req_fixture_001",
	}
}
