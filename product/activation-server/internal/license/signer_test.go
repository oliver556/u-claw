package license

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type signingGolden struct {
	Payload   SigningPayload `json:"payload"`
	Canonical string         `json:"canonical"`
	PublicKey string         `json:"publicKey"`
	Signature string         `json:"signature"`
}

func readSigningGolden(t *testing.T) signingGolden {
	t.Helper()
	encoded, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "tests", "fixtures", "license-signing-golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture signingGolden
	if err := json.Unmarshal(encoded, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestLicenseSigningPayloadMatchesGoldenAndVerifies(t *testing.T) {
	fixture := readSigningGolden(t)
	seed := sha256.Sum256([]byte("uclaw-license-signing-golden-test-key-v1"))
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	signer, err := NewSigner("test-license-key", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalPayload(fixture.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(canonical) != fixture.Canonical {
		t.Fatalf("canonical payload = %s", canonical)
	}
	signature, err := signer.Sign(fixture.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if base64.StdEncoding.EncodeToString(signer.PublicKey()) != fixture.PublicKey {
		t.Fatalf("public key = %s", base64.StdEncoding.EncodeToString(signer.PublicKey()))
	}
	if signature != fixture.Signature {
		t.Fatalf("signature = %s", signature)
	}
	if err := Verify(fixture.Payload, fixture.Signature, map[string]ed25519.PublicKey{
		"test-license-key": signer.PublicKey(),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLicenseSigningRejectsWrongKeyTamperingAndNonCanonicalPayload(t *testing.T) {
	fixture := readSigningGolden(t)
	seed := sha256.Sum256([]byte("uclaw-license-signing-golden-test-key-v1"))
	publicKey := ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)

	wrongKey := fixture.Payload
	wrongKey.KeyID = "other-license-key"
	if err := Verify(wrongKey, fixture.Signature, map[string]ed25519.PublicKey{"test-license-key": publicKey}); err == nil {
		t.Fatal("wrong key ID was accepted")
	}
	tampered := fixture.Payload
	tampered.Revision++
	if err := Verify(tampered, fixture.Signature, map[string]ed25519.PublicKey{"test-license-key": publicKey}); err == nil {
		t.Fatal("tampered payload was accepted")
	}
	nonCanonical := fixture.Payload
	nonCanonical.NotBefore = "2026-08-10T00:00:00.000Z"
	if _, err := CanonicalPayload(nonCanonical); err == nil {
		t.Fatal("non-canonical timestamp was accepted")
	}
}

func TestNewSignerRejectsInconsistentPrivateKeyAndRevisionOverflow(t *testing.T) {
	seed := sha256.Sum256([]byte("uclaw-license-signing-golden-test-key-v1"))
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	privateKey[len(privateKey)-1] ^= 1
	if _, err := NewSigner("test-license-key", privateKey); err == nil {
		t.Fatal("inconsistent private key was accepted")
	}
	fixture := readSigningGolden(t)
	fixture.Payload.Revision = 9_007_199_254_740_992
	if _, err := CanonicalPayload(fixture.Payload); err == nil {
		t.Fatal("unsafe revision was accepted")
	}
}

func TestLicenseSignatureBindsEveryCanonicalField(t *testing.T) {
	fixture := readSigningGolden(t)
	seed := sha256.Sum256([]byte("uclaw-license-signing-golden-test-key-v1"))
	publicKey := ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)
	tests := map[string]func(*SigningPayload){
		"schemaVersion":           func(p *SigningPayload) { p.SchemaVersion = 2 },
		"keyId":                   func(p *SigningPayload) { p.KeyID = "other-license-key" },
		"usernameId":              func(p *SigningPayload) { p.UsernameID = "usr_other_001" },
		"deviceId":                func(p *SigningPayload) { p.DeviceID = "dev_other_001" },
		"licenseId":               func(p *SigningPayload) { p.LicenseID = "lic_other_001" },
		"usbFingerprintVersion":   func(p *SigningPayload) { p.USBFingerprintVersion = "uclaw-usb-v2" },
		"usbFingerprintSha256":    func(p *SigningPayload) { p.USBFingerprintSHA256 = "b" + p.USBFingerprintSHA256[1:] },
		"startupSecretSalt":       func(p *SigningPayload) { p.StartupSecretSalt = "1" + p.StartupSecretSalt[1:] },
		"startupSecretHash":       func(p *SigningPayload) { p.StartupSecretHash = "1" + p.StartupSecretHash[1:] },
		"notBefore":               func(p *SigningPayload) { p.NotBefore = "2026-08-09T00:00:00Z" },
		"expiresAt":               func(p *SigningPayload) { p.ExpiresAt = "2027-08-11T00:00:00Z" },
		"revision":                func(p *SigningPayload) { p.Revision++ },
		"domainByCanonicalPrefix": func(p *SigningPayload) { p.KeyID = "domain-substitution" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			payload := fixture.Payload
			mutate(&payload)
			if err := Verify(payload, fixture.Signature, map[string]ed25519.PublicKey{payload.KeyID: publicKey}); err == nil {
				t.Fatal("tampered field was accepted")
			}
		})
	}
}
