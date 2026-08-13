package lifecycle

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"u-claw-activation-server/internal/security"
)

const receiptDomain = "uclaw-license-status-v1"
const recoveryAuditTimeout = 5 * time.Second

var (
	ErrAuthentication      = errors.New("LICENSE_STATUS_AUTHENTICATION_FAILED")
	ErrNotFound            = errors.New("LICENSE_NOT_FOUND")
	ErrUnavailable         = errors.New("ACTIVATION_SERVICE_UNAVAILABLE")
	ErrIdempotencyConflict = errors.New("IDEMPOTENCY_CONFLICT")
	identifierPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)
)

type License struct {
	LicenseID            string
	DeviceID             string
	Status               string
	Revision             int64
	NotBefore            time.Time
	ExpiresAt            time.Time
	ReplacementLicenseID *string
	UpdatedAt            time.Time
	StartupSecretSalt    []byte
	StartupSecretHash    []byte
}

type StatusSummary struct {
	LicenseID            string  `json:"licenseId"`
	DeviceID             string  `json:"deviceId"`
	Status               string  `json:"status"`
	Revision             int64   `json:"revision"`
	NotBefore            string  `json:"notBefore"`
	ExpiresAt            string  `json:"expiresAt"`
	ReplacementLicenseID *string `json:"replacementLicenseId"`
	UpdatedAt            string  `json:"updatedAt"`
}

type Receipt struct {
	Value string `json:"value"`
}
type Response struct {
	Status  StatusSummary `json:"status"`
	Receipt Receipt       `json:"receipt"`
}

type Repository interface {
	GetLicense(context.Context, string) (License, error)
	ExpireLicense(context.Context, string, time.Time) (License, error)
	GetActivationForRecovery(context.Context, string) (RecoveryRecord, error)
	AuthorizeRecovery(context.Context, string, string) (RecoveryRecord, error)
	RecordRecovery(context.Context, string, string, string) error
}

type RecoveryRecord struct {
	ActivationID       string
	DeviceID           string
	LicenseID          string
	ArtifactEnvelope   []byte
	ArtifactKeyVersion string
}
type RecoverInput struct{ ActivationID, StartupSecret, RequestID string }

type Envelope interface {
	Decrypt(context.Context, security.EnvelopeBinding, []byte) ([]byte, error)
}

type ServiceOptions struct {
	Repository   Repository
	KeyID        string
	PrivateKey   ed25519.PrivateKey
	Now          func() time.Time
	MaximumGrace time.Duration
	Envelope     Envelope
}

type Service struct {
	repository   Repository
	keyID        string
	privateKey   ed25519.PrivateKey
	now          func() time.Time
	maximumGrace time.Duration
	envelope     Envelope
}

func NewService(options ServiceOptions) (*Service, error) {
	if options.Repository == nil || !identifierPattern.MatchString(options.KeyID) || len(options.PrivateKey) != ed25519.PrivateKeySize || options.MaximumGrace <= 0 || options.MaximumGrace > 24*time.Hour {
		return nil, errors.New("lifecycle service configuration invalid")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{repository: options.Repository, keyID: options.KeyID, privateKey: append(ed25519.PrivateKey(nil), options.PrivateKey...), now: options.Now, maximumGrace: options.MaximumGrace, envelope: options.Envelope}, nil
}

func (service *Service) Recover(ctx context.Context, input RecoverInput) ([]byte, error) {
	if service.envelope == nil || !identifierPattern.MatchString(input.ActivationID) || !identifierPattern.MatchString(input.RequestID) || len(input.StartupSecret) < 32 || len(input.StartupSecret) > 512 {
		return nil, ErrAuthentication
	}
	record, err := service.repository.GetActivationForRecovery(ctx, input.ActivationID)
	if err != nil {
		return nil, err
	}
	license, err := service.repository.GetLicense(ctx, record.LicenseID)
	if err != nil || license.DeviceID != record.DeviceID || license.Status != "active" || !authenticate(license, input.StartupSecret) {
		return nil, ErrAuthentication
	}
	record, err = service.authorizeRecovery(ctx, input)
	if err != nil {
		if errors.Is(err, ErrAuthentication) {
			return nil, ErrAuthentication
		}
		return nil, errors.Join(ErrUnavailable, err)
	}
	material, err := service.envelope.Decrypt(ctx, security.EnvelopeBinding{ActivationID: record.ActivationID, DeviceID: record.DeviceID, LicenseID: record.LicenseID, KeyVersion: record.ArtifactKeyVersion}, record.ArtifactEnvelope)
	if err != nil {
		_ = service.recordRecovery(ctx, input, "failed")
		return nil, errors.Join(ErrUnavailable, err)
	}
	if err = service.recordRecovery(ctx, input, "succeeded"); err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	return material, nil
}

func (service *Service) authorizeRecovery(ctx context.Context, input RecoverInput) (RecoveryRecord, error) {
	auditCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recoveryAuditTimeout)
	defer cancel()
	return service.repository.AuthorizeRecovery(auditCtx, input.ActivationID, input.RequestID)
}

func (service *Service) recordRecovery(ctx context.Context, input RecoverInput, outcome string) error {
	auditCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recoveryAuditTimeout)
	defer cancel()
	return service.repository.RecordRecovery(auditCtx, input.ActivationID, input.RequestID, outcome)
}

func (service *Service) Status(ctx context.Context, licenseID, startupSecret string) (Response, error) {
	if !identifierPattern.MatchString(licenseID) || len(startupSecret) < 32 || len(startupSecret) > 512 {
		return Response{}, ErrAuthentication
	}
	record, err := service.repository.GetLicense(ctx, licenseID)
	if err != nil {
		return Response{}, err
	}
	if !authenticate(record, startupSecret) {
		return Response{}, ErrAuthentication
	}
	now := service.now().UTC()
	if record.Status == "active" && !now.Before(record.ExpiresAt) {
		record, err = service.repository.ExpireLicense(ctx, licenseID, now)
		if err != nil {
			return Response{}, err
		}
		if !authenticate(record, startupSecret) {
			return Response{}, ErrAuthentication
		}
	}
	status := record.Status
	summary := StatusSummary{
		LicenseID: record.LicenseID, DeviceID: record.DeviceID, Status: status, Revision: record.Revision,
		NotBefore: record.NotBefore.UTC().Format(time.RFC3339Nano), ExpiresAt: record.ExpiresAt.UTC().Format(time.RFC3339Nano),
		ReplacementLicenseID: record.ReplacementLicenseID, UpdatedAt: record.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	graceUntil := now
	if status == "active" {
		graceUntil = now.Add(service.maximumGrace)
		if graceUntil.After(record.ExpiresAt) {
			graceUntil = record.ExpiresAt
		}
	}
	payload, err := json.Marshal([]any{receiptDomain, 1, summary.LicenseID, summary.DeviceID, summary.Status, summary.Revision, summary.NotBefore, summary.ExpiresAt, summary.ReplacementLicenseID, summary.UpdatedAt, now.Format(time.RFC3339Nano), graceUntil.Format(time.RFC3339Nano), service.keyID})
	if err != nil {
		return Response{}, ErrUnavailable
	}
	signature := ed25519.Sign(service.privateKey, payload)
	value := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature)
	return Response{Status: summary, Receipt: Receipt{Value: value}}, nil
}

func authenticate(record License, secret string) bool {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte("uclaw-startup-secret-v1\x00"))
	_, _ = hasher.Write(record.StartupSecretSalt)
	_, _ = hasher.Write([]byte{0})
	_, _ = hasher.Write([]byte(secret))
	digest := hasher.Sum(nil)
	return len(record.StartupSecretHash) == sha256.Size && subtle.ConstantTimeCompare(digest, record.StartupSecretHash) == 1
}
