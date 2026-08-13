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
	"io"
)

var ErrSecretEnvelopeInvalid = errors.New("secret envelope invalid")

type SecretBinding struct {
	Purpose    string
	SubjectID  string
	KeyVersion string
}

type SecretEnvelopeService struct {
	kms    KMS
	random io.Reader
}

func NewSecretEnvelopeService(kms KMS, randomSource io.Reader) *SecretEnvelopeService {
	if randomSource == nil {
		randomSource = rand.Reader
	}
	return &SecretEnvelopeService{kms: kms, random: randomSource}
}

func (s *SecretEnvelopeService) Encrypt(ctx context.Context, binding SecretBinding, plaintext []byte) ([]byte, error) {
	if s == nil || s.kms == nil || !validSecretBinding(binding) || len(plaintext) == 0 || len(plaintext) > maxEnvelopePlaintextBytes {
		return nil, ErrSecretEnvelopeInvalid
	}
	dek := make([]byte, 32)
	defer clear(dek)
	if _, err := io.ReadFull(s.random, dek); err != nil {
		return nil, errors.New("secret envelope entropy unavailable")
	}
	block, _ := aes.NewCipher(dek)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(s.random, nonce); err != nil {
		return nil, errors.New("secret envelope entropy unavailable")
	}
	aad := secretBindingAAD(binding)
	wrapped, err := s.kms.WrapKey(ctx, binding.KeyVersion, dek, aad)
	if err != nil {
		return nil, errors.New("secret envelope key unavailable")
	}
	if len(wrapped) == 0 || len(wrapped) > maxWrappedDEKBytes {
		return nil, ErrSecretEnvelopeInvalid
	}
	return json.Marshal(envelopeDocument{Version: 1, KeyVersion: binding.KeyVersion, WrappedDEK: base64.RawStdEncoding.EncodeToString(wrapped), Nonce: base64.RawStdEncoding.EncodeToString(nonce), Ciphertext: base64.RawStdEncoding.EncodeToString(aead.Seal(nil, nonce, plaintext, aad))})
}

func (s *SecretEnvelopeService) Decrypt(ctx context.Context, binding SecretBinding, encoded []byte) ([]byte, error) {
	if s == nil || s.kms == nil || !validSecretBinding(binding) || len(encoded) == 0 || len(encoded) > maxEncodedEnvelopeBytes {
		return nil, ErrSecretEnvelopeInvalid
	}
	if !uniqueSecretEnvelopeFields(encoded) {
		return nil, ErrSecretEnvelopeInvalid
	}
	var doc envelopeDocument
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&doc) != nil || decoder.Decode(&struct{}{}) != io.EOF || doc.Version != 1 || doc.KeyVersion != binding.KeyVersion {
		return nil, ErrSecretEnvelopeInvalid
	}
	wrapped, e1 := base64.RawStdEncoding.DecodeString(doc.WrappedDEK)
	nonce, e2 := base64.RawStdEncoding.DecodeString(doc.Nonce)
	ciphertext, e3 := base64.RawStdEncoding.DecodeString(doc.Ciphertext)
	if e1 != nil || e2 != nil || e3 != nil || len(wrapped) == 0 || len(wrapped) > maxWrappedDEKBytes || len(nonce) != 12 || len(ciphertext) < 16 || len(ciphertext) > maxEnvelopePlaintextBytes+16 {
		return nil, ErrSecretEnvelopeInvalid
	}
	aad := secretBindingAAD(binding)
	dek, err := s.kms.UnwrapKey(ctx, binding.KeyVersion, wrapped, aad)
	if err != nil || len(dek) != 32 {
		return nil, ErrSecretEnvelopeInvalid
	}
	defer clear(dek)
	block, _ := aes.NewCipher(dek)
	aead, _ := cipher.NewGCM(block)
	plaintext, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, ErrSecretEnvelopeInvalid
	}
	return plaintext, nil
}

func uniqueSecretEnvelopeFields(encoded []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return false
	}
	seen := map[string]bool{}
	for decoder.More() {
		keyToken, tokenErr := decoder.Token()
		key, ok := keyToken.(string)
		if tokenErr != nil || !ok || seen[key] {
			return false
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return false
		}
	}
	closing, err := decoder.Token()
	return err == nil && closing == json.Delim('}')
}

func validSecretBinding(binding SecretBinding) bool {
	return envelopeIdentifierPattern.MatchString(binding.Purpose) && envelopeIdentifierPattern.MatchString(binding.SubjectID) && envelopeIdentifierPattern.MatchString(binding.KeyVersion)
}
func secretBindingAAD(binding SecretBinding) []byte {
	encoded, _ := json.Marshal([]string{"uclaw-server-secret-envelope-v1", binding.Purpose, binding.SubjectID, binding.KeyVersion})
	return encoded
}
