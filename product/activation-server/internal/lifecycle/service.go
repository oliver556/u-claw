package lifecycle

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"time"

	"u-claw-activation-server/internal/security"
)

const receiptDomain = "uclaw-license-status-v1"

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
	RecordRecovery(context.Context, string, string, string) error
	CreateTokenGrant(context.Context, TokenGrant) (TokenGrant, error)
}

type RecoveryRecord struct {
	ActivationID       string
	DeviceID           string
	LicenseID          string
	ArtifactEnvelope   []byte
	ArtifactKeyVersion string
}
type RecoverInput struct{ ActivationID, StartupSecret, RequestID string }

type TokenGrant struct {
	JTI            string
	DeviceID       string
	LicenseID      string
	IdempotencyKey string
	IssuedAt       time.Time
	ExpiresAt      time.Time
}

type DeviceTokenInput struct {
	DeviceID       string
	LicenseID      string
	IdempotencyKey string
	StartupSecret  string
}

type DeviceTokenResponse struct {
	AccessToken string `json:"accessToken"`
	TokenType   string `json:"tokenType"`
	ExpiresAt   string `json:"expiresAt"`
}

type Envelope interface {
	Decrypt(context.Context, security.EnvelopeBinding, []byte) ([]byte, error)
}

type ServiceOptions struct {
	Repository      Repository
	KeyID           string
	PrivateKey      ed25519.PrivateKey
	Now             func() time.Time
	MaximumGrace    time.Duration
	Envelope        Envelope
	Random          io.Reader
	TokenTTL        time.Duration
	TokenSigningKey []byte
}

type Service struct {
	repository      Repository
	keyID           string
	privateKey      ed25519.PrivateKey
	now             func() time.Time
	maximumGrace    time.Duration
	envelope        Envelope
	random          io.Reader
	tokenTTL        time.Duration
	tokenSigningKey []byte
}

func NewService(options ServiceOptions) (*Service, error) {
	if options.Repository == nil || !identifierPattern.MatchString(options.KeyID) || len(options.PrivateKey) != ed25519.PrivateKeySize || len(options.TokenSigningKey) < 32 || options.MaximumGrace <= 0 || options.MaximumGrace > 24*time.Hour {
		return nil, errors.New("lifecycle service configuration invalid")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	if options.TokenTTL == 0 {
		options.TokenTTL = 15 * time.Minute
	}
	if options.TokenTTL <= 0 || options.TokenTTL > time.Hour {
		return nil, errors.New("lifecycle token TTL invalid")
	}
	return &Service{repository: options.Repository, keyID: options.KeyID, privateKey: append(ed25519.PrivateKey(nil), options.PrivateKey...), now: options.Now, maximumGrace: options.MaximumGrace, envelope: options.Envelope, random: options.Random, tokenTTL: options.TokenTTL, tokenSigningKey: append([]byte(nil), options.TokenSigningKey...)}, nil
}

func (service *Service) Recover(ctx context.Context, input RecoverInput) ([]byte, error) {
	if service.envelope == nil || !identifierPattern.MatchString(input.ActivationID) || !identifierPattern.MatchString(input.RequestID) || len(input.StartupSecret) < 32 || len(input.StartupSecret) > 512 {
		return nil, ErrAuthentication
	}
	outcome := "failed"
	defer func() { _ = service.repository.RecordRecovery(ctx, input.ActivationID, input.RequestID, outcome) }()
	record, err := service.repository.GetActivationForRecovery(ctx, input.ActivationID)
	if err != nil {
		return nil, err
	}
	license, err := service.repository.GetLicense(ctx, record.LicenseID)
	if err != nil || license.DeviceID != record.DeviceID || !authenticate(license, input.StartupSecret) {
		return nil, ErrAuthentication
	}
	material, err := service.envelope.Decrypt(ctx, security.EnvelopeBinding{ActivationID: record.ActivationID, DeviceID: record.DeviceID, LicenseID: record.LicenseID, KeyVersion: record.ArtifactKeyVersion}, record.ArtifactEnvelope)
	if err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	outcome = "succeeded"
	return material, nil
}

func (service *Service) DeviceToken(ctx context.Context, input DeviceTokenInput) (DeviceTokenResponse, error) {
	if !identifierPattern.MatchString(input.DeviceID) || !identifierPattern.MatchString(input.LicenseID) || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`).MatchString(input.IdempotencyKey) || len(input.StartupSecret) < 32 || len(input.StartupSecret) > 512 {
		return DeviceTokenResponse{}, ErrAuthentication
	}
	license, err := service.repository.GetLicense(ctx, input.LicenseID)
	if err != nil || license.DeviceID != input.DeviceID || license.Status != "active" || !authenticate(license, input.StartupSecret) {
		return DeviceTokenResponse{}, ErrAuthentication
	}
	now := service.now().UTC()
	if !now.Before(license.ExpiresAt) {
		return DeviceTokenResponse{}, ErrAuthentication
	}
	jtiDigest := service.tokenMAC("jti", input.DeviceID, input.LicenseID, input.IdempotencyKey)
	jti := base64.RawURLEncoding.EncodeToString(jtiDigest[:16])
	expiresAt := now.Add(service.tokenTTL)
	if expiresAt.After(license.ExpiresAt) {
		expiresAt = license.ExpiresAt
	}
	grant, err := service.repository.CreateTokenGrant(ctx, TokenGrant{JTI: jti, DeviceID: input.DeviceID, LicenseID: input.LicenseID, IdempotencyKey: input.IdempotencyKey, IssuedAt: now, ExpiresAt: expiresAt})
	if err != nil {
		return DeviceTokenResponse{}, err
	}
	payload, _ := json.Marshal([]any{"uclaw-device-token-v1", grant.JTI, grant.DeviceID, grant.LicenseID, grant.IssuedAt.UTC().Format(time.RFC3339Nano), grant.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	signature := service.tokenMAC("token", string(payload))
	token := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature)
	return DeviceTokenResponse{AccessToken: token, TokenType: "Bearer", ExpiresAt: grant.ExpiresAt.UTC().Format(time.RFC3339Nano)}, nil
}

func (service *Service) tokenMAC(parts ...string) []byte {
	mac := hmac.New(sha256.New, service.tokenSigningKey)
	for _, part := range parts {
		mac.Write([]byte(part))
		mac.Write([]byte{0})
	}
	return mac.Sum(nil)
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
