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
	ActivationCode     string
	FingerprintVersion string
	FingerprintSHA256  string
	DeviceAliases      []DeviceAliasInput
	ClientVersion      string
	IdempotencyKey     string
	RequestID          string
}

type DeviceAliasInput struct {
	Target      string                 `json:"target"`
	Fingerprint DeviceAliasFingerprint `json:"fingerprint"`
	Evidence    DeviceAliasEvidence    `json:"evidence"`
}

type DeviceAliasFingerprint struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

type DeviceAliasEvidence struct {
	Target                 string `json:"target"`
	Platform               string `json:"platform"`
	Arch                   string `json:"arch"`
	Source                 string `json:"source"`
	BusType                string `json:"busType,omitempty"`
	BusProtocol            string `json:"busProtocol,omitempty"`
	DeviceLocation         string `json:"deviceLocation,omitempty"`
	Vendor                 string `json:"vendor"`
	Product                string `json:"product"`
	Revision               string `json:"revision,omitempty"`
	Serial                 string `json:"serial"`
	CapacityBytes          int64  `json:"capacityBytes"`
	UniqueDescriptorSHA256 string `json:"uniqueDescriptorSha256,omitempty"`
	VolumeUUID             string `json:"volumeUuid,omitempty"`
	MediaUUID              string `json:"mediaUuid,omitempty"`
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
	RecoveryRequestID         string
	AuditEventID              string
	StatusEventID             string
	BoundAuditEventID         string
	Stage                     string
	DeviceTokenID             string
	DeviceTokenDigest         []byte
	PublicModelEndpoint       string
	DefaultModel              string
}

type BeginBindingInput struct {
	ActivationCodeDigest [32]byte
	IdempotencyKey       string
	Record               BoundRecord
}

type ValidateBindingInput struct {
	ActivationCodeDigest [32]byte
	IdempotencyKey       string
	RequestFingerprint   [32]byte
	FingerprintVersion   string
	FingerprintSHA256    string
}

type BeginBindingResult struct {
	Disposition    BindingDisposition
	Record         BoundRecord
	LeaseRecovered bool
}

type Observer interface {
	RecordDBFailure(operation string)
	RecordBindingLeaseStale()
	RecordSigningFailure(dependency string)
	RecordCommitStale()
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
	RecordRecovery(context.Context, string, string, string) error
}

type LicenseSigner interface {
	Sign(license.SigningPayload) (string, error)
}

type Envelope interface {
	Encrypt(context.Context, security.EnvelopeBinding, []byte) ([]byte, error)
	Decrypt(context.Context, security.EnvelopeBinding, []byte) ([]byte, error)
}
