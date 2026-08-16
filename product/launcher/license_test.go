package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type licenseFixture struct {
	root       string
	credential startupCredential
	license    startupLicense
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	now        time.Time
}

func newLicenseFixture(t *testing.T) licenseFixture {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 10, 4, 0, 0, 0, time.UTC)
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		t.Fatal(err)
	}
	credential := startupCredential{
		SchemaVersion: 1,
		DeviceID:      "dev_fixture_001",
		LicenseID:     "lic_fixture_001",
		StartupSecret: "fixture-runtime-secret-generated-per-test-001",
	}
	license := startupLicense{
		SchemaVersion: 1,
		UsernameID:    "usr_fixture_001",
		DeviceID:      credential.DeviceID,
		LicenseID:     credential.LicenseID,
		USBFingerprint: usbFingerprint{
			Scheme: "uclaw-usb-v1",
			SHA256: strings.Repeat("a", 64),
		},
		StartupSecretProof: startupSecretProof{
			Algorithm:         "sha256-salt-v1",
			StartupSecretSalt: hex.EncodeToString(salt),
			StartupSecretHash: startupSecretDigest(credential.StartupSecret, salt),
		},
		NotBefore: now.Add(-time.Hour).Format(time.RFC3339),
		ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
		Revision:  1,
		Signature: licenseSignature{Algorithm: "ed25519", KeyID: "test-license-key"},
	}
	return licenseFixture{
		root: t.TempDir(), credential: credential, license: license,
		privateKey: privateKey, publicKey: publicKey, now: now,
	}
}

func (fixture *licenseFixture) sign(t *testing.T) {
	t.Helper()
	payload, err := licenseSigningPayload(fixture.license)
	if err != nil {
		t.Fatal(err)
	}
	fixture.license.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, payload))
}

func (fixture *licenseFixture) write(t *testing.T) {
	t.Helper()
	licenseDir := filepath.Join(fixture.root, "license")
	if err := os.MkdirAll(licenseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	credentialJSON, err := json.Marshal(fixture.credential)
	if err != nil {
		t.Fatal(err)
	}
	licenseJSON, err := json.Marshal(fixture.license)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(licenseDir, startupCredentialFilename), credentialJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(licenseDir, licenseFilename), licenseJSON, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (fixture *licenseFixture) verify() error {
	return VerifyStartupLicense(licenseVerificationOptions{
		PackageRoot: fixture.root,
		Now:         func() time.Time { return fixture.now },
		ReadFingerprint: func(string) (usbFingerprint, error) {
			return usbFingerprint{Scheme: "uclaw-usb-v1", SHA256: strings.Repeat("a", 64)}, nil
		},
		USBRoot:           `C:\产品盘`,
		TrustedPublicKeys: map[string]ed25519.PublicKey{"test-license-key": fixture.publicKey},
	})
}

func TestVerifyStartupLicenseAcceptsValidSignedAuthorization(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyStartupLicenseMaterialReturnsOnlyVerifiedLifecycleInputs(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	material, err := VerifyStartupLicenseMaterial(licenseVerificationOptions{
		PackageRoot: fixture.root,
		Now:         func() time.Time { return fixture.now },
		ReadFingerprint: func(string) (usbFingerprint, error) {
			return usbFingerprint{Scheme: "uclaw-usb-v1", SHA256: strings.Repeat("a", 64)}, nil
		},
		USBRoot:           `C:\产品盘`,
		TrustedPublicKeys: map[string]ed25519.PublicKey{"test-license-key": fixture.publicKey},
	})
	if err != nil {
		t.Fatal(err)
	}
	if material.DeviceID != fixture.credential.DeviceID || material.LicenseID != fixture.credential.LicenseID ||
		material.StartupSecret != fixture.credential.StartupSecret || !material.ExpiresAt.Equal(fixture.now.Add(time.Hour)) {
		t.Fatalf("unexpected verified material: %#v", material)
	}
	if material.USBFingerprint != fixture.license.USBFingerprint.SHA256 {
		t.Fatalf("lifecycle binding material missing: %#v", material)
	}
}

func TestVerifyStartupLicenseRejectsUnsupportedCredentialSchema(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		fixture := newLicenseFixture(t)
		fixture.sign(t)
		fixture.write(t)
		path := filepath.Join(fixture.root, "license", startupCredentialFilename)
		encoded, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		withoutSchema := strings.Replace(string(encoded), `"schemaVersion":1,`, "", 1)
		if err := os.WriteFile(path, []byte(withoutSchema), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := fixture.verify(); !errors.Is(err, ErrLicenseFormatInvalid) {
			t.Fatalf("returned %v", err)
		}
	})
	for _, schemaVersion := range []int{0, 2} {
		t.Run(fmt.Sprintf("schema-%d", schemaVersion), func(t *testing.T) {
			fixture := newLicenseFixture(t)
			fixture.credential.SchemaVersion = schemaVersion
			fixture.sign(t)
			fixture.write(t)
			if err := fixture.verify(); !errors.Is(err, ErrLicenseFormatInvalid) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestLicenseSigningPayloadAndSecretProofMatchJavaScriptGoldens(t *testing.T) {
	encoded, err := os.ReadFile(filepath.Join("..", "shared", "tests", "fixtures", "license-signing-golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Payload struct {
			SchemaVersion         int    `json:"schemaVersion"`
			KeyID                 string `json:"keyId"`
			UsernameID            string `json:"usernameId"`
			DeviceID              string `json:"deviceId"`
			LicenseID             string `json:"licenseId"`
			USBFingerprintVersion string `json:"usbFingerprintVersion"`
			USBFingerprintSHA256  string `json:"usbFingerprintSha256"`
			StartupSecretSalt     string `json:"startupSecretSalt"`
			StartupSecretHash     string `json:"startupSecretHash"`
			NotBefore             string `json:"notBefore"`
			ExpiresAt             string `json:"expiresAt"`
			Revision              int64  `json:"revision"`
		} `json:"payload"`
		Canonical string `json:"canonical"`
		PublicKey string `json:"publicKey"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(encoded, &golden); err != nil {
		t.Fatal(err)
	}
	license := startupLicense{
		SchemaVersion: golden.Payload.SchemaVersion, UsernameID: golden.Payload.UsernameID,
		DeviceID: golden.Payload.DeviceID, LicenseID: golden.Payload.LicenseID, Revision: golden.Payload.Revision,
		USBFingerprint: usbFingerprint{Scheme: golden.Payload.USBFingerprintVersion, SHA256: golden.Payload.USBFingerprintSHA256},
		StartupSecretProof: startupSecretProof{
			Algorithm: "sha256-salt-v1", StartupSecretSalt: golden.Payload.StartupSecretSalt, StartupSecretHash: golden.Payload.StartupSecretHash,
		},
		NotBefore: golden.Payload.NotBefore, ExpiresAt: golden.Payload.ExpiresAt,
		Signature: licenseSignature{Algorithm: "ed25519", KeyID: golden.Payload.KeyID, Value: golden.Signature},
	}
	payload, err := licenseSigningPayload(license)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != golden.Canonical {
		t.Fatalf("payload = %s", payload)
	}
	publicKey, err := base64.StdEncoding.DecodeString(golden.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		t.Fatal("golden public key invalid")
	}
	signature := mustDecodeBase64(t, golden.Signature)
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, payload, signature) {
		t.Fatal("golden signature did not verify")
	}
	salt, _ := hex.DecodeString("00112233445566778899aabbccddeeff")
	if got := startupSecretDigest("fixture-runtime-secret-generated-per-test-001", salt); got != "6086aa88c56aee8821f29e6352d097c08b5954b004fed0b721d86ac6ad599998" {
		t.Fatalf("secret digest = %s", got)
	}
}

func TestLicenseSigningPayloadRejectsUnsafeRevision(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.license.Revision = 9_007_199_254_740_992
	if _, err := licenseSigningPayload(fixture.license); !errors.Is(err, ErrLicenseFormatInvalid) {
		t.Fatalf("returned %v", err)
	}
}

func mustDecodeBase64(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestLicenseJSONPreservesFrozenStartupSecretFieldNames(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.sign(t)
	encoded, err := json.Marshal(fixture.license)
	if err != nil {
		t.Fatal(err)
	}
	source := string(encoded)
	for _, field := range []string{`"startupSecretSalt"`, `"startupSecretHash"`} {
		if !strings.Contains(source, field) {
			t.Fatalf("license JSON missing %s: %s", field, source)
		}
	}
	for _, generic := range []string{`"salt"`, `"hash"`} {
		if strings.Contains(source, generic) {
			t.Fatalf("license JSON contains ambiguous field %s: %s", generic, source)
		}
	}
}

func TestVerifyStartupLicenseRejectsIdentityAndProofMismatches(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*licenseFixture)
		want   error
	}{
		{"device", func(f *licenseFixture) { f.license.DeviceID = "dev_other_001" }, ErrLicenseDeviceMismatch},
		{"license", func(f *licenseFixture) { f.license.LicenseID = "lic_other_001" }, ErrLicenseIDMismatch},
		{"fingerprint", func(f *licenseFixture) { f.license.USBFingerprint.SHA256 = strings.Repeat("b", 64) }, ErrLicenseFingerprintMismatch},
		{"secret", func(f *licenseFixture) { f.credential.StartupSecret += "-wrong" }, ErrStartupSecretInvalid},
		{"not-yet-valid", func(f *licenseFixture) { f.license.NotBefore = f.now.Add(time.Minute).Format(time.RFC3339) }, ErrLicenseNotYetValid},
		{"expired", func(f *licenseFixture) { f.license.ExpiresAt = f.now.Add(-time.Minute).Format(time.RFC3339) }, ErrLicenseExpired},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLicenseFixture(t)
			test.mutate(&fixture)
			fixture.sign(t)
			fixture.write(t)
			if err := fixture.verify(); !errors.Is(err, test.want) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestVerifyStartupLicenseRejectsEverySignedFieldTamper(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*startupLicense)
		want   error
	}{
		{"schema-version", func(value *startupLicense) { value.SchemaVersion = 2 }, ErrLicenseFormatInvalid},
		{"device", func(value *startupLicense) { value.DeviceID = "dev_tampered_001" }, ErrLicenseSignatureInvalid},
		{"license", func(value *startupLicense) { value.LicenseID = "lic_tampered_001" }, ErrLicenseSignatureInvalid},
		{"fingerprint-scheme", func(value *startupLicense) { value.USBFingerprint.Scheme = "uclaw-usb-v2" }, ErrLicenseFormatInvalid},
		{"fingerprint", func(value *startupLicense) { value.USBFingerprint.SHA256 = strings.Repeat("c", 64) }, ErrLicenseSignatureInvalid},
		{"proof-algorithm", func(value *startupLicense) { value.StartupSecretProof.Algorithm = "sha512-salt-v1" }, ErrLicenseFormatInvalid},
		{"secret-salt", func(value *startupLicense) { value.StartupSecretProof.StartupSecretSalt = strings.Repeat("e", 32) }, ErrLicenseSignatureInvalid},
		{"secret-hash", func(value *startupLicense) { value.StartupSecretProof.StartupSecretHash = strings.Repeat("d", 64) }, ErrLicenseSignatureInvalid},
		{"not-before", func(value *startupLicense) { value.NotBefore = "2026-08-09T00:00:00Z" }, ErrLicenseSignatureInvalid},
		{"expires", func(value *startupLicense) { value.ExpiresAt = "2027-08-10T00:00:00Z" }, ErrLicenseSignatureInvalid},
		{"signature-algorithm", func(value *startupLicense) { value.Signature.Algorithm = "ed448" }, ErrLicenseFormatInvalid},
		{"key-id", func(value *startupLicense) { value.Signature.KeyID = "other-license-key" }, ErrLicenseSignatureInvalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLicenseFixture(t)
			fixture.sign(t)
			test.mutate(&fixture.license)
			fixture.write(t)
			if err := fixture.verify(); !errors.Is(err, test.want) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestVerifyStartupLicenseRejectsMissingFilesAndSecret(t *testing.T) {
	fixture := newLicenseFixture(t)
	if err := fixture.verify(); !errors.Is(err, ErrStartupCredentialMissing) {
		t.Fatalf("missing credential returned %v", err)
	}
	fixture.sign(t)
	fixture.write(t)
	if err := os.Remove(filepath.Join(fixture.root, "license", licenseFilename)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.verify(); !errors.Is(err, ErrLicenseFileMissing) {
		t.Fatalf("missing license returned %v", err)
	}

	fixture = newLicenseFixture(t)
	fixture.credential.StartupSecret = ""
	fixture.sign(t)
	fixture.write(t)
	if err := fixture.verify(); !errors.Is(err, ErrStartupSecretMissing) {
		t.Fatalf("missing secret returned %v", err)
	}
}

func TestVerifyStartupLicenseFailsClosedWithoutTrustOrHardwareIdentity(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	options := licenseVerificationOptions{
		PackageRoot: fixture.root, USBRoot: `C:\fixture`, Now: func() time.Time { return fixture.now },
		ReadFingerprint: func(string) (usbFingerprint, error) {
			return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
		},
		TrustedPublicKeys: map[string]ed25519.PublicKey{"test-license-key": fixture.publicKey},
	}
	if err := VerifyStartupLicense(options); !errors.Is(err, ErrLicenseUSBIdentityUnavailable) {
		t.Fatalf("hardware failure returned %v", err)
	}
	options.TrustedPublicKeys = nil
	if err := VerifyStartupLicense(options); !errors.Is(err, ErrLicenseTrustUnavailable) {
		t.Fatalf("empty trust returned %v", err)
	}
}

func TestVerifyStartupLicenseRejectsUnknownFieldsAndCorruptSignature(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	licensePath := filepath.Join(fixture.root, "license", licenseFilename)
	encoded, err := os.ReadFile(licensePath)
	if err != nil {
		t.Fatal(err)
	}
	unknown := strings.Replace(string(encoded), `"schemaVersion":1`, `"schemaVersion":1,"unknown":true`, 1)
	if err := os.WriteFile(licensePath, []byte(unknown), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.verify(); !errors.Is(err, ErrLicenseFormatInvalid) {
		t.Fatalf("unknown field returned %v", err)
	}

	fixture = newLicenseFixture(t)
	fixture.sign(t)
	fixture.license.Signature.Value = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	fixture.write(t)
	if err := fixture.verify(); !errors.Is(err, ErrLicenseSignatureInvalid) {
		t.Fatalf("corrupt signature returned %v", err)
	}
}

func TestVerifyStartupLicenseRejectsDuplicateJSONKeys(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	licensePath := filepath.Join(fixture.root, "license", licenseFilename)
	encoded, err := os.ReadFile(licensePath)
	if err != nil {
		t.Fatal(err)
	}
	duplicate := strings.Replace(
		string(encoded),
		`"deviceId":"dev_fixture_001"`,
		`"deviceId":"dev_fixture_001","deviceId":"dev_fixture_001"`,
		1,
	)
	if err := os.WriteFile(licensePath, []byte(duplicate), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.verify(); !errors.Is(err, ErrLicenseFormatInvalid) {
		t.Fatalf("duplicate key returned %v", err)
	}
}

func TestVerifyStartupLicenseSupportsUnicodeAndSpacePackagePaths(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.root = filepath.Join(t.TempDir(), "U 盘 授权")
	if err := os.MkdirAll(fixture.root, 0o700); err != nil {
		t.Fatal(err)
	}
	fixture.sign(t)
	fixture.write(t)
	if err := fixture.verify(); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyStartupLicenseUsesStrictBoundedHandleReads(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	licensePath := filepath.Join(fixture.root, "license", licenseFilename)
	valid, err := os.ReadFile(licensePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(licensePath, append(valid, []byte("{}")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.verify(); !errors.Is(err, ErrLicenseFormatInvalid) {
		t.Fatalf("trailing JSON returned %v", err)
	}

	fixture = newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	licensePath = filepath.Join(fixture.root, "license", licenseFilename)
	linked := filepath.Join(fixture.root, "license", "license-linked.json")
	if err := os.Link(licensePath, linked); err != nil {
		t.Skipf("hardlinks unavailable: %v", err)
	}
	if err := fixture.verify(); !errors.Is(err, ErrLicenseFileUnsafe) {
		t.Fatalf("hardlink returned %v", err)
	}
}

func TestVerifyStartupLicenseRejectsSymlinkAndOversizedCredential(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	credentialPath := filepath.Join(fixture.root, "license", startupCredentialFilename)
	target := filepath.Join(fixture.root, "credential-target.json")
	if err := os.Rename(credentialPath, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, credentialPath); err == nil {
		if err := fixture.verify(); !errors.Is(err, ErrLicenseFileUnsafe) {
			t.Fatalf("symlink returned %v", err)
		}
	}

	fixture = newLicenseFixture(t)
	fixture.sign(t)
	fixture.write(t)
	if err := os.WriteFile(filepath.Join(fixture.root, "license", startupCredentialFilename), make([]byte, maxLicenseFileBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.verify(); !errors.Is(err, ErrLicenseFileUnsafe) {
		t.Fatalf("oversized credential returned %v", err)
	}
}

func TestLicenseErrorsDoNotExposeSecretsOrIdentifiers(t *testing.T) {
	fixture := newLicenseFixture(t)
	fixture.credential.StartupSecret += "-wrong"
	fixture.sign(t)
	fixture.write(t)
	err := fixture.verify()
	serialized := err.Error()
	for _, forbidden := range []string{fixture.credential.StartupSecret, fixture.credential.DeviceID, fixture.credential.LicenseID, fixture.root, fixture.license.USBFingerprint.SHA256} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("error leaked %q: %s", forbidden, serialized)
		}
	}
}

func TestProductionLicenseSourceContainsNoSigningKey(t *testing.T) {
	source, err := os.ReadFile("license.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{strings.Join([]string{"Private", "Key"}, ""), "ed25519.Sign("} {
		if strings.Contains(string(source), forbidden) {
			t.Fatalf("production verifier contains signing primitive %q", forbidden)
		}
	}
}
