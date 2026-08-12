package persistence

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"u-claw-activation-server/internal/activation"
	adminservice "u-claw-activation-server/internal/admin"
)

func TestInitialMigrationContainsAuthoritativeTablesAndConstraints(t *testing.T) {
	sql := InitialMigrationSQL()
	for _, table := range []string{
		"activation_inventory", "devices", "licenses", "activation_attempts",
		"new_api_bindings", "token_grants", "audit_events", "license_status_events",
	} {
		if !strings.Contains(sql, "CREATE TABLE IF NOT EXISTS "+table) {
			t.Errorf("migration missing table %s", table)
		}
	}
	for _, fragment := range []string{
		"UNIQUE (fingerprint_version, fingerprint_sha256)",
		"UNIQUE (device_id, revision)",
		"UNIQUE (license_id, device_id)",
		"activation_code_digest BYTEA UNIQUE NOT NULL",
		"new_api_username TEXT UNIQUE NOT NULL",
		"inventory_id UUID PRIMARY KEY REFERENCES activation_inventory(id)",
		"balance_setup_status TEXT NOT NULL CHECK (balance_setup_status IN ('pending', 'configured', 'suspended'))",
		"status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked'))",
		"status TEXT NOT NULL CHECK (status IN ('prepared', 'active', 'disabled', 'revoked', 'expired', 'reissued'))",
		"artifact_envelope BYTEA",
		"artifact_key_version TEXT",
		"CHECK (status IN ('prepared', 'binding', 'active', 'revoked'))",
		"CHECK (stage IN ('requested', 'server_bound', 'committed', 'failed_before_bind'))",
		"REFERENCES activation_inventory",
		"REFERENCES devices",
		"REFERENCES licenses",
		"FOREIGN KEY (license_id, device_id) REFERENCES licenses(license_id, device_id)",
		"binding_request_fingerprint IS NULL OR octet_length(binding_request_fingerprint) = 32",
		"octet_length(startup_secret_salt) BETWEEN 16 AND 64",
		"replacement_license_id <> license_id",
		"status = 'reissued' AND replacement_license_id IS NOT NULL",
		"actor_type TEXT NOT NULL CHECK (actor_type IN ('client', 'operator', 'system'))",
		"request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 3 AND 128)",
		"inventory_id UUID REFERENCES activation_inventory(id)",
		"inventory_id UUID UNIQUE NOT NULL REFERENCES activation_inventory(id)",
		"device_id UUID UNIQUE REFERENCES devices(device_id)",
		"binding_lease_token UUID",
		"pending_material_envelope BYTEA",
		"pending_material_key_version TEXT",
		"issued_at TIMESTAMPTZ NOT NULL",
		"status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired'))",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration missing constraint %q", fragment)
		}
	}
	if strings.Contains(sql, "request_id UUID REFERENCES activation_attempts") {
		t.Fatal("audit request ID must not be coupled to an activation attempt")
	}
	for _, forbidden := range []string{"activation_code text", "startup_secret text", "token_secret text"} {
		if strings.Contains(strings.ToLower(sql), forbidden) {
			t.Errorf("migration stores plaintext secret column %q", forbidden)
		}
	}
	if !strings.Contains(migrationLockSQL, "pg_advisory_xact_lock") {
		t.Fatal("migration runner does not use a transaction-scoped advisory lock")
	}
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS schema_migrations",
		"version BIGINT PRIMARY KEY CHECK (version > 0)",
		"checksum BYTEA NOT NULL CHECK (octet_length(checksum) = 32)",
	} {
		if !strings.Contains(migrationLedgerSQL, fragment) {
			t.Errorf("migration ledger missing constraint %q", fragment)
		}
	}
	if latestMigrationVersion != 3 || len(initialMigrationChecksum) != 32 {
		t.Fatal("migration version/checksum metadata is invalid")
	}
}

func TestInitialMigrationReleaseFileMatchesCompiledMigration(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "migrations", "001_initial.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(contents)) != strings.TrimSpace(InitialMigrationSQL()) {
		t.Fatal("migrations/001_initial.sql drifted from compiled migration")
	}
}

func TestLifecycleMigrationContainsTaskFiveAndSixSchema(t *testing.T) {
	sql := LifecycleMigrationSQL()
	for _, fragment := range []string{
		"ADD COLUMN IF NOT EXISTS artifact_generation BIGINT",
		"ADD COLUMN IF NOT EXISTS commit_idempotency_key TEXT",
		"activation_attempts_committed_fields_check",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("lifecycle migration missing %q", fragment)
		}
	}
	if latestMigrationVersion != 3 || len(lifecycleMigrationChecksum) != 32 {
		t.Fatal("lifecycle migration version/checksum metadata is invalid")
	}
}

func TestLifecycleMigrationReleaseFileMatchesCompiledMigration(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "migrations", "002_lifecycle.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(contents)) != strings.TrimSpace(LifecycleMigrationSQL()) {
		t.Fatal("migrations/002_lifecycle.sql drifted from compiled migration")
	}
}

func TestAdminMigrationContainsIdempotencyReasonAndReplacementEntitlement(t *testing.T) {
	sql := AdminMigrationSQL()
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS admin_operations",
		"ADD COLUMN IF NOT EXISTS reason TEXT",
		"ADD COLUMN IF NOT EXISTS replacement_inventory_id UUID",
		"REFERENCES activation_inventory(id)",
		"DROP CONSTRAINT IF EXISTS licenses_check1",
		"status TEXT NOT NULL CHECK (status IN ('pending', 'completed'))",
		"result JSONB",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("admin migration missing %q", fragment)
		}
	}
	contents, err := os.ReadFile(filepath.Join("..", "..", "migrations", "003_admin.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != sql {
		t.Fatal("migrations/003_admin.sql drifted from compiled migration")
	}
}

func TestAdminRepositoryClaimsBeforeMutationAndCompletesResult(t *testing.T) {
	contents, err := os.ReadFile("admin_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	for _, fragment := range []string{"'pending',NULL", "ON CONFLICT (idempotency_key) DO NOTHING", "FOR UPDATE", "SET status='completed',result=$1"} {
		if !strings.Contains(source, fragment) {
			t.Fatalf("admin claim missing %q", fragment)
		}
	}
}

func TestShowInventoryUsernameLookupMatchesActivationNormalization(t *testing.T) {
	for _, username := range []string{"uclaw-generated-001", "UClaw-Import-001", "UCLAW-REISSUE-001-r2"} {
		condition, value := inventoryLookup(adminservice.InventoryLocator{Username: username})
		if condition != "inventory.username_normalized=$1" || value != strings.ToUpper(username) {
			t.Fatalf("username=%q condition=%q value=%q", username, condition, value)
		}
	}
}

func TestMigratePostgreSQLIsIdempotentAndEnforcesUniqueBindings(t *testing.T) {
	databaseURL := os.Getenv("ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ACTIVATION_TEST_DATABASE_URL is not set; PostgreSQL integration test skipped")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()

	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := "activation_test_" + hex.EncodeToString(random)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE") }()

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("second migration: %v", err)
	}

	var tableCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1)`, []string{
		"activation_inventory", "devices", "licenses", "activation_attempts",
		"new_api_bindings", "token_grants", "audit_events", "license_status_events", "schema_migrations", "admin_operations",
	}).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 10 {
		t.Fatalf("table count = %d, want 10", tableCount)
	}
	var migrationCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version IN (1,2,3) AND octet_length(checksum) = 32`).Scan(&migrationCount); err != nil {
		t.Fatal(err)
	}
	if migrationCount != 3 {
		t.Fatalf("migration record count = %d, want 3", migrationCount)
	}

	_, err = pool.Exec(ctx, `INSERT INTO activation_inventory
		(id, username_normalized, username_display, activation_code_digest, status, new_api_setup_status, created_at)
		VALUES ('00000000-0000-0000-0000-000000000001', 'uclaw-1', 'UCLAW-1', decode(repeat('01', 32), 'hex'), 'prepared', 'configured', now())`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO activation_inventory
		(id, username_normalized, username_display, activation_code_digest, status, new_api_setup_status, created_at)
		VALUES ('00000000-0000-0000-0000-000000000002', 'uclaw-1', 'UCLAW-2', decode(repeat('02', 32), 'hex'), 'prepared', 'configured', now())`); !postgresCode(err, "23505") {
		t.Fatalf("duplicate username error = %v, want SQLSTATE 23505", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO activation_inventory
		(id, username_normalized, username_display, activation_code_digest, status, new_api_setup_status, created_at)
		VALUES ('00000000-0000-0000-0000-000000000003', 'uclaw-3', 'UCLAW-3', decode(repeat('01', 32), 'hex'), 'prepared', 'configured', now())`); !postgresCode(err, "23505") {
		t.Fatalf("duplicate activation digest error = %v, want SQLSTATE 23505", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO activation_inventory
		(id, username_normalized, username_display, activation_code_digest, status, new_api_setup_status, created_at)
		VALUES ('00000000-0000-0000-0000-000000000004', 'uclaw-4', 'UCLAW-4', decode(repeat('04', 32), 'hex'), 'prepared', 'configured', now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO devices
		(device_id, inventory_id, fingerprint_version, fingerprint_sha256, status, created_at, updated_at)
		VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'uclaw-usb-v1', decode(repeat('aa', 32), 'hex'), 'active', now(), now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO devices
		(device_id, inventory_id, fingerprint_version, fingerprint_sha256, status, created_at, updated_at)
		VALUES ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000004', 'uclaw-usb-v1', decode(repeat('aa', 32), 'hex'), 'active', now(), now())`); !postgresCode(err, "23505") {
		t.Fatalf("duplicate USB fingerprint error = %v, want SQLSTATE 23505", err)
	}
}

func postgresCode(err error, code string) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == code
}

func TestAdminRepositoryPostgreSQLAtomicLifecycleAndReplay(t *testing.T) {
	databaseURL := os.Getenv("ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ACTIVATION_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	root, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	random := make([]byte, 8)
	_, _ = rand.Read(random)
	schema := "admin_test_" + hex.EncodeToString(random)
	if _, err = root.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = root.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE") }()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	repository, _ := NewActivationRepository(pool)
	op := adminservice.Operation{OperatorID: "operator_fixture", RequestID: "request_fixture_001", IdempotencyKey: "admin-create-001", Reason: "stock creation"}
	record := adminservice.InventoryRecord{InventoryID: "00000000-0000-4000-8000-000000000101", Username: "uclaw-admin-101", UsernameDisplay: "UCLAW-ADMIN-101", ActivationCodeDigest: bytesOf(0x11), NewAPIUserID: "usr_admin_101", NewAPIUsername: "uclaw_admin_101", PolicyDigest: bytesOf(0x21)}
	var wait sync.WaitGroup
	results := make([][]adminservice.InventorySummary, 2)
	failures := make([]error, 2)
	for i := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], failures[index] = repository.CreateInventory(ctx, []adminservice.InventoryRecord{record}, op)
		}(i)
	}
	wait.Wait()
	for i := range failures {
		if failures[i] != nil || len(results[i]) != 1 {
			t.Fatalf("concurrent replay %d result=%v err=%v", i, results[i], failures[i])
		}
	}
	configured, err := repository.MarkConfigured(ctx, adminservice.InventoryLocator{InventoryID: record.InventoryID}, adminservice.Operation{OperatorID: "operator_fixture", RequestID: "request_fixture_002", IdempotencyKey: "admin-configure-001", Reason: "balance ready"})
	if err != nil || configured.NewAPISetupStatus != "configured" {
		t.Fatalf("configured=%#v err=%v", configured, err)
	}
	seedActiveAdminFixture(t, ctx, pool, record.InventoryID, "10000000-0000-4000-8000-000000000101", "20000000-0000-4000-8000-000000000101", "token-admin-101")
	mutation := adminservice.Mutation{Action: adminservice.ActionReissue, LicenseID: "20000000-0000-4000-8000-000000000101", ConfirmTarget: adminservice.TargetDigest("20000000-0000-4000-8000-000000000101"), Operation: adminservice.Operation{OperatorID: "operator_fixture", RequestID: "request_fixture_003", IdempotencyKey: "admin-reissue-001", Reason: "replace damaged media"}, Replacement: &adminservice.InventoryRecord{InventoryID: "00000000-0000-4000-8000-000000000102", Username: "uclaw-admin-101-r2", UsernameDisplay: "UCLAW-ADMIN-101-r2", ActivationCodeDigest: bytesOf(0x12), EntitlementRevision: 2}}
	result, err := repository.Mutate(ctx, mutation)
	if err != nil || result.Status != "reissued" || result.ReplacementInventoryID == nil {
		t.Fatalf("reissue=%#v err=%v", result, err)
	}
	replay, err := repository.Mutate(ctx, mutation)
	if err != nil || replay.Revision != result.Revision {
		t.Fatalf("replay=%#v err=%v", replay, err)
	}
	var licenseStatus, deviceStatus, inventoryStatus, tokenStatus, replacementStatus, bindingStatus string
	var replacementRevision int64
	if err = pool.QueryRow(ctx, `SELECT license.status,device.status,inventory.status,token.status,replacement.status,binding.status,replacement.entitlement_revision FROM licenses license JOIN devices device ON device.device_id=license.device_id JOIN activation_inventory inventory ON inventory.id=device.inventory_id JOIN new_api_bindings binding ON binding.inventory_id=inventory.id JOIN token_grants token ON token.license_id=license.license_id JOIN activation_inventory replacement ON replacement.id=license.replacement_inventory_id WHERE license.license_id=$1`, mutation.LicenseID).Scan(&licenseStatus, &deviceStatus, &inventoryStatus, &tokenStatus, &replacementStatus, &bindingStatus, &replacementRevision); err != nil {
		t.Fatal(err)
	}
	if strings.Join([]string{licenseStatus, deviceStatus, inventoryStatus, tokenStatus, replacementStatus, bindingStatus}, ",") != "reissued,reissued,revoked,revoked,prepared,revoked" || replacementRevision != 2 {
		t.Fatalf("states=%s,%s,%s,%s,%s,%s replacementRevision=%d", licenseStatus, deviceStatus, inventoryStatus, tokenStatus, replacementStatus, bindingStatus, replacementRevision)
	}
	conflict := mutation
	conflict.Operation.Reason = "different reason"
	if _, err = repository.Mutate(ctx, conflict); !errors.Is(err, adminservice.ErrInvalidInput) {
		t.Fatalf("conflict=%v", err)
	}
	var failed int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE outcome='failed' AND action='license.reissue'`).Scan(&failed); err != nil || failed < 1 {
		t.Fatalf("failed audit=%d err=%v", failed, err)
	}
}

func bytesOf(value byte) []byte { return bytes.Repeat([]byte{value}, 32) }
func seedActiveAdminFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, inventoryID, deviceID, licenseID, tokenID string) {
	t.Helper()
	queries := []string{
		`UPDATE activation_inventory SET status='active',activated_at=now() WHERE id='` + inventoryID + `'`,
		`INSERT INTO devices(device_id,inventory_id,fingerprint_version,fingerprint_sha256,status,created_at,updated_at) VALUES('` + deviceID + `','` + inventoryID + `','uclaw-usb-v1',decode(repeat('31',32),'hex'),'active',now(),now())`,
		`UPDATE new_api_bindings SET device_id='` + deviceID + `' WHERE inventory_id='` + inventoryID + `'`,
		`INSERT INTO licenses(license_id,device_id,status,revision,key_id,startup_secret_salt,startup_secret_hash,not_before,expires_at,created_at,updated_at) VALUES('` + licenseID + `','` + deviceID + `','active',1,'key_fixture',decode(repeat('41',16),'hex'),decode(repeat('42',32),'hex'),now()-interval '1 hour',now()+interval '1 year',now(),now())`,
		`INSERT INTO token_grants(jti,device_id,license_id,policy_digest,status,issued_at,expires_at,created_at,idempotency_key) VALUES('` + tokenID + `','` + deviceID + `','` + licenseID + `',decode(repeat('21',32),'hex'),'active',now(),now()+interval '1 hour',now(),'token-idem-` + tokenID + `')`,
	}
	for _, query := range queries {
		if _, err := pool.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
}

func TestValidateCommitReplayUsesIndependentCommitKeyAndGeneration(t *testing.T) {
	key := "commit-fixture-001"
	generation := int64(7)
	if err := validateCommitReplay("server_bound", nil, nil, activation.CommitInput{IdempotencyKey: key, ArtifactGeneration: generation}); err != nil {
		t.Fatalf("first commit rejected: %v", err)
	}
	if err := validateCommitReplay("committed", &key, &generation, activation.CommitInput{IdempotencyKey: key, ArtifactGeneration: generation}); err != nil {
		t.Fatalf("identical replay rejected: %v", err)
	}
	for _, input := range []activation.CommitInput{
		{IdempotencyKey: "commit-fixture-002", ArtifactGeneration: generation},
		{IdempotencyKey: key, ArtifactGeneration: generation + 1},
	} {
		if err := validateCommitReplay("committed", &key, &generation, input); !errors.Is(err, activation.ErrIdempotencyConflict) {
			t.Fatalf("conflicting replay error=%v", err)
		}
	}
}
