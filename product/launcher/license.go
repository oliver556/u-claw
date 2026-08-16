package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Populated at release build time with license verification public keys only.
var trustedStartupLicenseKeys = "{}"

const (
	startupCredentialFilename = ".startup-credential.json"
	licenseFilename           = "license.json"
	maxLicenseFileBytes       = 64 << 10
)

var (
	ErrStartupCredentialMissing      = errors.New("startup credential missing")
	ErrStartupSecretMissing          = errors.New("startup secret missing")
	ErrStartupSecretInvalid          = errors.New("startup secret invalid")
	ErrLicenseFileMissing            = errors.New("license file missing")
	ErrLicenseFileUnsafe             = errors.New("license file unsafe")
	ErrLicenseFormatInvalid          = errors.New("license format invalid")
	ErrLicenseTrustUnavailable       = errors.New("license trust unavailable")
	ErrLicenseSignatureInvalid       = errors.New("license signature invalid")
	ErrLicenseDeviceMismatch         = errors.New("license device mismatch")
	ErrLicenseIDMismatch             = errors.New("license id mismatch")
	ErrLicenseFingerprintMismatch    = errors.New("license usb fingerprint mismatch")
	ErrLicenseUSBIdentityUnavailable = errors.New("license usb identity unavailable")
	ErrLicenseNotYetValid            = errors.New("license not yet valid")
	ErrLicenseExpired                = errors.New("license expired")

	licenseIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)
	lowerSHA256Pattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type startupCredential struct {
	SchemaVersion int    `json:"schemaVersion"`
	DeviceID      string `json:"deviceId"`
	LicenseID     string `json:"licenseId"`
	StartupSecret string `json:"startupSecret"`
}

type startupSecretProof struct {
	Algorithm         string `json:"algorithm"`
	StartupSecretSalt string `json:"startupSecretSalt"`
	StartupSecretHash string `json:"startupSecretHash"`
}

type licenseSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type startupLicense struct {
	SchemaVersion      int                `json:"schemaVersion"`
	UsernameID         string             `json:"usernameId"`
	DeviceID           string             `json:"deviceId"`
	LicenseID          string             `json:"licenseId"`
	USBFingerprint     usbFingerprint     `json:"usbFingerprint"`
	StartupSecretProof startupSecretProof `json:"startupSecretProof"`
	NotBefore          string             `json:"notBefore"`
	ExpiresAt          string             `json:"expiresAt"`
	Revision           int64              `json:"revision"`
	Signature          licenseSignature   `json:"signature"`
}

type licenseVerificationOptions struct {
	PackageRoot       string
	USBRoot           string
	Now               func() time.Time
	ReadFingerprint   func(string) (usbFingerprint, error)
	TrustedPublicKeys map[string]ed25519.PublicKey
}

type verifiedLicenseMaterial struct {
	DeviceID       string
	LicenseID      string
	StartupSecret  string
	USBFingerprint string
	ExpiresAt      time.Time
}

func VerifyStartupLicense(options licenseVerificationOptions) error {
	_, err := VerifyStartupLicenseMaterial(options)
	return err
}

func VerifyStartupLicenseMaterial(options licenseVerificationOptions) (verifiedLicenseMaterial, error) {
	fail := func(err error) (verifiedLicenseMaterial, error) { return verifiedLicenseMaterial{}, err }
	if !filepath.IsAbs(options.PackageRoot) || options.Now == nil || options.ReadFingerprint == nil {
		return fail(ErrLicenseFormatInvalid)
	}
	var credential startupCredential
	if err := readStrictLicenseJSON(options.PackageRoot, startupCredentialFilename, ErrStartupCredentialMissing, &credential); err != nil {
		return fail(err)
	}
	if credential.SchemaVersion != 1 {
		return fail(ErrLicenseFormatInvalid)
	}
	if credential.StartupSecret == "" {
		return fail(ErrStartupSecretMissing)
	}
	if !validLicenseIdentifier(credential.DeviceID) || !validLicenseIdentifier(credential.LicenseID) ||
		utf8.RuneCountInString(credential.StartupSecret) < 32 || utf8.RuneCountInString(credential.StartupSecret) > 512 ||
		strings.IndexFunc(credential.StartupSecret, func(value rune) bool { return value < 0x20 || value == 0x7f }) >= 0 {
		return fail(ErrLicenseFormatInvalid)
	}

	var license startupLicense
	if err := readStrictLicenseJSON(options.PackageRoot, licenseFilename, ErrLicenseFileMissing, &license); err != nil {
		return fail(err)
	}
	if err := validateStartupLicense(license); err != nil {
		return fail(err)
	}
	if len(options.TrustedPublicKeys) == 0 {
		return fail(ErrLicenseTrustUnavailable)
	}
	publicKey, ok := options.TrustedPublicKeys[license.Signature.KeyID]
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return fail(ErrLicenseSignatureInvalid)
	}
	signature, err := base64.StdEncoding.DecodeString(license.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return fail(ErrLicenseSignatureInvalid)
	}
	payload, err := licenseSigningPayload(license)
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		return fail(ErrLicenseSignatureInvalid)
	}
	if license.DeviceID != credential.DeviceID {
		return fail(ErrLicenseDeviceMismatch)
	}
	if license.LicenseID != credential.LicenseID {
		return fail(ErrLicenseIDMismatch)
	}
	salt, err := hex.DecodeString(license.StartupSecretProof.StartupSecretSalt)
	if err != nil {
		return fail(ErrLicenseFormatInvalid)
	}
	actualSecretHash := startupSecretDigest(credential.StartupSecret, salt)
	if subtle.ConstantTimeCompare([]byte(actualSecretHash), []byte(license.StartupSecretProof.StartupSecretHash)) != 1 {
		return fail(ErrStartupSecretInvalid)
	}
	now := options.Now().UTC()
	notBefore, _ := time.Parse(time.RFC3339, license.NotBefore)
	expiresAt, _ := time.Parse(time.RFC3339, license.ExpiresAt)
	if now.Before(notBefore) {
		return fail(ErrLicenseNotYetValid)
	}
	if !now.Before(expiresAt) {
		return fail(ErrLicenseExpired)
	}
	fingerprint, err := options.ReadFingerprint(options.USBRoot)
	if err != nil {
		return fail(ErrLicenseUSBIdentityUnavailable)
	}
	if fingerprint.Scheme != license.USBFingerprint.Scheme ||
		subtle.ConstantTimeCompare([]byte(fingerprint.SHA256), []byte(license.USBFingerprint.SHA256)) != 1 {
		return fail(ErrLicenseFingerprintMismatch)
	}
	return verifiedLicenseMaterial{
		DeviceID:       credential.DeviceID,
		LicenseID:      credential.LicenseID,
		StartupSecret:  credential.StartupSecret,
		USBFingerprint: fingerprint.SHA256,
		ExpiresAt:      expiresAt,
	}, nil
}

func readStrictLicenseJSON(packageRoot string, filename string, missing error, output any) error {
	root, err := os.OpenRoot(packageRoot)
	if err != nil {
		return missing
	}
	defer root.Close()
	licenseDirInfo, err := root.Lstat("license")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return missing
		}
		return ErrLicenseFileUnsafe
	}
	if !licenseDirInfo.IsDir() || licenseDirInfo.Mode()&os.ModeSymlink != 0 {
		return ErrLicenseFileUnsafe
	}
	relativePath := filepath.Join("license", filename)
	before, err := root.Lstat(relativePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return missing
		}
		return ErrLicenseFileUnsafe
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() > maxLicenseFileBytes {
		return ErrLicenseFileUnsafe
	}
	file, err := root.Open(relativePath)
	if err != nil {
		return ErrLicenseFileUnsafe
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || !after.Mode().IsRegular() || after.Size() > maxLicenseFileBytes {
		return ErrLicenseFileUnsafe
	}
	links, err := fileLinkCount(file, after)
	if err != nil || links != 1 {
		return ErrLicenseFileUnsafe
	}
	content, err := io.ReadAll(io.LimitReader(file, maxLicenseFileBytes+1))
	if err != nil || len(content) > maxLicenseFileBytes {
		return ErrLicenseFileUnsafe
	}
	if err := rejectDuplicateJSONKeys(content); err != nil {
		return ErrLicenseFormatInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return ErrLicenseFormatInvalid
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return ErrLicenseFormatInvalid
	}
	return nil
}

func rejectDuplicateJSONKeys(content []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var readValue func() error
	readValue = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			keys := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return ErrLicenseFormatInvalid
				}
				if _, duplicate := keys[key]; duplicate {
					return ErrLicenseFormatInvalid
				}
				keys[key] = struct{}{}
				if err := readValue(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return ErrLicenseFormatInvalid
			}
		case '[':
			for decoder.More() {
				if err := readValue(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return ErrLicenseFormatInvalid
			}
		default:
			return ErrLicenseFormatInvalid
		}
		return nil
	}
	if err := readValue(); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrLicenseFormatInvalid
	}
	return nil
}

func validateStartupLicense(license startupLicense) error {
	notBefore, notBeforeErr := time.Parse(time.RFC3339, license.NotBefore)
	expiresAt, expiresAtErr := time.Parse(time.RFC3339, license.ExpiresAt)
	if license.SchemaVersion != 1 || !validLicenseIdentifier(license.UsernameID) || !validLicenseIdentifier(license.DeviceID) || !validLicenseIdentifier(license.LicenseID) ||
		license.USBFingerprint.Scheme != "uclaw-usb-v1" || !lowerSHA256Pattern.MatchString(license.USBFingerprint.SHA256) ||
		license.StartupSecretProof.Algorithm != "sha256-salt-v1" ||
		len(license.StartupSecretProof.StartupSecretSalt) < 32 || len(license.StartupSecretProof.StartupSecretSalt) > 128 || len(license.StartupSecretProof.StartupSecretSalt)%2 != 0 ||
		!isLowerHex(license.StartupSecretProof.StartupSecretSalt) || !lowerSHA256Pattern.MatchString(license.StartupSecretProof.StartupSecretHash) ||
		notBeforeErr != nil || expiresAtErr != nil || !expiresAt.After(notBefore) || license.Revision < 1 || license.Revision > 9_007_199_254_740_991 ||
		license.Signature.Algorithm != "ed25519" || !validLicenseIdentifier(license.Signature.KeyID) || license.Signature.Value == "" {
		return ErrLicenseFormatInvalid
	}
	return nil
}

func licenseSigningPayload(license startupLicense) ([]byte, error) {
	payloadLicense := license
	payloadLicense.Signature.Value = "pending-signature"
	if err := validateStartupLicense(payloadLicense); err != nil {
		return nil, err
	}
	notBefore, _ := time.Parse(time.RFC3339, license.NotBefore)
	expiresAt, _ := time.Parse(time.RFC3339, license.ExpiresAt)
	if notBefore.UTC().Format(time.RFC3339) != license.NotBefore || expiresAt.UTC().Format(time.RFC3339) != license.ExpiresAt {
		return nil, ErrLicenseFormatInvalid
	}
	value := []any{
		"uclaw-startup-license-v1", license.SchemaVersion, license.Signature.KeyID, license.UsernameID, license.DeviceID, license.LicenseID,
		license.USBFingerprint.Scheme, license.USBFingerprint.SHA256,
		license.StartupSecretProof.StartupSecretSalt, license.StartupSecretProof.StartupSecretHash,
		license.NotBefore, license.ExpiresAt, license.Revision,
	}
	return json.Marshal(value)
}

func startupSecretDigest(secret string, salt []byte) string {
	hasher := sha256.New()
	hasher.Write([]byte("uclaw-startup-secret-v1\x00"))
	hasher.Write(salt)
	hasher.Write([]byte{0})
	hasher.Write([]byte(secret))
	return hex.EncodeToString(hasher.Sum(nil))
}

func parseTrustedStartupLicenseKeys(encoded string) (map[string]ed25519.PublicKey, error) {
	var values map[string]string
	if err := json.Unmarshal([]byte(encoded), &values); err != nil || len(values) == 0 {
		return nil, ErrLicenseTrustUnavailable
	}
	keys := make(map[string]ed25519.PublicKey, len(values))
	for keyID, value := range values {
		decoded, err := base64.StdEncoding.DecodeString(value)
		if !validLicenseIdentifier(keyID) || err != nil || len(decoded) != ed25519.PublicKeySize {
			return nil, ErrLicenseTrustUnavailable
		}
		keys[keyID] = ed25519.PublicKey(decoded)
	}
	return keys, nil
}

func validLicenseIdentifier(value string) bool {
	return licenseIdentifierPattern.MatchString(value)
}

func isLowerHex(value string) bool {
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}
