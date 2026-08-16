package security

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

const (
	maxEnvelopePlaintextBytes = 1 << 20
	maxEncodedEnvelopeBytes   = 2 << 20
	maxWrappedDEKBytes        = 16 << 10
)

var envelopeIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)

type KMS interface {
	WrapKey(ctx context.Context, keyVersion string, plaintext, aad []byte) ([]byte, error)
	UnwrapKey(ctx context.Context, keyVersion string, wrapped, aad []byte) ([]byte, error)
}

type EnvelopeBinding struct {
	ActivationID string
	DeviceID     string
	LicenseID    string
	KeyVersion   string
}

type envelopeDocument struct {
	Version    int    `json:"version"`
	KeyVersion string `json:"keyVersion"`
	WrappedDEK string `json:"wrappedDek"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type EnvelopeService struct {
	kms    KMS
	random io.Reader
}

func NewEnvelopeService(kms KMS, randomSource io.Reader) *EnvelopeService {
	if randomSource == nil {
		randomSource = rand.Reader
	}
	return &EnvelopeService{kms: kms, random: randomSource}
}

func (service *EnvelopeService) EncryptSecret(ctx context.Context, binding SecretBinding, plaintext []byte) ([]byte, error) {
	return (&SecretEnvelopeService{kms: service.kms, random: service.random}).Encrypt(ctx, binding, plaintext)
}

func (service *EnvelopeService) DecryptSecret(ctx context.Context, binding SecretBinding, encoded []byte) ([]byte, error) {
	return (&SecretEnvelopeService{kms: service.kms, random: service.random}).Decrypt(ctx, binding, encoded)
}

func (service *EnvelopeService) Encrypt(ctx context.Context, binding EnvelopeBinding, plaintext []byte) ([]byte, error) {
	if service == nil || service.kms == nil || !validBinding(binding) || len(plaintext) == 0 || len(plaintext) > maxEnvelopePlaintextBytes {
		return nil, errors.New("envelope input invalid")
	}
	dek := make([]byte, 32)
	defer clear(dek)
	if _, err := io.ReadFull(service.random, dek); err != nil {
		return nil, errors.New("envelope entropy unavailable")
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, errors.New("create envelope cipher")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("create envelope AEAD")
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(service.random, nonce); err != nil {
		return nil, errors.New("envelope entropy unavailable")
	}
	aad := bindingAAD(binding)
	wrapped, err := service.kms.WrapKey(ctx, binding.KeyVersion, dek, aad)
	if err != nil {
		return nil, fmt.Errorf("wrap envelope key: %w", err)
	}
	if len(wrapped) == 0 || len(wrapped) > maxWrappedDEKBytes {
		return nil, errors.New("wrapped envelope key invalid")
	}
	document := envelopeDocument{
		Version: 1, KeyVersion: binding.KeyVersion,
		WrappedDEK: base64.RawStdEncoding.EncodeToString(wrapped),
		Nonce:      base64.RawStdEncoding.EncodeToString(nonce),
		Ciphertext: base64.RawStdEncoding.EncodeToString(aead.Seal(nil, nonce, plaintext, aad)),
	}
	return json.Marshal(document)
}

func (service *EnvelopeService) Decrypt(ctx context.Context, binding EnvelopeBinding, encoded []byte) ([]byte, error) {
	if service == nil || service.kms == nil || !validBinding(binding) || len(encoded) == 0 || len(encoded) > maxEncodedEnvelopeBytes {
		return nil, errors.New("envelope input invalid")
	}
	var document envelopeDocument
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || document.Version != 1 || document.KeyVersion != binding.KeyVersion {
		return nil, errors.New("envelope invalid")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return nil, errors.New("envelope invalid")
	}
	wrapped, err1 := base64.RawStdEncoding.DecodeString(document.WrappedDEK)
	nonce, err2 := base64.RawStdEncoding.DecodeString(document.Nonce)
	ciphertext, err3 := base64.RawStdEncoding.DecodeString(document.Ciphertext)
	if err1 != nil || err2 != nil || err3 != nil || len(wrapped) == 0 || len(wrapped) > maxWrappedDEKBytes || len(nonce) != 12 || len(ciphertext) < 16 || len(ciphertext) > maxEnvelopePlaintextBytes+16 {
		return nil, errors.New("envelope invalid")
	}
	aad := bindingAAD(binding)
	dek, err := service.kms.UnwrapKey(ctx, binding.KeyVersion, wrapped, aad)
	if err != nil {
		return nil, fmt.Errorf("unwrap envelope key: %w", err)
	}
	defer clear(dek)
	if len(dek) != 32 {
		return nil, errors.New("unwrap envelope key")
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, errors.New("create envelope cipher")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(nonce) != aead.NonceSize() {
		return nil, errors.New("envelope invalid")
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errors.New("envelope authentication failed")
	}
	return plaintext, nil
}

func bindingAAD(binding EnvelopeBinding) []byte {
	encoded, _ := json.Marshal([]string{"uclaw-artifact-envelope-v1", binding.ActivationID, binding.DeviceID, binding.LicenseID, binding.KeyVersion})
	return encoded
}

func validBinding(binding EnvelopeBinding) bool {
	return envelopeIdentifierPattern.MatchString(binding.ActivationID) &&
		envelopeIdentifierPattern.MatchString(binding.DeviceID) &&
		envelopeIdentifierPattern.MatchString(binding.LicenseID) &&
		envelopeIdentifierPattern.MatchString(binding.KeyVersion)
}
