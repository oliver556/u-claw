package security

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"
)

type fakeManagedKMS struct {
	keys     map[KeyRef][]byte
	auditSeq int
	blocked  bool
	waitFor  time.Duration
}

func newFakeManagedKMS() *fakeManagedKMS {
	licenseSeed := sha256.Sum256([]byte("fake-license-signing-key-v2"))
	tokenKey := sha256.Sum256([]byte("fake-token-encryption-key-v3"))
	releaseSeed := sha256.Sum256([]byte("fake-release-signing-key-v7"))
	return &fakeManagedKMS{keys: map[KeyRef][]byte{
		{Name: "license-signing", Version: "2", Purpose: KeyPurposeLicense}: ed25519.NewKeyFromSeed(licenseSeed[:]),
		{Name: "token-encryption", Version: "3", Purpose: KeyPurposeToken}:  tokenKey[:],
		{Name: "release-signing", Version: "7", Purpose: KeyPurposeRelease}: ed25519.NewKeyFromSeed(releaseSeed[:]),
	}}
}

func (kms *fakeManagedKMS) Sign(ctx context.Context, request SignRequest) (SignResult, error) {
	if err := kms.beforeOperation(ctx); err != nil {
		return SignResult{}, &KMSOperationError{AuditID: kms.nextAuditID(), Err: err}
	}
	key, ok := kms.keys[request.Key]
	if kms.blocked || !ok || request.Key.Purpose == KeyPurposeToken {
		return SignResult{}, &KMSOperationError{AuditID: kms.nextAuditID(), Err: ErrKMSPermissionDenied}
	}
	return SignResult{Signature: ed25519.Sign(ed25519.PrivateKey(key), request.Message), KeyVersion: request.Key.Version, AuditID: kms.nextAuditID()}, nil
}

func (kms *fakeManagedKMS) Encrypt(ctx context.Context, request EncryptRequest) (EncryptResult, error) {
	if err := kms.beforeOperation(ctx); err != nil {
		return EncryptResult{}, &KMSOperationError{AuditID: kms.nextAuditID(), Err: err}
	}
	key, ok := kms.keys[request.Key]
	if kms.blocked || !ok || request.Key.Purpose != KeyPurposeToken {
		return EncryptResult{}, &KMSOperationError{AuditID: kms.nextAuditID(), Err: ErrKMSPermissionDenied}
	}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, aead.NonceSize())
	return EncryptResult{Ciphertext: aead.Seal(nonce, nonce, request.Plaintext, request.AssociatedData), KeyVersion: request.Key.Version, AuditID: kms.nextAuditID()}, nil
}

func (kms *fakeManagedKMS) Decrypt(ctx context.Context, request DecryptRequest) (DecryptResult, error) {
	if err := kms.beforeOperation(ctx); err != nil {
		return DecryptResult{}, &KMSOperationError{AuditID: kms.nextAuditID(), Err: err}
	}
	key, ok := kms.keys[request.Key]
	if kms.blocked || !ok || request.Key.Purpose != KeyPurposeToken {
		return DecryptResult{}, &KMSOperationError{AuditID: kms.nextAuditID(), Err: ErrKMSPermissionDenied}
	}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	if len(request.Ciphertext) < aead.NonceSize() {
		return DecryptResult{}, errors.New("fake ciphertext invalid")
	}
	plaintext, err := aead.Open(nil, request.Ciphertext[:aead.NonceSize()], request.Ciphertext[aead.NonceSize():], request.AssociatedData)
	if err != nil {
		return DecryptResult{}, err
	}
	return DecryptResult{Plaintext: plaintext, KeyVersion: request.Key.Version, AuditID: kms.nextAuditID()}, nil
}

func (kms *fakeManagedKMS) beforeOperation(ctx context.Context) error {
	if kms.waitFor == 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(kms.waitFor)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (kms *fakeManagedKMS) nextAuditID() string {
	kms.auditSeq++
	return fmt.Sprintf("fake-audit-%04d", kms.auditSeq)
}

func TestManagedKMSContractSignEncryptDecryptAndMetadata(t *testing.T) {
	var kms ManagedKMS = newFakeManagedKMS()
	licenseKey := KeyRef{Name: "license-signing", Version: "2", Purpose: KeyPurposeLicense}
	tokenKey := KeyRef{Name: "token-encryption", Version: "3", Purpose: KeyPurposeToken}

	signed, err := kms.Sign(context.Background(), SignRequest{Key: licenseKey, Message: []byte("license-payload")})
	if err != nil {
		t.Fatal(err)
	}
	privateKey := newFakeManagedKMS().keys[licenseKey]
	if !ed25519.Verify(ed25519.PrivateKey(privateKey).Public().(ed25519.PublicKey), []byte("license-payload"), signed.Signature) {
		t.Fatal("signature did not verify")
	}
	assertKMSMetadata(t, signed.KeyVersion, signed.AuditID, "2")

	encrypted, err := kms.Encrypt(context.Background(), EncryptRequest{Key: tokenKey, Plaintext: []byte("secret-token"), AssociatedData: []byte("tenant-17")})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted.Ciphertext, []byte("secret-token")) {
		t.Fatal("ciphertext contains plaintext")
	}
	assertKMSMetadata(t, encrypted.KeyVersion, encrypted.AuditID, "3")
	decrypted, err := kms.Decrypt(context.Background(), DecryptRequest{Key: tokenKey, Ciphertext: encrypted.Ciphertext, AssociatedData: []byte("tenant-17")})
	if err != nil || string(decrypted.Plaintext) != "secret-token" {
		t.Fatalf("decrypt = %q, %v", decrypted.Plaintext, err)
	}
	assertKMSMetadata(t, decrypted.KeyVersion, decrypted.AuditID, "3")
	if signed.AuditID == encrypted.AuditID || encrypted.AuditID == decrypted.AuditID {
		t.Fatal("audit IDs must identify individual provider operations")
	}
}

func TestManagedKMSContractHonorsTimeoutAndPermissionDenied(t *testing.T) {
	kms := newFakeManagedKMS()
	kms.waitFor = time.Second
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	_, err := kms.Sign(ctx, SignRequest{Key: KeyRef{Name: "license-signing", Version: "2", Purpose: KeyPurposeLicense}, Message: []byte("payload")})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout error = %v", err)
	}
	assertKMSOperationError(t, err)

	kms.waitFor = 0
	kms.blocked = true
	_, err = kms.Encrypt(context.Background(), EncryptRequest{Key: KeyRef{Name: "token-encryption", Version: "3", Purpose: KeyPurposeToken}, Plaintext: []byte("token")})
	if !errors.Is(err, ErrKMSPermissionDenied) {
		t.Fatalf("permission error = %v", err)
	}
	assertKMSOperationError(t, err)
}

func assertKMSOperationError(t *testing.T, err error) {
	t.Helper()
	var operationError *KMSOperationError
	if !errors.As(err, &operationError) || operationError.AuditID == "" {
		t.Fatalf("KMS error has no audit ID: %v", err)
	}
}

func TestManagedKMSContractSeparatesLicenseTokenAndReleaseKeys(t *testing.T) {
	kms := newFakeManagedKMS()
	licenseKey := KeyRef{Name: "license-signing", Version: "2", Purpose: KeyPurposeLicense}
	tokenKey := KeyRef{Name: "token-encryption", Version: "3", Purpose: KeyPurposeToken}
	releaseKey := KeyRef{Name: "release-signing", Version: "7", Purpose: KeyPurposeRelease}

	if _, err := kms.Sign(context.Background(), SignRequest{Key: tokenKey, Message: []byte("payload")}); !errors.Is(err, ErrKMSPermissionDenied) {
		t.Fatalf("token key signed payload: %v", err)
	}
	if _, err := kms.Encrypt(context.Background(), EncryptRequest{Key: licenseKey, Plaintext: []byte("payload")}); !errors.Is(err, ErrKMSPermissionDenied) {
		t.Fatalf("license key encrypted payload: %v", err)
	}
	if _, err := kms.Encrypt(context.Background(), EncryptRequest{Key: releaseKey, Plaintext: []byte("payload")}); !errors.Is(err, ErrKMSPermissionDenied) {
		t.Fatalf("release key encrypted payload: %v", err)
	}
	if _, err := kms.Sign(context.Background(), SignRequest{Key: releaseKey, Message: []byte("release-manifest")}); err != nil {
		t.Fatal(err)
	}
}

func assertKMSMetadata(t *testing.T, version, auditID, wantVersion string) {
	t.Helper()
	if version != wantVersion || auditID == "" {
		t.Fatalf("metadata = version %q audit %q", version, auditID)
	}
}
