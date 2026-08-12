package activation

import (
	"context"
	"errors"
	"time"

	"u-claw-activation-server/internal/license"
	"u-claw-activation-server/internal/security"
)

var (
	ErrActivationInvalid            = errors.New("ACTIVATION_INVALID")
	ErrNewAPINotConfigured          = errors.New("NEW_API_NOT_CONFIGURED")
	ErrActivationCodeAlreadyBound   = errors.New("ACTIVATION_CODE_ALREADY_BOUND")
	ErrIdempotencyConflict          = errors.New("IDEMPOTENCY_CONFLICT")
	ErrActivationInProgress         = errors.New("ACTIVATION_IN_PROGRESS")
	ErrActivationServiceUnavailable = errors.New("ACTIVATION_SERVICE_UNAVAILABLE")
)

type ActivateInput struct {
	Username           string
	ActivationCode     string
	FingerprintVersion string
	FingerprintSHA256  string
	ClientVersion      string
	IdempotencyKey     string
	RequestID          string
}

type ActivateResult struct {
	ActivationID string
	DeviceID     string
	LicenseID    string
	Envelope     []byte
	Material     []byte
}

type CommitInput struct {
	ActivationID       string
	IdempotencyKey     string
	ArtifactGeneration int64
	RequestID          string
}

type BindingDisposition uint8

const (
	BindingAcquired BindingDisposition = iota + 1
	BindingBound
)

type BoundRecord struct {
	ActivationID              string
	InventoryID               string
	UsernameID                string
	DeviceID                  string
	LicenseID                 string
	LeaseToken                string
	LeaseExpiresAt            time.Time
	RequestFingerprint        [32]byte
	FingerprintVersion        string
	FingerprintSHA256         string
	KeyID                     string
	NotBefore                 time.Time
	ExpiresAt                 time.Time
	Revision                  int64
	StartupSecretSalt         []byte
	StartupSecretHash         [32]byte
	PendingMaterialEnvelope   []byte
	PendingMaterialKeyVersion string
	ArtifactEnvelope          []byte
	ArtifactKeyVersion        string
	RequestID                 string
	AuditEventID              string
	StatusEventID             string
	BoundAuditEventID         string
	Stage                     string
}

type BeginBindingInput struct {
	UsernameNormalized   string
	ActivationCodeDigest [32]byte
	IdempotencyKey       string
	Record               BoundRecord
}

type ValidateBindingInput struct {
	UsernameNormalized   string
	ActivationCodeDigest [32]byte
	IdempotencyKey       string
	RequestFingerprint   [32]byte
	FingerprintVersion   string
	FingerprintSHA256    string
}

type BeginBindingResult struct {
	Disposition BindingDisposition
	Record      BoundRecord
}

type CompleteBindingInput struct {
	LeaseToken string
	Record     BoundRecord
}

type Repository interface {
	ValidateBinding(context.Context, ValidateBindingInput) error
	BeginBinding(context.Context, BeginBindingInput) (BeginBindingResult, error)
	CompleteBinding(context.Context, CompleteBindingInput) (BoundRecord, error)
	CommitActivation(context.Context, CommitInput) error
}

type LicenseSigner interface {
	Sign(license.SigningPayload) (string, error)
}

type Envelope interface {
	Encrypt(context.Context, security.EnvelopeBinding, []byte) ([]byte, error)
	Decrypt(context.Context, security.EnvelopeBinding, []byte) ([]byte, error)
}
