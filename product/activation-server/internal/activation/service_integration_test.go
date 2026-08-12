package activation_test

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"u-claw-activation-server/internal/activation"
	"u-claw-activation-server/internal/inventory"
	"u-claw-activation-server/internal/license"
	"u-claw-activation-server/internal/persistence"
	"u-claw-activation-server/internal/security"
)

const (
	testUsername = "UCLAW-00000001"
	testCode     = "0123456789ABCDEFGHJKMNPQRS"
)

var testPepper = []byte("0123456789abcdef0123456789abcdef")

type integrationKMS struct{ key [32]byte }

func (kms integrationKMS) WrapKey(_ context.Context, _ string, plaintext, aad []byte) ([]byte, error) {
	return sealIntegration(kms.key[:], plaintext, aad)
}

func (kms integrationKMS) UnwrapKey(_ context.Context, _ string, wrapped, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(kms.key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(wrapped) < aead.NonceSize() {
		return nil, errors.New("wrapped key invalid")
	}
	return aead.Open(nil, wrapped[:aead.NonceSize()], wrapped[aead.NonceSize():], aad)
}

func sealIntegration(key, plaintext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, plaintext, aad), nil
}

func TestPostgresActivationSameKeyRecoveryAndConflict(t *testing.T) {
	pool := activationTestPool(t)
	seedActivationInventory(t, pool)
	service := integrationService(t, pool, 1)
	input := integrationInput(1, "activation-integration-001")

	first, err := service.Activate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Activate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.Envelope, second.Envelope) || !bytes.Equal(first.Material, second.Material) {
		t.Fatal("same idempotent request did not return identical persisted artifact")
	}
	conflict := input
	conflict.ClientVersion = "1.0.1"
	if _, err := service.Activate(context.Background(), conflict); !errors.Is(err, activation.ErrIdempotencyConflict) {
		t.Fatalf("conflict error = %v", err)
	}
}

func TestPostgresActivationThirtyTwoDevicesOnlyOneBinds(t *testing.T) {
	pool := activationTestPool(t)
	seedActivationInventory(t, pool)
	const workers = 32
	start := make(chan struct{})
	errorsByWorker := make([]error, workers)
	results := make([]activation.ActivateResult, workers)
	services := make([]*activation.Service, workers)
	for index := range workers {
		services[index] = integrationService(t, pool, byte(index+1))
	}
	var group sync.WaitGroup
	group.Add(workers)
	for index := range workers {
		go func() {
			defer group.Done()
			<-start
			results[index], errorsByWorker[index] = services[index].Activate(
				context.Background(),
				integrationInput(index+1, fmt.Sprintf("activation-concurrent-%03d", index)),
			)
		}()
	}
	close(start)
	group.Wait()

	successes, alreadyBound := 0, 0
	for index, err := range errorsByWorker {
		switch {
		case err == nil:
			successes++
			if len(results[index].Envelope) == 0 {
				t.Errorf("worker %d returned empty envelope", index)
			}
		case errors.Is(err, activation.ErrActivationCodeAlreadyBound):
			alreadyBound++
		default:
			t.Errorf("worker %d error = %v", index, err)
		}
	}
	if successes != 1 || alreadyBound != workers-1 {
		t.Fatalf("successes=%d alreadyBound=%d, want 1/%d", successes, alreadyBound, workers-1)
	}
	for table, want := range map[string]int{"devices": 1, "licenses": 1, "activation_attempts": 1} {
		var count int
		if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize()).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != want {
			t.Fatalf("%s count=%d want=%d", table, count, want)
		}
	}
	var status, stage string
	if err := pool.QueryRow(context.Background(), `SELECT inventory.status,attempt.stage FROM activation_inventory inventory
		JOIN activation_attempts attempt ON attempt.inventory_id=inventory.id`).Scan(&status, &stage); err != nil {
		t.Fatal(err)
	}
	if status != "active" || stage != "server_bound" {
		t.Fatalf("status/stage=%s/%s", status, stage)
	}
	var licenseStatus string
	var statusEvents, requestedAudits, boundAudits int
	if err := pool.QueryRow(context.Background(), `SELECT status FROM licenses`).Scan(&licenseStatus); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM license_status_events WHERE status='active'`).Scan(&statusEvents); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action='activation.requested'`).Scan(&requestedAudits); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action='activation.bound'`).Scan(&boundAudits); err != nil {
		t.Fatal(err)
	}
	if licenseStatus != "active" || statusEvents != 1 || requestedAudits != 1 || boundAudits != 1 {
		t.Fatalf("license/audit state=%s events=%d requested=%d bound=%d", licenseStatus, statusEvents, requestedAudits, boundAudits)
	}
}

func activationTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ACTIVATION_TEST_DATABASE_URL is not set; PostgreSQL integration test skipped")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := "activation_service_test_" + hex.EncodeToString(random)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.MaxConns = 40
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := persistence.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func seedActivationInventory(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	digest, err := inventory.ActivationCodeDigest(testPepper, testCode)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(context.Background(), `INSERT INTO activation_inventory
		(id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at)
		VALUES ('00000000-0000-4000-8000-000000000010',$1,$1,$2,'prepared','configured',now());
		INSERT INTO new_api_bindings
		(inventory_id,new_api_user_id,new_api_username,balance_setup_status,status,policy_digest,created_at,updated_at)
		VALUES ('00000000-0000-4000-8000-000000000010','new-api-user-001','new-api-name-001','configured','active',$3,now(),now())`,
		testUsername, digest, bytes.Repeat([]byte{0x55}, 32))
	if err != nil {
		t.Fatal(err)
	}
}

func integrationService(t *testing.T, pool *pgxpool.Pool, randomByte byte) *activation.Service {
	t.Helper()
	repository, err := persistence.NewActivationRepository(pool)
	if err != nil {
		t.Fatal(err)
	}
	seed := sha256.Sum256([]byte("activation-integration-signing-key"))
	signer, err := license.NewSigner("test-license-key", ed25519.NewKeyFromSeed(seed[:]))
	if err != nil {
		t.Fatal(err)
	}
	master := sha256.Sum256([]byte("activation-integration-kms-key"))
	envelope := security.NewEnvelopeService(integrationKMS{key: master}, nil)
	service, err := activation.NewService(activation.ServiceOptions{
		Repository: repository, Signer: signer, Envelope: envelope, Pepper: testPepper,
		KeyID: "test-license-key", KeyVersion: "kms-v1", LeaseTTL: time.Minute, LicenseTTL: 365 * 24 * time.Hour,
		Now:    func() time.Time { return time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC) },
		Random: bytes.NewReader(bytes.Repeat([]byte{randomByte}, 4096)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func integrationInput(device int, idempotencyKey string) activation.ActivateInput {
	return activation.ActivateInput{
		Username: testUsername, ActivationCode: testCode, FingerprintVersion: "uclaw-usb-v1",
		FingerprintSHA256: fmt.Sprintf("%064x", device), ClientVersion: "1.0.0",
		IdempotencyKey: idempotencyKey, RequestID: fmt.Sprintf("req_integration_%03d", device),
	}
}
