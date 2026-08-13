package security

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestSecretEnvelopeBindsPurposeSubjectAndKeyVersion(t *testing.T) {
	master := bytes.Repeat([]byte{7}, 32)
	service := NewSecretEnvelopeService(&testKMS{keys: map[string][]byte{"kms-v1": master}}, bytes.NewReader(bytes.Repeat([]byte{3}, 128)))
	binding := SecretBinding{Purpose: "new-api-key", SubjectID: "00000000-0000-4000-8000-000000000001", KeyVersion: "kms-v1"}
	secret := []byte("runtime-" + strings.Repeat("s", 32))
	envelope, err := service.Encrypt(context.Background(), binding, secret)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := service.Decrypt(context.Background(), binding, envelope)
	if err != nil || !bytes.Equal(plaintext, secret) {
		t.Fatalf("round trip failed: %v", err)
	}
	for _, wrong := range []SecretBinding{
		{Purpose: "other-purpose", SubjectID: binding.SubjectID, KeyVersion: binding.KeyVersion},
		{Purpose: binding.Purpose, SubjectID: "00000000-0000-4000-8000-000000000002", KeyVersion: binding.KeyVersion},
		{Purpose: binding.Purpose, SubjectID: binding.SubjectID, KeyVersion: "kms-v2"},
	} {
		if value, decryptErr := service.Decrypt(context.Background(), wrong, envelope); decryptErr == nil || len(value) != 0 {
			t.Fatalf("wrong binding accepted: %+v", wrong)
		}
	}
}

func TestSecretEnvelopeRejectsTamperingAndStrictDocumentsWithoutLeakingPlaintext(t *testing.T) {
	master := bytes.Repeat([]byte{8}, 32)
	service := NewSecretEnvelopeService(&testKMS{keys: map[string][]byte{"kms-v1": master}}, bytes.NewReader(bytes.Repeat([]byte{4}, 128)))
	binding := SecretBinding{Purpose: "new-api-key", SubjectID: "00000000-0000-4000-8000-000000000001", KeyVersion: "kms-v1"}
	secret := []byte("runtime-" + strings.Repeat("x", 32))
	envelope, err := service.Encrypt(context.Background(), binding, secret)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(envelope, &document); err != nil {
		t.Fatal(err)
	}
	document["ciphertext"] = strings.Repeat("A", len(document["ciphertext"].(string)))
	tampered, _ := json.Marshal(document)
	candidates := [][]byte{tampered, append(envelope, []byte(` {}`)...), []byte(`{"version":1,"keyVersion":"kms-v1","wrappedDek":"AA","nonce":"AA","ciphertext":"AA","extra":true}`), bytes.Repeat([]byte("x"), maxEncodedEnvelopeBytes+1)}
	for _, candidate := range candidates {
		_, decryptErr := service.Decrypt(context.Background(), binding, candidate)
		if decryptErr == nil {
			t.Fatal("invalid envelope accepted")
		}
		if strings.Contains(decryptErr.Error(), string(secret)) {
			t.Fatal("error leaked plaintext")
		}
	}
	if _, err = service.Encrypt(context.Background(), binding, nil); !errors.Is(err, ErrSecretEnvelopeInvalid) {
		t.Fatalf("empty secret error=%v", err)
	}
}

func TestSecretEnvelopeRejectsEveryDuplicateDocumentField(t *testing.T) {
	binding := SecretBinding{Purpose: "new-api-key", SubjectID: "00000000-0000-4000-8000-000000000001", KeyVersion: "kms-v1"}
	service := NewSecretEnvelopeService(&testKMS{keys: map[string][]byte{"kms-v1": bytes.Repeat([]byte{9}, 32)}}, bytes.NewReader(bytes.Repeat([]byte{6}, 128)))
	envelope, err := service.Encrypt(context.Background(), binding, []byte("runtime-"+strings.Repeat("d", 32)))
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"version", "keyVersion", "wrappedDek", "nonce", "ciphertext"} {
		duplicate := bytes.Replace(envelope, []byte(`"`+field+`":`), []byte(`"`+field+`":null,"`+field+`":`), 1)
		if _, decryptErr := service.Decrypt(context.Background(), binding, duplicate); !errors.Is(decryptErr, ErrSecretEnvelopeInvalid) {
			t.Fatalf("duplicate %s error=%v", field, decryptErr)
		}
	}
}
