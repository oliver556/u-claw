package license

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	algorithm          = "Ed25519"
	defaultSchema      = "uclaw.license.v1"
	defaultKeyID       = "dev-ed25519-2026-08"
	defaultTTL         = 365 * 24 * time.Hour
	publicKeyHexLength = ed25519.PublicKeySize * 2
)

// DefaultModels describes the model ids bound into a signed license artifact.
type DefaultModels struct {
	Text  string `json:"text"`
	Image string `json:"image"`
	Video string `json:"video"`
}

// Request contains the activation facts that become signed license payload.
type Request struct {
	ActivationID          string
	Subject               string
	USBFingerprintSummary string
	NewAPIBaseURL         string
	TokenVersion          int
	DefaultModels         DefaultModels
	IssuedAt              time.Time
}

// Payload is the canonical JSON object signed by the activation server.
type Payload struct {
	SchemaVersion         string        `json:"schemaVersion"`
	ActivationID          string        `json:"activationId"`
	LicenseID             string        `json:"licenseId"`
	Subject               string        `json:"subject"`
	USBFingerprintSummary string        `json:"usbFingerprintSummary"`
	NewAPIBaseURL         string        `json:"newapiBaseUrl"`
	TokenVersion          int           `json:"tokenVersion"`
	DefaultModels         DefaultModels `json:"defaultModels"`
	IssuedAt              string        `json:"issuedAt"`
	ExpiresAt             string        `json:"expiresAt"`
}

// Signature carries the public metadata needed by the client verifier.
type Signature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

// Artifact is the license.json-ready response body returned to the client.
type Artifact struct {
	Payload   Payload   `json:"payload"`
	Signature Signature `json:"signature"`
}

// Ed25519Signer signs license payloads with a single active key.
type Ed25519Signer struct {
	keyID      string
	privateKey ed25519.PrivateKey
	ttl        time.Duration
	now        func() time.Time
}

// NewEd25519SignerFromSeedHex creates a signer from a 32-byte hex seed.
func NewEd25519SignerFromSeedHex(keyID string, seedHex string, ttl time.Duration) (*Ed25519Signer, error) {
	seed, err := hex.DecodeString(strings.TrimSpace(seedHex))
	if err != nil {
		return nil, fmt.Errorf("decode license signing seed: %w", err)
	}
	return NewEd25519Signer(keyID, seed, ttl)
}

// NewEd25519Signer creates a signer from a raw 32-byte Ed25519 seed.
func NewEd25519Signer(keyID string, seed []byte, ttl time.Duration) (*Ed25519Signer, error) {
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return nil, fmt.Errorf("license signing key id is required")
	}
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("license signing seed must be %d bytes", ed25519.SeedSize)
	}
	if ttl <= 0 {
		ttl = defaultTTL
	}
	seedCopy := append([]byte(nil), seed...)
	return &Ed25519Signer{
		keyID:      keyID,
		privateKey: ed25519.NewKeyFromSeed(seedCopy),
		ttl:        ttl,
		now:        time.Now,
	}, nil
}

// NewDevelopmentSigner returns a deterministic signer for local smoke tests only.
func NewDevelopmentSigner() *Ed25519Signer {
	sum := sha256.Sum256([]byte("uclaw-dev-license-signing-seed-v1"))
	signer, err := NewEd25519Signer(defaultKeyID, sum[:], defaultTTL)
	if err != nil {
		panic(err)
	}
	return signer
}

// Sign returns a signed license artifact ready for client-side persistence.
func (s *Ed25519Signer) Sign(req Request) (Artifact, error) {
	if s == nil {
		return Artifact{}, fmt.Errorf("license signer is required")
	}
	activationID := strings.TrimSpace(req.ActivationID)
	subject := strings.ToUpper(strings.TrimSpace(req.Subject))
	usbSummary := strings.TrimSpace(req.USBFingerprintSummary)
	if activationID == "" {
		return Artifact{}, fmt.Errorf("activation id is required")
	}
	if subject == "" {
		return Artifact{}, fmt.Errorf("license subject is required")
	}
	if usbSummary == "" {
		return Artifact{}, fmt.Errorf("usb fingerprint summary is required")
	}
	issuedAt := req.IssuedAt
	if issuedAt.IsZero() {
		issuedAt = s.now()
	}
	issuedAt = issuedAt.UTC().Truncate(time.Second)
	payload := Payload{
		SchemaVersion:         defaultSchema,
		ActivationID:          activationID,
		LicenseID:             licenseIDFor(activationID, subject),
		Subject:               subject,
		USBFingerprintSummary: usbSummary,
		NewAPIBaseURL:         strings.TrimRight(strings.TrimSpace(req.NewAPIBaseURL), "/"),
		TokenVersion:          req.TokenVersion,
		DefaultModels:         req.DefaultModels,
		IssuedAt:              issuedAt.Format(time.RFC3339),
		ExpiresAt:             issuedAt.Add(s.ttl).UTC().Truncate(time.Second).Format(time.RFC3339),
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return Artifact{}, fmt.Errorf("marshal license payload: %w", err)
	}
	signature := ed25519.Sign(s.privateKey, payloadBytes)
	return Artifact{
		Payload: payload,
		Signature: Signature{
			Algorithm: algorithm,
			KeyID:     s.keyID,
			Value:     base64.StdEncoding.EncodeToString(signature),
		},
	}, nil
}

// PublicKeyHex returns the public verification key for deployment documentation and tests.
func (s *Ed25519Signer) PublicKeyHex() string {
	if s == nil {
		return ""
	}
	publicKey := s.privateKey.Public().(ed25519.PublicKey)
	return hex.EncodeToString(publicKey)
}

// Verify checks that artifact payload matches its Ed25519 signature.
func Verify(artifact Artifact, publicKeyHex string) error {
	publicKey, err := hex.DecodeString(strings.TrimSpace(publicKeyHex))
	if err != nil {
		return fmt.Errorf("decode license public key: %w", err)
	}
	if len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("license public key must be %d hex chars", publicKeyHexLength)
	}
	if artifact.Signature.Algorithm != algorithm {
		return fmt.Errorf("unsupported license signature algorithm")
	}
	signature, err := base64.StdEncoding.DecodeString(artifact.Signature.Value)
	if err != nil {
		return fmt.Errorf("decode license signature: %w", err)
	}
	payloadBytes, err := json.Marshal(artifact.Payload)
	if err != nil {
		return fmt.Errorf("marshal license payload: %w", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey), payloadBytes, signature) {
		return fmt.Errorf("license signature is invalid")
	}
	return nil
}

// licenseIDFor derives a stable public license id without exposing activation code material.
func licenseIDFor(activationID string, subject string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(activationID) + "\x00" + strings.ToUpper(strings.TrimSpace(subject))))
	return "lic_" + hex.EncodeToString(sum[:])[:24]
}
