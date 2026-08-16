package license

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"time"
)

const signingDomain = "uclaw-startup-license-v1"
const maxSafeRevision int64 = 9_007_199_254_740_991

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)
	sha256Pattern     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	hexSaltPattern    = regexp.MustCompile(`^(?:[a-f0-9]{2}){16,64}$`)
)

type SigningPayload struct {
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
}

type Signer struct {
	keyID      string
	privateKey ed25519.PrivateKey
}

func NewSigner(keyID string, privateKey ed25519.PrivateKey) (*Signer, error) {
	if !identifierPattern.MatchString(keyID) || len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid license signer")
	}
	derived := ed25519.NewKeyFromSeed(privateKey[:ed25519.SeedSize])
	if subtle.ConstantTimeCompare(derived, privateKey) != 1 {
		return nil, errors.New("invalid license signer")
	}
	selfCheck := []byte("uclaw-license-signer-self-check-v1")
	if !ed25519.Verify(derived.Public().(ed25519.PublicKey), selfCheck, ed25519.Sign(derived, selfCheck)) {
		return nil, errors.New("invalid license signer")
	}
	return &Signer{keyID: keyID, privateKey: derived}, nil
}

func (signer *Signer) PublicKey() ed25519.PublicKey {
	return append(ed25519.PublicKey(nil), signer.privateKey.Public().(ed25519.PublicKey)...)
}

func (signer *Signer) Sign(payload SigningPayload) (string, error) {
	if payload.KeyID != signer.keyID {
		return "", errors.New("license key ID mismatch")
	}
	canonical, err := CanonicalPayload(payload)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(ed25519.Sign(signer.privateKey, canonical)), nil
}

func Verify(payload SigningPayload, encodedSignature string, publicKeys map[string]ed25519.PublicKey) error {
	canonical, err := CanonicalPayload(payload)
	if err != nil {
		return err
	}
	publicKey, ok := publicKeys[payload.KeyID]
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return errors.New("license key unavailable")
	}
	signature, err := base64.StdEncoding.DecodeString(encodedSignature)
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, canonical, signature) {
		return errors.New("license signature invalid")
	}
	return nil
}

func CanonicalPayload(payload SigningPayload) ([]byte, error) {
	if payload.SchemaVersion != 1 || payload.Revision < 1 || payload.Revision > maxSafeRevision ||
		!identifierPattern.MatchString(payload.KeyID) || !identifierPattern.MatchString(payload.UsernameID) ||
		!identifierPattern.MatchString(payload.DeviceID) || !identifierPattern.MatchString(payload.LicenseID) ||
		payload.USBFingerprintVersion != "uclaw-usb-v1" || !sha256Pattern.MatchString(payload.USBFingerprintSHA256) ||
		!hexSaltPattern.MatchString(payload.StartupSecretSalt) || !sha256Pattern.MatchString(payload.StartupSecretHash) ||
		!canonicalTimestamp(payload.NotBefore) || !canonicalTimestamp(payload.ExpiresAt) {
		return nil, errors.New("license signing payload invalid")
	}
	notBefore, _ := time.Parse(time.RFC3339, payload.NotBefore)
	expiresAt, _ := time.Parse(time.RFC3339, payload.ExpiresAt)
	if !expiresAt.After(notBefore) {
		return nil, errors.New("license signing payload invalid")
	}
	return json.Marshal([]any{
		signingDomain, payload.SchemaVersion, payload.KeyID, payload.UsernameID,
		payload.DeviceID, payload.LicenseID, payload.USBFingerprintVersion, payload.USBFingerprintSHA256,
		payload.StartupSecretSalt, payload.StartupSecretHash, payload.NotBefore, payload.ExpiresAt, payload.Revision,
	})
}

func canonicalTimestamp(value string) bool {
	parsed, err := time.Parse(time.RFC3339, value)
	return err == nil && parsed.UTC().Format(time.RFC3339) == value
}
