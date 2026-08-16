package security

import (
	"context"
	"errors"
	"fmt"
)

var ErrKMSPermissionDenied = errors.New("KMS permission denied")

type KMSOperationError struct {
	AuditID string
	Err     error
}

func (err *KMSOperationError) Error() string {
	return fmt.Sprintf("KMS operation failed (audit ID %s): %v", err.AuditID, err.Err)
}

func (err *KMSOperationError) Unwrap() error { return err.Err }

type KeyPurpose string

const (
	KeyPurposeLicense KeyPurpose = "license-signing"
	KeyPurposeToken   KeyPurpose = "token-encryption"
	KeyPurposeRelease KeyPurpose = "release-signing"
)

type KeyRef struct {
	Name    string
	Version string
	Purpose KeyPurpose
}

type SignRequest struct {
	Key     KeyRef
	Message []byte
}

type SignResult struct {
	Signature  []byte
	KeyVersion string
	AuditID    string
}

type EncryptRequest struct {
	Key            KeyRef
	Plaintext      []byte
	AssociatedData []byte
}

type EncryptResult struct {
	Ciphertext []byte
	KeyVersion string
	AuditID    string
}

type DecryptRequest struct {
	Key            KeyRef
	Ciphertext     []byte
	AssociatedData []byte
}

type DecryptResult struct {
	Plaintext  []byte
	KeyVersion string
	AuditID    string
}

type ManagedKMS interface {
	Sign(ctx context.Context, request SignRequest) (SignResult, error)
	Encrypt(ctx context.Context, request EncryptRequest) (EncryptResult, error)
	Decrypt(ctx context.Context, request DecryptRequest) (DecryptResult, error)
}
