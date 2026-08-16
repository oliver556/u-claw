package activation

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"

	"u-claw-activation-server/internal/deviceaccess"
	"u-claw-activation-server/internal/inventory"
	"u-claw-activation-server/internal/license"
	"u-claw-activation-server/internal/modelendpoint"
	"u-claw-activation-server/internal/security"
)

const requestFingerprintDomain = "uclaw-activation-request-v2"

type ServiceOptions struct {
	Repository          Repository
	Signer              LicenseSigner
	Envelope            Envelope
	Pepper              []byte
	KeyID               string
	KeyVersion          string
	LeaseTTL            time.Duration
	LicenseTTL          time.Duration
	Now                 func() time.Time
	Random              io.Reader
	Observer            Observer
	PublicModelEndpoint string
}

type Service struct {
	repository          Repository
	signer              LicenseSigner
	envelope            Envelope
	pepper              []byte
	keyID               string
	keyVersion          string
	leaseTTL            time.Duration
	licenseTTL          time.Duration
	now                 func() time.Time
	random              io.Reader
	observer            Observer
	deviceAccess        *deviceaccess.Service
	publicModelEndpoint string
}

type pendingMaterial struct {
	StartupSecret string `json:"startupSecret"`
	DeviceTokenID string `json:"deviceTokenId"`
	DeviceToken   string `json:"deviceToken"`
}

type activationMaterial struct {
	ActivationID      string                    `json:"activationId"`
	DeviceID          string                    `json:"deviceId"`
	LicenseID         string                    `json:"licenseId"`
	License           startupLicenseArtifact    `json:"license"`
	StartupCredential startupCredentialArtifact `json:"startupCredential"`
	BuiltinCredential builtinCredentialArtifact `json:"builtinCredential"`
	Status            string                    `json:"status"`
}

type startupLicenseArtifact struct {
	SchemaVersion  int    `json:"schemaVersion"`
	UsernameID     string `json:"usernameId"`
	DeviceID       string `json:"deviceId"`
	LicenseID      string `json:"licenseId"`
	USBFingerprint struct {
		Scheme string `json:"scheme"`
		SHA256 string `json:"sha256"`
	} `json:"usbFingerprint"`
	StartupSecretProof struct {
		Algorithm         string `json:"algorithm"`
		StartupSecretSalt string `json:"startupSecretSalt"`
		StartupSecretHash string `json:"startupSecretHash"`
	} `json:"startupSecretProof"`
	NotBefore string `json:"notBefore"`
	ExpiresAt string `json:"expiresAt"`
	Revision  int64  `json:"revision"`
	Signature struct {
		Algorithm string `json:"algorithm"`
		KeyID     string `json:"keyId"`
		Value     string `json:"value"`
	} `json:"signature"`
}

type startupCredentialArtifact struct {
	SchemaVersion int    `json:"schemaVersion"`
	DeviceID      string `json:"deviceId"`
	LicenseID     string `json:"licenseId"`
	StartupSecret string `json:"startupSecret"`
}

type builtinCredentialArtifact struct {
	SchemaVersion int    `json:"schemaVersion"`
	DeviceID      string `json:"deviceId"`
	LicenseID     string `json:"licenseId"`
	Endpoint      string `json:"endpoint"`
	Model         string `json:"model"`
	DeviceToken   string `json:"deviceToken"`
}

var (
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)
	idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	sha256Pattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	semverPattern      = regexp.MustCompile(`^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$`)
)

func NewService(options ServiceOptions) (*Service, error) {
	if options.Repository == nil || options.Signer == nil || options.Envelope == nil || len(options.Pepper) < sha256.Size ||
		options.KeyID == "" || options.KeyVersion == "" || options.LeaseTTL <= 0 || options.LicenseTTL <= 0 || !modelendpoint.Valid(options.PublicModelEndpoint) {
		return nil, errors.New("activation service configuration invalid")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	deviceAccess, err := deviceaccess.NewService(options.Pepper, options.Random)
	if err != nil {
		return nil, errors.New("activation service configuration invalid")
	}
	return &Service{
		repository: options.Repository, signer: options.Signer, envelope: options.Envelope,
		pepper: append([]byte(nil), options.Pepper...), keyID: options.KeyID, keyVersion: options.KeyVersion,
		leaseTTL: options.LeaseTTL, licenseTTL: options.LicenseTTL, now: options.Now, random: options.Random,
		observer:     options.Observer,
		deviceAccess: deviceAccess, publicModelEndpoint: options.PublicModelEndpoint,
	}, nil
}

func (service *Service) Activate(ctx context.Context, input ActivateInput) (ActivateResult, error) {
	if err := validateActivateInput(input); err != nil {
		return ActivateResult{}, ErrActivationInvalid
	}
	digest, err := inventory.ActivationCodeDigest(service.pepper, input.ActivationCode)
	if err != nil {
		return ActivateResult{}, ErrActivationInvalid
	}
	fingerprint, err := canonicalRequestFingerprint(digest, input)
	if err != nil {
		return ActivateResult{}, ErrActivationInvalid
	}
	if err := service.repository.ValidateBinding(ctx, ValidateBindingInput{
		ActivationCodeDigest: array32(digest),
		IdempotencyKey:       input.IdempotencyKey, RequestFingerprint: fingerprint,
		FingerprintVersion: input.FingerprintVersion, FingerprintSHA256: input.FingerprintSHA256,
	}); err != nil {
		service.recordDBFailure("validate_binding", err)
		return ActivateResult{}, err
	}
	pending, err := service.newPendingMaterial()
	if err != nil {
		return ActivateResult{}, ErrActivationServiceUnavailable
	}
	record, err := service.newBindingRecord(input, fingerprint, pending.StartupSecret)
	if err != nil {
		return ActivateResult{}, ErrActivationServiceUnavailable
	}
	pendingBytes, _ := json.Marshal(pending)
	binding := envelopeBinding(record, service.keyVersion)
	record.PendingMaterialEnvelope, err = service.envelope.Encrypt(ctx, binding, pendingBytes)
	if err != nil {
		service.recordSigningFailure("kms")
		return ActivateResult{}, errors.Join(ErrActivationServiceUnavailable, err)
	}
	record.PendingMaterialKeyVersion = service.keyVersion

	begin, err := service.repository.BeginBinding(ctx, BeginBindingInput{
		ActivationCodeDigest: array32(digest),
		IdempotencyKey:       input.IdempotencyKey,
		Record:               record,
	})
	if err != nil {
		service.recordDBFailure("begin_binding", err)
		if isBindingBusinessError(err) {
			return ActivateResult{}, err
		}
		return boundFailure(record, err)
	}
	if begin.LeaseRecovered && service.observer != nil {
		service.observer.RecordBindingLeaseStale()
	}
	if begin.Disposition == BindingBound {
		return service.recoverBound(ctx, begin.Record, true)
	}
	begin.Record.PublicModelEndpoint = service.publicModelEndpoint
	return service.complete(ctx, begin.Record)
}

func isBindingBusinessError(err error) bool {
	return errors.Is(err, ErrActivationInvalid) || errors.Is(err, ErrNewAPINotConfigured) ||
		errors.Is(err, ErrIdempotencyConflict) || errors.Is(err, ErrActivationCodeAlreadyBound) ||
		errors.Is(err, ErrActivationInProgress)
}

func (service *Service) Commit(ctx context.Context, input CommitInput) error {
	if !identifierPattern.MatchString(input.ActivationID) || !idempotencyPattern.MatchString(input.IdempotencyKey) ||
		input.ArtifactGeneration < 1 || input.ArtifactGeneration > 9007199254740991 || !identifierPattern.MatchString(input.RequestID) {
		return ErrActivationInvalid
	}
	err := service.repository.CommitActivation(ctx, input)
	service.recordDBFailure("commit", err)
	if errors.Is(err, ErrActivationInProgress) && service.observer != nil {
		service.observer.RecordCommitStale()
	}
	return err
}

func (service *Service) complete(ctx context.Context, record BoundRecord) (ActivateResult, error) {
	binding := envelopeBinding(record, record.PendingMaterialKeyVersion)
	pendingBytes, err := service.envelope.Decrypt(ctx, binding, record.PendingMaterialEnvelope)
	if err != nil {
		service.recordSigningFailure("kms")
		return boundFailure(record, errors.Join(ErrActivationServiceUnavailable, err))
	}
	var pending pendingMaterial
	if err := decodeStrictJSON(pendingBytes, &pending); err != nil || len(pending.StartupSecret) < 32 || len(pending.DeviceToken) != 52 || pending.DeviceTokenID == "" {
		return boundFailure(record, ErrActivationServiceUnavailable)
	}
	payload := signingPayload(record)
	signature, err := service.signer.Sign(payload)
	if err != nil {
		service.recordSigningFailure("license")
		return boundFailure(record, errors.Join(ErrActivationServiceUnavailable, err))
	}
	material, err := json.Marshal(newActivationMaterial(record, pending, signature))
	if err != nil {
		return boundFailure(record, ErrActivationServiceUnavailable)
	}
	finalBinding := envelopeBinding(record, service.keyVersion)
	finalEnvelope, err := service.envelope.Encrypt(ctx, finalBinding, material)
	if err != nil {
		service.recordSigningFailure("kms")
		return boundFailure(record, errors.Join(ErrActivationServiceUnavailable, err))
	}
	record.ArtifactEnvelope = finalEnvelope
	record.ArtifactKeyVersion = service.keyVersion
	record.DeviceTokenID = pending.DeviceTokenID
	record.DeviceTokenDigest = service.deviceAccess.Digest(pending.DeviceToken)
	persisted, err := service.repository.CompleteBinding(ctx, CompleteBindingInput{LeaseToken: record.LeaseToken, Record: record})
	if err != nil {
		service.recordDBFailure("complete_binding", err)
		return boundFailure(record, err)
	}
	return service.recoverBound(ctx, persisted, false)
}

func (service *Service) recordDBFailure(operation string, err error) {
	if err != nil && service.observer != nil && !errors.Is(err, ErrActivationInvalid) &&
		!errors.Is(err, ErrActivationCodeAlreadyBound) && !errors.Is(err, ErrActivationInProgress) &&
		!errors.Is(err, ErrIdempotencyConflict) && !errors.Is(err, ErrNewAPINotConfigured) {
		service.observer.RecordDBFailure(operation)
	}
}

func (service *Service) recordSigningFailure(dependency string) {
	if service.observer != nil {
		service.observer.RecordSigningFailure(dependency)
	}
}

func (service *Service) recoverBound(ctx context.Context, record BoundRecord, recovery bool) (ActivateResult, error) {
	recoveryRequestID := record.RecoveryRequestID
	if recovery && recoveryRequestID == "" {
		return boundFailure(record, ErrActivationServiceUnavailable)
	}
	material, err := service.envelope.Decrypt(ctx, envelopeBinding(record, record.ArtifactKeyVersion), record.ArtifactEnvelope)
	if err != nil {
		if recovery {
			_ = service.repository.RecordRecovery(ctx, record.ActivationID, recoveryRequestID, "failed")
		}
		return boundFailure(record, errors.Join(ErrActivationServiceUnavailable, err))
	}
	var decoded activationMaterial
	if err := decodeStrictJSON(material, &decoded); err != nil || !validActivationMaterial(decoded, record) {
		if recovery {
			_ = service.repository.RecordRecovery(ctx, record.ActivationID, recoveryRequestID, "failed")
		}
		return boundFailure(record, ErrActivationServiceUnavailable)
	}
	if recovery {
		if err := service.repository.RecordRecovery(ctx, record.ActivationID, recoveryRequestID, "succeeded"); err != nil {
			return boundFailure(record, errors.Join(ErrActivationServiceUnavailable, err))
		}
	}
	return ActivateResult{ActivationID: record.ActivationID, DeviceID: record.DeviceID, LicenseID: record.LicenseID, Envelope: append([]byte(nil), record.ArtifactEnvelope...), Material: material}, nil
}

func boundFailure(record BoundRecord, err error) (ActivateResult, error) {
	return ActivateResult{ActivationID: record.ActivationID}, err
}

func (service *Service) newBindingRecord(input ActivateInput, fingerprint [32]byte, startupSecret string) (BoundRecord, error) {
	activationID, err := randomUUID(service.random)
	if err != nil {
		return BoundRecord{}, err
	}
	inventoryID, err := randomUUID(service.random)
	if err != nil {
		return BoundRecord{}, err
	}
	deviceID, err := randomUUID(service.random)
	if err != nil {
		return BoundRecord{}, err
	}
	licenseID, err := randomUUID(service.random)
	if err != nil {
		return BoundRecord{}, err
	}
	leaseToken, err := randomUUID(service.random)
	if err != nil {
		return BoundRecord{}, err
	}
	auditEventID, err := randomUUID(service.random)
	if err != nil {
		return BoundRecord{}, err
	}
	statusEventID, err := randomUUID(service.random)
	if err != nil {
		return BoundRecord{}, err
	}
	boundAuditEventID, err := randomUUID(service.random)
	if err != nil {
		return BoundRecord{}, err
	}
	salt := make([]byte, 16)
	if _, err := io.ReadFull(service.random, salt); err != nil {
		return BoundRecord{}, err
	}
	now := service.now().UTC().Truncate(time.Second)
	return BoundRecord{
		ActivationID: activationID, InventoryID: inventoryID, UsernameID: inventoryID,
		DeviceID: deviceID, LicenseID: licenseID, LeaseToken: leaseToken, LeaseExpiresAt: now.Add(service.leaseTTL),
		RequestFingerprint: fingerprint, FingerprintVersion: input.FingerprintVersion, FingerprintSHA256: input.FingerprintSHA256,
		KeyID: service.keyID, NotBefore: now, ExpiresAt: now.Add(service.licenseTTL), Revision: 1,
		StartupSecretSalt: salt, StartupSecretHash: startupSecretHash(startupSecret, salt), RequestID: input.RequestID,
		AuditEventID: auditEventID, StatusEventID: statusEventID, BoundAuditEventID: boundAuditEventID, Stage: "requested",
	}, nil
}

func (service *Service) newPendingMaterial() (pendingMaterial, error) {
	secret, err := randomToken(service.random, 32)
	if err != nil {
		return pendingMaterial{}, err
	}
	credential, err := service.deviceAccess.Issue()
	if err != nil {
		return pendingMaterial{}, err
	}
	return pendingMaterial{StartupSecret: secret, DeviceTokenID: credential.ID, DeviceToken: credential.Token}, nil
}

func canonicalRequestFingerprint(digest []byte, input ActivateInput) ([32]byte, error) {
	if len(digest) != sha256.Size {
		return [32]byte{}, errors.New("invalid activation request")
	}
	encoded, _ := json.Marshal([]any{requestFingerprintDomain, hex.EncodeToString(digest), input.FingerprintVersion, input.FingerprintSHA256, input.ClientVersion})
	return sha256.Sum256(encoded), nil
}

func validateActivateInput(input ActivateInput) error {
	if input.FingerprintVersion != "uclaw-usb-v1" || !sha256Pattern.MatchString(input.FingerprintSHA256) ||
		!semverPattern.MatchString(input.ClientVersion) || !idempotencyPattern.MatchString(input.IdempotencyKey) ||
		!identifierPattern.MatchString(input.RequestID) {
		return errors.New("invalid activation input")
	}
	normalizedCode, err := inventory.NormalizeActivationCode(input.ActivationCode)
	if err != nil || normalizedCode != input.ActivationCode {
		return errors.New("invalid activation input")
	}
	return nil
}

func newActivationMaterial(record BoundRecord, pending pendingMaterial, signature string) activationMaterial {
	notBefore := record.NotBefore.UTC().Format(time.RFC3339)
	expiresAt := record.ExpiresAt.UTC().Format(time.RFC3339)
	material := activationMaterial{
		ActivationID: record.ActivationID, DeviceID: record.DeviceID, LicenseID: record.LicenseID, Status: "active",
		License: startupLicenseArtifact{
			SchemaVersion: 1, UsernameID: record.UsernameID, DeviceID: record.DeviceID, LicenseID: record.LicenseID,
			NotBefore: notBefore, ExpiresAt: expiresAt, Revision: record.Revision,
		},
		StartupCredential: startupCredentialArtifact{SchemaVersion: 1, DeviceID: record.DeviceID, LicenseID: record.LicenseID, StartupSecret: pending.StartupSecret},
		BuiltinCredential: builtinCredentialArtifact{SchemaVersion: 1, DeviceID: record.DeviceID, LicenseID: record.LicenseID, Endpoint: record.PublicModelEndpoint, Model: record.DefaultModel, DeviceToken: pending.DeviceToken},
	}
	material.License.USBFingerprint.Scheme = record.FingerprintVersion
	material.License.USBFingerprint.SHA256 = record.FingerprintSHA256
	material.License.StartupSecretProof.Algorithm = "sha256-salt-v1"
	material.License.StartupSecretProof.StartupSecretSalt = hex.EncodeToString(record.StartupSecretSalt)
	material.License.StartupSecretProof.StartupSecretHash = hex.EncodeToString(record.StartupSecretHash[:])
	material.License.Signature.Algorithm = "ed25519"
	material.License.Signature.KeyID = record.KeyID
	material.License.Signature.Value = signature
	return material
}

func validActivationMaterial(material activationMaterial, record BoundRecord) bool {
	return material.Status == "active" && material.ActivationID == record.ActivationID &&
		material.DeviceID == record.DeviceID && material.LicenseID == record.LicenseID &&
		material.License.SchemaVersion == 1 && material.License.DeviceID == record.DeviceID && material.License.LicenseID == record.LicenseID &&
		material.License.Signature.Algorithm == "ed25519" && material.License.Signature.KeyID == record.KeyID && material.License.Signature.Value != "" &&
		material.StartupCredential.SchemaVersion == 1 && material.StartupCredential.DeviceID == record.DeviceID && material.StartupCredential.LicenseID == record.LicenseID &&
		material.BuiltinCredential.SchemaVersion == 1 && material.BuiltinCredential.DeviceID == record.DeviceID && material.BuiltinCredential.LicenseID == record.LicenseID &&
		validBuiltinCredential(material.BuiltinCredential)
}

func validBuiltinCredential(credential builtinCredentialArtifact) bool {
	if !modelendpoint.Valid(credential.Endpoint) || credential.Model == "" || strings.TrimSpace(credential.Model) != credential.Model {
		return false
	}
	const tokenPrefix = "uclaw_dt_"
	return strings.HasPrefix(credential.DeviceToken, tokenPrefix) && len(credential.DeviceToken) == len(tokenPrefix)+43
}

func decodeStrictJSON(encoded []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

func signingPayload(record BoundRecord) license.SigningPayload {
	return license.SigningPayload{
		SchemaVersion: 1, KeyID: record.KeyID, UsernameID: record.UsernameID, DeviceID: record.DeviceID, LicenseID: record.LicenseID,
		USBFingerprintVersion: record.FingerprintVersion, USBFingerprintSHA256: record.FingerprintSHA256,
		StartupSecretSalt: hex.EncodeToString(record.StartupSecretSalt), StartupSecretHash: hex.EncodeToString(record.StartupSecretHash[:]),
		NotBefore: record.NotBefore.UTC().Format(time.RFC3339), ExpiresAt: record.ExpiresAt.UTC().Format(time.RFC3339), Revision: record.Revision,
	}
}

func envelopeBinding(record BoundRecord, keyVersion string) security.EnvelopeBinding {
	return security.EnvelopeBinding{ActivationID: record.ActivationID, DeviceID: record.DeviceID, LicenseID: record.LicenseID, KeyVersion: keyVersion}
}

func startupSecretHash(secret string, salt []byte) [32]byte {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte("uclaw-startup-secret-v1\x00"))
	_, _ = hasher.Write(salt)
	_, _ = hasher.Write([]byte{0})
	_, _ = hasher.Write([]byte(secret))
	var result [32]byte
	copy(result[:], hasher.Sum(nil))
	return result
}

func randomToken(random io.Reader, size int) (string, error) {
	value := make([]byte, size)
	if _, err := io.ReadFull(random, value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func randomUUID(random io.Reader) (string, error) {
	value := make([]byte, 16)
	if _, err := io.ReadFull(random, value); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

func array32(value []byte) [32]byte {
	var result [32]byte
	copy(result[:], value)
	return result
}
