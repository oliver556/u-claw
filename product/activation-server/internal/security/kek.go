package security

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
)

const kekDomain = "uclaw-kek-wrap-v1"

type KEK struct {
	aead   cipher.AEAD
	random io.Reader
}

func NewKEK(key []byte, randomSource io.Reader) (*KEK, error) {
	if len(key) != 32 {
		return nil, errors.New("KEK must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("create KEK cipher")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("create KEK AEAD")
	}
	if randomSource == nil {
		randomSource = rand.Reader
	}
	return &KEK{aead: aead, random: randomSource}, nil
}

func (kms *KEK) WrapKey(ctx context.Context, keyVersion string, plaintext, aad []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if kms == nil || kms.aead == nil || !envelopeIdentifierPattern.MatchString(keyVersion) || len(plaintext) == 0 {
		return nil, errors.New("KEK wrap input invalid")
	}
	nonce := make([]byte, kms.aead.NonceSize())
	if _, err := io.ReadFull(kms.random, nonce); err != nil {
		return nil, errors.New("KEK entropy unavailable")
	}
	return kms.aead.Seal(nonce, nonce, plaintext, kekAAD(keyVersion, aad)), nil
}

func (kms *KEK) UnwrapKey(ctx context.Context, keyVersion string, wrapped, aad []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if kms == nil || kms.aead == nil || !envelopeIdentifierPattern.MatchString(keyVersion) || len(wrapped) < kms.aead.NonceSize()+kms.aead.Overhead() {
		return nil, errors.New("KEK unwrap input invalid")
	}
	plaintext, err := kms.aead.Open(nil, wrapped[:kms.aead.NonceSize()], wrapped[kms.aead.NonceSize():], kekAAD(keyVersion, aad))
	if err != nil {
		return nil, errors.New("KEK authentication failed")
	}
	return plaintext, nil
}

func (kms *KEK) Probe(ctx context.Context, keyVersion string) error {
	probe := []byte("01234567890123456789012345678901")
	wrapped, err := kms.WrapKey(ctx, keyVersion, probe, []byte("readiness"))
	if err != nil {
		return err
	}
	unwrapped, err := kms.UnwrapKey(ctx, keyVersion, wrapped, []byte("readiness"))
	if err != nil || string(unwrapped) != string(probe) {
		return errors.New("KEK probe failed")
	}
	return nil
}

func kekAAD(keyVersion string, aad []byte) []byte {
	encoded, _ := json.Marshal([]any{kekDomain, keyVersion, aad})
	return encoded
}
