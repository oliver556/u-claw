package security

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type testKMS struct {
	keys map[string][]byte
}

var errTestKMS = errors.New("test KMS unavailable")

type failingKMS struct{}

func (failingKMS) WrapKey(context.Context, string, []byte, []byte) ([]byte, error) {
	return nil, errTestKMS
}
func (failingKMS) UnwrapKey(context.Context, string, []byte, []byte) ([]byte, error) {
	return nil, errTestKMS
}

func (kms *testKMS) WrapKey(_ context.Context, keyVersion string, plaintext, aad []byte) ([]byte, error) {
	key, ok := kms.keys[keyVersion]
	if !ok {
		return nil, errors.New("unknown key version")
	}
	return testSeal(key, plaintext, aad)
}

func (kms *testKMS) UnwrapKey(_ context.Context, keyVersion string, wrapped, aad []byte) ([]byte, error) {
	key, ok := kms.keys[keyVersion]
	if !ok {
		return nil, errors.New("unknown key version")
	}
	return testOpen(key, wrapped, aad)
}

func testSeal(key, plaintext, aad []byte) ([]byte, error) {
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, aead.NonceSize())
	return aead.Seal(nonce, nonce, plaintext, aad), nil
}

func testOpen(key, encoded, aad []byte) ([]byte, error) {
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	if len(encoded) < aead.NonceSize() {
		return nil, errors.New("wrapped key invalid")
	}
	return aead.Open(nil, encoded[:aead.NonceSize()], encoded[aead.NonceSize():], aad)
}

func TestEnvelopeEncryptsWithRandomDEKAndBoundAAD(t *testing.T) {
	master := sha256.Sum256([]byte("test-only-envelope-master-key"))
	kms := &testKMS{keys: map[string][]byte{"kms-v1": master[:]}}
	service := NewEnvelopeService(kms, bytes.NewReader(bytes.Repeat([]byte{0x42}, 128)))
	binding := EnvelopeBinding{ActivationID: "act_fixture_001", DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", KeyVersion: "kms-v1"}
	plaintext := []byte(`{"license":"secret-artifact"}`)

	first, err := service.Encrypt(context.Background(), binding, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewEnvelopeService(kms, bytes.NewReader(bytes.Repeat([]byte{0x43}, 128))).Encrypt(context.Background(), binding, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, second) || bytes.Contains(first, plaintext) {
		t.Fatal("envelope is deterministic or contains plaintext")
	}
	decoded, err := service.Decrypt(context.Background(), binding, first)
	if err != nil || !bytes.Equal(decoded, plaintext) {
		t.Fatalf("decrypt = %q, %v", decoded, err)
	}
}

func TestEnvelopeRejectsTamperingWrongKeyVersionAndWrongAAD(t *testing.T) {
	master1 := sha256.Sum256([]byte("test-only-envelope-master-key-v1"))
	master2 := sha256.Sum256([]byte("test-only-envelope-master-key-v2"))
	kms := &testKMS{keys: map[string][]byte{"kms-v1": master1[:], "kms-v2": master2[:]}}
	service := NewEnvelopeService(kms, bytes.NewReader(bytes.Repeat([]byte{0x42}, 128)))
	binding := EnvelopeBinding{ActivationID: "act_fixture_001", DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", KeyVersion: "kms-v1"}
	envelope, err := service.Encrypt(context.Background(), binding, []byte("artifact"))
	if err != nil {
		t.Fatal(err)
	}

	var document map[string]any
	if err := json.Unmarshal(envelope, &document); err != nil {
		t.Fatal(err)
	}
	for name, candidate := range map[string]EnvelopeBinding{
		"wrong key version": {ActivationID: binding.ActivationID, DeviceID: binding.DeviceID, LicenseID: binding.LicenseID, KeyVersion: "kms-v2"},
		"wrong activation":  {ActivationID: "act_other_001", DeviceID: binding.DeviceID, LicenseID: binding.LicenseID, KeyVersion: binding.KeyVersion},
		"wrong device":      {ActivationID: binding.ActivationID, DeviceID: "dev_other_001", LicenseID: binding.LicenseID, KeyVersion: binding.KeyVersion},
		"wrong license":     {ActivationID: binding.ActivationID, DeviceID: binding.DeviceID, LicenseID: "lic_other_001", KeyVersion: binding.KeyVersion},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := service.Decrypt(context.Background(), candidate, envelope); err == nil {
				t.Fatal("wrong binding was accepted")
			}
		})
	}
	for _, field := range []string{"wrappedDek", "nonce", "ciphertext"} {
		t.Run("tampered "+field, func(t *testing.T) {
			copyDocument := make(map[string]any, len(document))
			for key, value := range document {
				copyDocument[key] = value
			}
			decoded, err := base64.RawStdEncoding.DecodeString(copyDocument[field].(string))
			if err != nil {
				t.Fatal(err)
			}
			decoded[len(decoded)-1] ^= 1
			copyDocument[field] = base64.RawStdEncoding.EncodeToString(decoded)
			encoded, _ := json.Marshal(copyDocument)
			if _, err := service.Decrypt(context.Background(), binding, encoded); err == nil {
				t.Fatal("tampered field was accepted")
			}
		})
	}
}

func TestEnvelopeRejectsOversizedInputsInvalidBindingsAndPreservesKMSCause(t *testing.T) {
	binding := EnvelopeBinding{ActivationID: "act_fixture_001", DeviceID: "dev_fixture_001", LicenseID: "lic_fixture_001", KeyVersion: "kms-v1"}
	service := NewEnvelopeService(failingKMS{}, bytes.NewReader(bytes.Repeat([]byte{1}, 64)))
	if _, err := service.Encrypt(context.Background(), binding, make([]byte, (1<<20)+1)); err == nil {
		t.Fatal("oversized plaintext accepted")
	}
	if _, err := service.Decrypt(context.Background(), binding, make([]byte, (2<<20)+1)); err == nil {
		t.Fatal("oversized envelope accepted")
	}
	for _, invalid := range []EnvelopeBinding{
		{ActivationID: "bad/id", DeviceID: binding.DeviceID, LicenseID: binding.LicenseID, KeyVersion: binding.KeyVersion},
		{ActivationID: binding.ActivationID, DeviceID: "x", LicenseID: binding.LicenseID, KeyVersion: binding.KeyVersion},
		{ActivationID: binding.ActivationID, DeviceID: binding.DeviceID, LicenseID: binding.LicenseID, KeyVersion: strings.Repeat("x", 129)},
	} {
		if _, err := service.Encrypt(context.Background(), invalid, []byte("artifact")); err == nil {
			t.Fatal("invalid binding accepted")
		}
	}
	causeService := NewEnvelopeService(failingKMS{}, bytes.NewReader(bytes.Repeat([]byte{3}, 128)))
	if _, err := causeService.Encrypt(context.Background(), binding, []byte("artifact")); !errors.Is(err, errTestKMS) {
		t.Fatalf("KMS cause lost: %v", err)
	}

	master := sha256.Sum256([]byte("test-only-envelope-master-key"))
	validService := NewEnvelopeService(&testKMS{keys: map[string][]byte{"kms-v1": master[:]}}, bytes.NewReader(bytes.Repeat([]byte{2}, 64)))
	envelope, err := validService.Encrypt(context.Background(), binding, []byte("artifact"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewEnvelopeService(failingKMS{}, nil).Decrypt(context.Background(), binding, envelope); !errors.Is(err, errTestKMS) {
		t.Fatalf("KMS cause lost: %v", err)
	}
}
