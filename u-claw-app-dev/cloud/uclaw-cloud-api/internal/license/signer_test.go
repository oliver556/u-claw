package license

import (
	"encoding/hex"
	"strings"
	"testing"
	"time"
)

func TestEd25519SignerSignsVerifiableArtifact(t *testing.T) {
	seed := strings.Repeat("11", 32)
	signer, err := NewEd25519SignerFromSeedHex("test-key", seed, 24*time.Hour)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	fixedTime := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	signer.now = func() time.Time { return fixedTime }

	artifact, err := signer.Sign(Request{
		ActivationID:          "act_123",
		Subject:               "uclaw-biancheng",
		USBFingerprintSummary: "PREVIEW-ONLY",
		NewAPIBaseURL:         "https://api.example.com/v1/",
		TokenVersion:          2,
		DefaultModels: DefaultModels{
			Text:  "newapi/gpt-5.5",
			Image: "newapi/gpt-image-2",
			Video: "newapi/seedance-1.5-pro-1080p-10s",
		},
	})
	if err != nil {
		t.Fatalf("Sign() error = %v", err)
	}

	if artifact.Payload.SchemaVersion != "uclaw.license.v1" {
		t.Fatalf("schema = %q", artifact.Payload.SchemaVersion)
	}
	if artifact.Payload.Subject != "UCLAW-BIANCHENG" {
		t.Fatalf("subject = %q", artifact.Payload.Subject)
	}
	if artifact.Payload.NewAPIBaseURL != "https://api.example.com/v1" {
		t.Fatalf("base url = %q", artifact.Payload.NewAPIBaseURL)
	}
	if artifact.Payload.IssuedAt != "2026-08-27T12:00:00Z" || artifact.Payload.ExpiresAt != "2026-08-28T12:00:00Z" {
		t.Fatalf("time window = %s -> %s", artifact.Payload.IssuedAt, artifact.Payload.ExpiresAt)
	}
	if artifact.Signature.Algorithm != "Ed25519" || artifact.Signature.KeyID != "test-key" || artifact.Signature.Value == "" {
		t.Fatalf("signature = %+v", artifact.Signature)
	}
	if err := Verify(artifact, signer.PublicKeyHex()); err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
}

func TestEd25519SignerIsDeterministicForSamePayload(t *testing.T) {
	seed := strings.Repeat("22", 32)
	signer, err := NewEd25519SignerFromSeedHex("test-key", seed, time.Hour)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	req := Request{
		ActivationID:          "act_123",
		Subject:               "UCLAW-BIANCHENG",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IssuedAt:              time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC),
	}

	first, err := signer.Sign(req)
	if err != nil {
		t.Fatalf("first sign: %v", err)
	}
	second, err := signer.Sign(req)
	if err != nil {
		t.Fatalf("second sign: %v", err)
	}

	if first.Signature.Value != second.Signature.Value {
		t.Fatalf("signature differs: %q vs %q", first.Signature.Value, second.Signature.Value)
	}
}

func TestVerifyRejectsTamperedPayload(t *testing.T) {
	signer := NewDevelopmentSigner()
	artifact, err := signer.Sign(Request{
		ActivationID:          "act_123",
		Subject:               "UCLAW-BIANCHENG",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IssuedAt:              time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	artifact.Payload.Subject = "UCLAW-TAMPERED"
	err = Verify(artifact, signer.PublicKeyHex())
	if err == nil || !strings.Contains(err.Error(), "license signature is invalid") {
		t.Fatalf("Verify() error = %v, want invalid signature", err)
	}
}

func TestNewEd25519SignerRejectsInvalidSeed(t *testing.T) {
	if _, err := NewEd25519SignerFromSeedHex("test-key", hex.EncodeToString([]byte("short")), time.Hour); err == nil {
		t.Fatal("NewEd25519SignerFromSeedHex() error = nil, want invalid seed")
	}
	if _, err := NewEd25519SignerFromSeedHex("", strings.Repeat("11", 32), time.Hour); err == nil {
		t.Fatal("NewEd25519SignerFromSeedHex() error = nil, want missing key id")
	}
}
