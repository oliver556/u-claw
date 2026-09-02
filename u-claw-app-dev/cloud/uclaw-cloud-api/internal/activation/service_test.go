package activation

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"uclaw-cloud-api/internal/license"
)

func TestRedeemReturnsClientConfig(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{
		NewAPIBaseURL: "https://api.example.com/v1/",
		PreviewToken:  "preview-token",
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.Redeem(context.Background(), RedeemRequest{
		UserID:         7,
		Phone:          "13800138000",
		ActivationCode: "ABCD-EFGH-IJKL-MNOP",
	})
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}

	if result.Status != "activated" {
		t.Fatalf("status = %q", result.Status)
	}
	if result.PhoneMasked != "138****8000" {
		t.Fatalf("phone = %q", result.PhoneMasked)
	}
	if result.NewAPIBaseURL != "https://api.example.com/v1" {
		t.Fatalf("base url = %q", result.NewAPIBaseURL)
	}
	if result.NewAPIToken != "preview-token" {
		t.Fatal("missing preview token")
	}
	if result.DefaultModels.Text != "newapi/gpt-5.5" {
		t.Fatalf("text model = %q", result.DefaultModels.Text)
	}
}

func TestRedeemAllowsSameUserRetry(t *testing.T) {
	store := NewMemoryStore(true)
	service, err := NewService(store, Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	req := RedeemRequest{UserID: 1, Phone: "13800138000", ActivationCode: "ABCD-EFGH-IJKL"}
	if _, err := service.Redeem(context.Background(), req); err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	if _, err := service.Redeem(context.Background(), req); err != nil {
		t.Fatalf("second redeem same user: %v", err)
	}
}

func TestRedeemRejectsDuplicateCodeForDifferentUser(t *testing.T) {
	store := NewMemoryStore(true)
	service, err := NewService(store, Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	if _, err := service.Redeem(context.Background(), RedeemRequest{UserID: 1, Phone: "13800138000", ActivationCode: "ABCD-EFGH-IJKL"}); err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	if _, err := service.Redeem(context.Background(), RedeemRequest{UserID: 2, Phone: "13900139000", ActivationCode: "ABCD-EFGH-IJKL"}); err == nil {
		t.Fatal("second redeem different user succeeded, want duplicate error")
	}
}

func TestRedeemRejectsUnconfiguredStore(t *testing.T) {
	service, err := NewService(NewMemoryStore(false), Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	if _, err := service.Redeem(context.Background(), RedeemRequest{
		UserID:         1,
		Phone:          "13800138000",
		ActivationCode: "ABCD-EFGH-IJKL",
	}); err == nil {
		t.Fatal("redeem succeeded without configured activation store")
	}
}

func TestActivateFirstStartReturnsServerBoundEnvelope(t *testing.T) {
	signer := license.NewDevelopmentSigner()
	service, err := NewService(NewMemoryStore(true), Config{
		NewAPIBaseURL: "https://api.example.com/v1/",
		PreviewToken:  "preview-token",
		LicenseSigner: signer,
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Username:              "uclaw-biancheng",
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-static-1",
	})
	if err != nil {
		t.Fatalf("activate first start: %v", err)
	}

	if result.Status != "server_bound" {
		t.Fatalf("status = %q, want server_bound", result.Status)
	}
	if result.ActivationID == "" {
		t.Fatal("activation id is empty")
	}
	if result.UsernameMasked != "UCLAW-BIANCHENG" {
		t.Fatalf("username masked = %q", result.UsernameMasked)
	}
	if result.ArtifactStatus != "pending_client_write" {
		t.Fatalf("artifact status = %q", result.ArtifactStatus)
	}
	if result.NewAPIToken != "preview-token" {
		t.Fatalf("token = %q", result.NewAPIToken)
	}
	if result.LicenseArtifact.Payload.ActivationID != result.ActivationID {
		t.Fatalf("license activation id = %q, want %q", result.LicenseArtifact.Payload.ActivationID, result.ActivationID)
	}
	if result.LicenseArtifact.Payload.Subject != "UCLAW-BIANCHENG" {
		t.Fatalf("license subject = %q", result.LicenseArtifact.Payload.Subject)
	}
	if err := license.Verify(result.LicenseArtifact, signer.PublicKeyHex()); err != nil {
		t.Fatalf("license verify: %v", err)
	}
}

func TestActivateFirstStartReturnsUpdateCredentialWhenIssuerMatches(t *testing.T) {
	issuer := updateCredentialIssuerFunc(func(_ context.Context, req UpdateCredentialRequest) (UpdateCredential, error) {
		if req.Principal != "13800138000" || req.ActivationID == "" {
			t.Fatalf("unexpected update credential request: %+v", req)
		}
		return UpdateCredential{
			SchemaVersion:  "uclaw.update-credential.v1",
			UpdateCheckURL: "https://updates.example.com/uclaw/update/check",
			DeviceID:       "51f85535-c3fe-4608-bcdd-402a2e58f097",
			DeviceToken:    "uclaw_dt_test_token",
			PlatformKeys:   []string{"win32-x64"},
			IssuedAt:       req.IssuedAt.UTC().Format(time.RFC3339),
		}, nil
	})
	service, err := NewService(NewMemoryStore(true), Config{UpdateCredentialIssuer: issuer})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Phone:                 "13800138000",
		UserID:                42,
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "TEST-USB-SUMMARY",
		IdempotencyKey:        "idem-update-credential-1",
	})
	if err != nil {
		t.Fatalf("activate first start: %v", err)
	}

	if result.UpdateCredential == nil {
		t.Fatal("update credential missing")
	}
	if result.UpdateCredential.DeviceID != "51f85535-c3fe-4608-bcdd-402a2e58f097" {
		t.Fatalf("device id = %q", result.UpdateCredential.DeviceID)
	}
	if result.UpdateCredential.DeviceToken != "uclaw_dt_test_token" {
		t.Fatal("device token missing")
	}
}

func TestActivateFirstStartOmitsUnavailableUpdateCredential(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{
		UpdateCredentialIssuer: updateCredentialIssuerFunc(func(context.Context, UpdateCredentialRequest) (UpdateCredential, error) {
			return UpdateCredential{}, ErrUpdateCredentialNotAvailable
		}),
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Phone:                 "13800138000",
		UserID:                42,
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "TEST-USB-SUMMARY",
		IdempotencyKey:        "idem-update-credential-2",
	})
	if err != nil {
		t.Fatalf("activate first start: %v", err)
	}
	if result.UpdateCredential != nil {
		t.Fatalf("update credential = %+v, want nil", result.UpdateCredential)
	}
}

func TestUpdateCredentialFileIssuerRequiresAndMatchesBinding(t *testing.T) {
	now := time.Date(2026, 8, 29, 10, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "update-credential.json")
	if err := os.WriteFile(path, []byte(`{
  "updateCheckUrl": "https://updates.example.com/uclaw/update/check",
  "deviceId": "51f85535-c3fe-4608-bcdd-402a2e58f097",
  "deviceToken": "uclaw_dt_test_token",
  "platformKeys": ["win32-x64", "win32-x64", "darwin-arm64"],
  "allowedPrincipals": ["13800138000"],
  "allowedUsbFingerprintSummaries": ["TEST-USB-SUMMARY"],
  "expiresAt": "2026-08-30T00:00:00Z"
}`), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	issuer, err := NewUpdateCredentialFileIssuer(path)
	if err != nil {
		t.Fatalf("new issuer: %v", err)
	}

	credential, err := issuer.IssueUpdateCredential(context.Background(), UpdateCredentialRequest{
		Principal:             "13800138000",
		USBFingerprintSummary: "TEST-USB-SUMMARY",
		IssuedAt:              now,
	})
	if err != nil {
		t.Fatalf("issue credential: %v", err)
	}
	if credential.SchemaVersion != "uclaw.update-credential.v1" {
		t.Fatalf("schema = %q", credential.SchemaVersion)
	}
	if len(credential.PlatformKeys) != 2 {
		t.Fatalf("platform keys = %#v", credential.PlatformKeys)
	}
	if credential.DeviceToken != "uclaw_dt_test_token" {
		t.Fatal("device token missing")
	}

	_, err = issuer.IssueUpdateCredential(context.Background(), UpdateCredentialRequest{
		Principal:             "13900139000",
		USBFingerprintSummary: "TEST-USB-SUMMARY",
		IssuedAt:              now,
	})
	if err != ErrUpdateCredentialNotAvailable {
		t.Fatalf("mismatch error = %v, want ErrUpdateCredentialNotAvailable", err)
	}
}

func TestUpdateCredentialFileIssuerRejectsUnboundFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update-credential.json")
	if err := os.WriteFile(path, []byte(`{
  "updateCheckUrl": "https://updates.example.com/uclaw/update/check",
  "deviceId": "51f85535-c3fe-4608-bcdd-402a2e58f097",
  "deviceToken": "uclaw_dt_test_token"
}`), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	issuer, err := NewUpdateCredentialFileIssuer(path)
	if err != nil {
		t.Fatalf("new issuer: %v", err)
	}
	if _, err := issuer.IssueUpdateCredential(context.Background(), UpdateCredentialRequest{IssuedAt: time.Now()}); err == nil {
		t.Fatal("unbound credential file succeeded, want error")
	}
}

func TestActivateFirstStartAcceptsVerifiedPhonePrincipal(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Phone:                 "13800138000",
		UserID:                42,
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-phone-1",
	})
	if err != nil {
		t.Fatalf("activate first start with phone: %v", err)
	}
	if result.PhoneMasked != "138****8000" || result.UsernameMasked != "138****8000" {
		t.Fatalf("masked account = phone:%q username:%q", result.PhoneMasked, result.UsernameMasked)
	}
	if result.LicenseArtifact.Payload.Subject != "13800138000" {
		t.Fatalf("license subject = %q, want phone", result.LicenseArtifact.Payload.Subject)
	}
}

func TestActivateFirstStartIsIdempotentForSameRequest(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	req := FirstStartRequest{
		Username:              "UCLAW-BIANCHENG",
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-static-1",
	}

	first, err := service.ActivateFirstStart(context.Background(), req)
	if err != nil {
		t.Fatalf("first activate: %v", err)
	}
	second, err := service.ActivateFirstStart(context.Background(), req)
	if err != nil {
		t.Fatalf("second activate: %v", err)
	}

	if first.ActivationID != second.ActivationID {
		t.Fatalf("activation ids differ: %q vs %q", first.ActivationID, second.ActivationID)
	}
}

func TestCommitFirstStartMarksClientWriteComplete(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	activated, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Username:              "UCLAW-BIANCHENG",
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-static-1",
	})
	if err != nil {
		t.Fatalf("activate: %v", err)
	}

	committed, err := service.CommitFirstStart(context.Background(), CommitRequest{
		ActivationID: activated.ActivationID,
		WriteStatus:  "verified",
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}

	if committed.Status != "committed" {
		t.Fatalf("status = %q, want committed", committed.Status)
	}
	if committed.ActivationID != activated.ActivationID {
		t.Fatalf("activation id = %q, want %q", committed.ActivationID, activated.ActivationID)
	}
}

func TestFirstStartAttemptStorePersistsServerBoundAndCommit(t *testing.T) {
	store := newRecordingFirstStartStore()
	service, err := NewService(store, Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	activated, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Username:              "UCLAW-BIANCHENG",
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-static-1",
	})
	if err != nil {
		t.Fatalf("activate: %v", err)
	}

	if len(store.attempts) != 1 {
		t.Fatalf("attempts = %d, want 1", len(store.attempts))
	}
	attempt := store.attempts[0]
	if attempt.ActivationID != activated.ActivationID {
		t.Fatalf("attempt activation id = %q, want %q", attempt.ActivationID, activated.ActivationID)
	}
	if attempt.Stage != "server_bound" || attempt.ArtifactStatus != "pending_client_write" {
		t.Fatalf("attempt checkpoint = %+v", attempt)
	}

	restartedService, err := NewService(store, Config{})
	if err != nil {
		t.Fatalf("new restarted service: %v", err)
	}
	committed, err := restartedService.CommitFirstStart(context.Background(), CommitRequest{
		ActivationID: activated.ActivationID,
		WriteStatus:  "verified",
	})
	if err != nil {
		t.Fatalf("commit after restart: %v", err)
	}

	if committed.Status != "committed" {
		t.Fatalf("status = %q, want committed", committed.Status)
	}
	if store.commits[activated.ActivationID] != "verified" {
		t.Fatalf("stored write status = %q, want verified", store.commits[activated.ActivationID])
	}
}

func TestActivateFirstStartProvisionUsesPersistentUserID(t *testing.T) {
	store := &persistentFirstStartStore{
		MemoryStore:      NewMemoryStore(true),
		persistentUserID: 91,
	}
	provisioner := &recordingProvisioner{
		result: ProvisionResult{
			NewAPIUserID: 18,
			Token:        "sk-real-token",
			TokenVersion: 1,
		},
	}
	service, err := NewService(store, Config{Provisioner: provisioner})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Username:              "UCLAW-STAGE01",
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-static-1",
	})
	if err != nil {
		t.Fatalf("activate: %v", err)
	}

	if !provisioner.called {
		t.Fatal("provisioner was not called")
	}
	if provisioner.request.UserID != 91 {
		t.Fatalf("provision user id = %d, want persistent id 91", provisioner.request.UserID)
	}
	if result.NewAPIToken != "sk-real-token" {
		t.Fatalf("newapi token = %q", result.NewAPIToken)
	}
}

func TestRefreshNewAPICredentialUsesAuthenticatedUser(t *testing.T) {
	provisioner := &recordingProvisioner{
		result: ProvisionResult{
			NewAPIUserID: 18,
			Token:        "sk-refreshed-token",
			TokenVersion: 2,
		},
	}
	service, err := NewService(NewMemoryStore(true), Config{
		NewAPIBaseURL: "https://api.example.com/v1/",
		Provisioner:   provisioner,
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.RefreshNewAPICredential(context.Background(), RefreshCredentialRequest{
		UserID: 91,
		Phone:  "13800138000",
	})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}

	if !provisioner.called || provisioner.request.UserID != 91 || provisioner.request.Phone != "13800138000" || !provisioner.request.ForceRotateToken {
		t.Fatalf("provision request = %+v called=%v", provisioner.request, provisioner.called)
	}
	if result.NewAPIToken != "sk-refreshed-token" || result.TokenVersion != 2 {
		t.Fatalf("refresh result = %+v", result)
	}
}

type recordingFirstStartStore struct {
	*MemoryStore
	attempts []FirstStartAttempt
	commits  map[string]string
}

// newRecordingFirstStartStore returns a memory store that also records first-start checkpoints.
func newRecordingFirstStartStore() *recordingFirstStartStore {
	return &recordingFirstStartStore{
		MemoryStore: NewMemoryStore(true),
		commits:     make(map[string]string),
	}
}

// RecordFirstStartAttempt records the server-bound checkpoint for service tests.
func (s *recordingFirstStartStore) RecordFirstStartAttempt(_ context.Context, attempt FirstStartAttempt, _ time.Time) error {
	s.attempts = append(s.attempts, attempt)
	return nil
}

// CommitFirstStartAttempt records the write-helper checkpoint for service tests.
func (s *recordingFirstStartStore) CommitFirstStartAttempt(_ context.Context, activationID string, writeStatus string, _ time.Time) error {
	for _, attempt := range s.attempts {
		if attempt.ActivationID == activationID {
			s.commits[activationID] = writeStatus
			return nil
		}
	}
	return fmt.Errorf("activation id is unknown")
}

type persistentFirstStartStore struct {
	*MemoryStore
	persistentUserID int64
}

// BindFirstStart records the activation but returns a database-style id for provisioning tests.
func (s *persistentFirstStartStore) BindFirstStart(ctx context.Context, code string, username string, at time.Time) (int64, error) {
	if _, err := s.MemoryStore.BindFirstStart(ctx, code, username, at); err != nil {
		return 0, err
	}
	return s.persistentUserID, nil
}

type recordingProvisioner struct {
	request ProvisionRequest
	result  ProvisionResult
	called  bool
}

// ProvisionNewAPI records the request received from activation.Service.
func (p *recordingProvisioner) ProvisionNewAPI(_ context.Context, req ProvisionRequest) (ProvisionResult, error) {
	p.called = true
	p.request = req
	return p.result, nil
}

type updateCredentialIssuerFunc func(context.Context, UpdateCredentialRequest) (UpdateCredential, error)

// IssueUpdateCredential adapts a function for activation update-credential tests.
func (f updateCredentialIssuerFunc) IssueUpdateCredential(ctx context.Context, req UpdateCredentialRequest) (UpdateCredential, error) {
	return f(ctx, req)
}
