package persistence

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"u-claw-activation-server/internal/activation"
	adminservice "u-claw-activation-server/internal/admin"
	"u-claw-activation-server/internal/policy"
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
	if latestMigrationVersion != 6 || len(initialMigrationChecksum) != 32 {
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

func TestRuntimeMigrationVerificationIsReadOnly(t *testing.T) {
	contents, err := os.ReadFile("migrations.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	start := strings.Index(source, "func VerifyMigrations(")
	if start < 0 {
		t.Fatal("VerifyMigrations is missing")
	}
	body := source[start:]
	if end := strings.Index(body, "\nfunc "); end >= 0 {
		body = body[:end]
	}
	for _, forbidden := range []string{"CREATE ", "ALTER ", "INSERT ", "UPDATE ", "DELETE ", "Exec("} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("runtime migration verification contains DDL/DML %q", forbidden)
		}
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
	if latestMigrationVersion != 6 || len(lifecycleMigrationChecksum) != 32 {
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

func TestDeviceAccessProxyMigrationContainsLongLivedTokenAndProxySchema(t *testing.T) {
	sql := DeviceAccessProxyMigrationSQL()
	for _, fragment := range []string{
		"CREATE TABLE device_access_tokens",
		"device_token_id UUID PRIMARY KEY",
		"inventory_id UUID NOT NULL REFERENCES activation_inventory(id)",
		"ADD CONSTRAINT devices_device_inventory_unique UNIQUE (device_id, inventory_id)",
		"FOREIGN KEY (device_id, inventory_id) REFERENCES devices(device_id, inventory_id)",
		"token_digest BYTEA UNIQUE NOT NULL CHECK (octet_length(token_digest) = 32)",
		"status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked'))",
		"CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))",
		"FOREIGN KEY (license_id, device_id) REFERENCES licenses(license_id, device_id)",
		"WHERE status = 'active'",
		"ADD COLUMN api_key_envelope BYTEA",
		"ADD COLUMN api_key_version TEXT",
		"ADD COLUMN base_url TEXT",
		"ADD COLUMN default_model TEXT",
		"ADD COLUMN allowed_models TEXT[] NOT NULL DEFAULT '{}'",
		"CHECK ((api_key_envelope IS NULL) = (api_key_version IS NULL))",
		"CHECK (requests_per_minute BETWEEN 1 AND 6000)",
		"CHECK (concurrent_requests BETWEEN 1 AND 100)",
		"array_position(allowed_models, NULL) IS NULL",
		"array_position(allowed_models, '') IS NULL",
		"COALESCE(default_model = ANY(allowed_models), FALSE)",
		"api_key_envelope IS NULL\n                AND api_key_version IS NULL\n                AND base_url IS NULL\n                AND default_model IS NULL\n                AND cardinality(allowed_models) = 0",
		") NOT VALID",
		"CREATE TABLE model_proxy_admissions",
		"request_id UUID PRIMARY KEY",
		"device_token_id UUID NOT NULL REFERENCES device_access_tokens(device_token_id)",
		"CHECK (lease_expires_at > started_at)",
		"ON model_proxy_admissions(device_token_id, started_at DESC)",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("device access/proxy migration missing %q", fragment)
		}
	}
	for _, forbidden := range []string{"token_plaintext", "token_secret", "api_key TEXT"} {
		if strings.Contains(strings.ToLower(sql), strings.ToLower(forbidden)) {
			t.Errorf("device access/proxy migration stores plaintext secret %q", forbidden)
		}
	}
	if latestMigrationVersion != 6 || len(deviceAccessProxyMigrationChecksum) != 32 {
		t.Fatal("device access/proxy migration version/checksum metadata is invalid")
	}

	contents, err := os.ReadFile(filepath.Join("..", "..", "migrations", "004_device_access_proxy.sql"))
	if err != nil {
		t.Fatalf("read release migration 004: %v", err)
	}
	if string(contents) != sql {
		t.Fatal("migrations/004_device_access_proxy.sql drifted from compiled migration")
	}
}

func TestProductionComposeMountsCurrentMigrationSet(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "deploy", "compose.production.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	compose := string(contents)
	for _, fragment := range []string{
		"source: migrate_script",
		"source: migration_004",
		"target: /migrations/004_device_access_proxy.sql",
		"migration_004:\n    file: ../migrations/004_device_access_proxy.sql",
		"source: migration_005",
		"target: /migrations/005_release_policy.sql",
		"migration_005:\n    file: ../migrations/005_release_policy.sql",
		"source: migration_006",
		"target: /migrations/006_device_aliases.sql",
		"migration_006:\n    file: ../migrations/006_device_aliases.sql",
	} {
		if !strings.Contains(compose, fragment) {
			t.Errorf("production compose missing current migration config %q", fragment)
		}
	}
}

func TestReleasePolicyMigrationContainsMonotonicDualSlotSchema(t *testing.T) {
	sql := ReleasePolicyMigrationSQL()
	for _, fragment := range []string{
		"CREATE TABLE production_releases",
		"release_sequence BIGINT PRIMARY KEY CHECK (release_sequence BETWEEN 1 AND 9007199254740991)",
		"manifest_readback_verified BOOLEAN NOT NULL",
		"cdn_available BOOLEAN NOT NULL",
		"status TEXT NOT NULL CHECK (status IN ('current', 'stable', 'withdrawn'))",
		"CREATE UNIQUE INDEX production_releases_one_current_idx",
		"CREATE TABLE production_release_state",
		"policy_epoch BIGINT NOT NULL CHECK (policy_epoch BETWEEN 1 AND 9007199254740991)",
		"current_sequence BIGINT UNIQUE NOT NULL",
		"previous_stable_sequence BIGINT UNIQUE",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("release policy migration missing %q", fragment)
		}
	}
	if len(releasePolicyMigrationChecksum) != 32 {
		t.Fatal("release policy migration checksum invalid")
	}
	contents, err := os.ReadFile(filepath.Join("..", "..", "migrations", "005_release_policy.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != sql {
		t.Fatal("migrations/005_release_policy.sql drifted from compiled migration")
	}
}

func TestDeviceAliasesMigrationContainsControlledAliasSchema(t *testing.T) {
	sql := DeviceAliasesMigrationSQL()
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS device_aliases",
		"CONSTRAINT device_aliases_inventory_target_pk PRIMARY KEY (inventory_id, target)",
		"CONSTRAINT device_aliases_target_fingerprint_unique UNIQUE (target, fingerprint_version, fingerprint_sha256)",
		"target TEXT NOT NULL CHECK (target IN ('win-x64', 'macos-arm64'))",
		"fingerprint_version TEXT NOT NULL CHECK (fingerprint_version IN ('uclaw-usb-v1', 'uclaw-usb-v2'))",
		"fingerprint_sha256 BYTEA NOT NULL CHECK (octet_length(fingerprint_sha256) = 32)",
		"evidence JSONB NOT NULL CHECK",
		"evidence->>'target' = target",
		"NOT (evidence ?| ARRAY['volumeName', 'mountPath', 'driveLetter'])",
		"FOREIGN KEY (device_id, inventory_id) REFERENCES devices(device_id, inventory_id)",
		"CREATE INDEX IF NOT EXISTS device_aliases_device_id_idx",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("device aliases migration missing %q", fragment)
		}
	}
	if len(deviceAliasesMigrationChecksum) != 32 {
		t.Fatal("device aliases migration checksum invalid")
	}
	contents, err := os.ReadFile(filepath.Join("..", "..", "migrations", "006_device_aliases.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != sql {
		t.Fatal("migrations/006_device_aliases.sql drifted from compiled migration")
	}
}

func TestProductionComposeMountsSecretsOwnerReadOnly(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "deploy", "compose.production.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	compose := string(contents)
	for _, source := range []string{"activation_pepper", "license_signing_key", "status_signing_key", "kms_kek", "admin_operators", "admin_secret_fingerprint_key"} {
		fragment := "source: " + source + ", target: /run/secrets/" + source + ", uid: \"0\", gid: \"0\", mode: 0400"
		if !strings.Contains(compose, fragment) {
			t.Errorf("activation secret mount not owner-read-only: %s", source)
		}
	}
	for _, source := range []string{"migration_database_url", "migration_role", "migration_password", "app_role", "app_password", "tls_certificate", "tls_private_key", "rate_limit_hmac_key", "management_client_ca"} {
		fragment := "source: " + source + ", target: /run/secrets/" + source + ", uid: \"0\", gid: \"0\", mode: 0400"
		if !strings.Contains(compose, fragment) {
			t.Errorf("root service secret mount not owner-read-only: %s", source)
		}
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
		"device_access_tokens", "model_proxy_admissions", "production_releases", "production_release_state", "device_aliases",
	}).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 15 {
		t.Fatalf("table count = %d, want 15", tableCount)
	}
	var migrationCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version IN (1,2,3,4,5,6) AND octet_length(checksum) = 32`).Scan(&migrationCount); err != nil {
		t.Fatal(err)
	}
	if migrationCount != 6 {
		t.Fatalf("migration record count = %d, want 6", migrationCount)
	}
	releaseRepository, err := NewReleasePolicyRepository(pool)
	if err != nil {
		t.Fatal(err)
	}
	release := func(sequence uint64, id, version string) policy.Release {
		return policy.Release{ReleaseSequence: sequence, ReleaseID: id, ContentVersion: version, Reason: policy.ReleaseReasonRelease, ManifestURL: "https://cdn.example.test/releases/" + id + "/manifest.json", ManifestSHA256: strings.Repeat("a", 64), ManifestReadbackVerified: true, CDNAvailable: true, ContentSourceSequence: sequence}
	}
	if _, err = releaseRepository.Publish(ctx, release(105, "release-105", "1.5.0")); err != nil {
		t.Fatal(err)
	}
	state, err := releaseRepository.Publish(ctx, release(106, "release-106", "1.6.0"))
	if err != nil || state.Current.ReleaseSequence != 106 || state.PreviousStable.ReleaseSequence != 105 {
		t.Fatalf("release slots=%+v err=%v", state, err)
	}
	state, err = releaseRepository.ForwardRollback(ctx, release(107, "release-107", "ignored"))
	if err != nil || state.Current.ContentVersion != "1.5.0" || state.Current.RollbackFromSequence != 106 || state.PreviousStable.ReleaseSequence != 105 {
		t.Fatalf("forward rollback=%+v err=%v", state, err)
	}
	var withdrawn string
	if err = pool.QueryRow(ctx, `SELECT status FROM production_releases WHERE release_sequence=106`).Scan(&withdrawn); err != nil || withdrawn != policy.ReleaseStatusWithdrawn {
		t.Fatalf("withdrawn=%q err=%v", withdrawn, err)
	}
	if _, err = releaseRepository.Publish(ctx, release(106, "release-106b", "1.6.1")); !errors.Is(err, policy.ErrSequenceRegression) {
		t.Fatalf("sequence regression=%v", err)
	}
	for _, query := range []string{
		`SELECT device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,revoked_at,created_at,updated_at FROM device_access_tokens LIMIT 0`,
		`SELECT api_key_envelope,api_key_version,base_url,default_model,allowed_models,requests_per_minute,concurrent_requests FROM new_api_bindings LIMIT 0`,
		`SELECT request_id,device_token_id,started_at,lease_expires_at,completed_at FROM model_proxy_admissions LIMIT 0`,
	} {
		rows, err := pool.Query(ctx, query)
		if err != nil {
			t.Fatalf("query migration 4 schema: %v", err)
		}
		rows.Close()
	}
	assertDeviceAccessProxySchema(t, ctx, pool)

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

func assertDeviceAccessProxySchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	const inventoryID = "00000000-0000-0000-0000-000000000041"
	const deviceID = "10000000-0000-0000-0000-000000000041"
	const licenseID = "20000000-0000-0000-0000-000000000041"
	statements := []string{
		`INSERT INTO activation_inventory (id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at) VALUES ('` + inventoryID + `','proxy-41','Proxy 41',decode(repeat('41',32),'hex'),'active','configured',now())`,
		`INSERT INTO activation_inventory (id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at) VALUES ('00000000-0000-0000-0000-000000000042','proxy-42','Proxy 42',decode(repeat('42',32),'hex'),'prepared','pending',now())`,
		`INSERT INTO activation_inventory (id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at) VALUES ('00000000-0000-0000-0000-000000000043','proxy-43','Proxy 43',decode(repeat('47',32),'hex'),'prepared','pending',now())`,
		`INSERT INTO devices (device_id,inventory_id,fingerprint_version,fingerprint_sha256,status,created_at,updated_at) VALUES ('` + deviceID + `','` + inventoryID + `','uclaw-usb-v1',decode(repeat('41',32),'hex'),'active',now(),now())`,
		`INSERT INTO licenses (license_id,device_id,status,revision,key_id,startup_secret_salt,startup_secret_hash,not_before,expires_at,created_at,updated_at) VALUES ('` + licenseID + `','` + deviceID + `','active',1,'proxy-key',decode(repeat('41',16),'hex'),decode(repeat('42',32),'hex'),now(),now()+interval '30 days',now(),now())`,
		`INSERT INTO device_access_tokens (device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at) VALUES ('60000000-0000-0000-0000-000000000041','` + inventoryID + `','` + deviceID + `','` + licenseID + `',decode(repeat('43',32),'hex'),'active',now(),now(),now())`,
		`INSERT INTO model_proxy_admissions (request_id,device_token_id,started_at,lease_expires_at) VALUES ('70000000-0000-0000-0000-000000000041','60000000-0000-0000-0000-000000000041',now(),now()+interval '1 minute')`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("insert device access/proxy fixture: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO new_api_bindings (inventory_id,new_api_user_id,new_api_username,balance_setup_status,status,policy_digest,created_at,updated_at) VALUES ('00000000-0000-0000-0000-000000000042','proxy-user-42','proxy-42','configured','active',decode(repeat('45',32),'hex'),now(),now())`); err != nil {
		t.Fatalf("legacy configured binding without proxy mapping must remain valid: %v", err)
	}
	invalid := []struct {
		name string
		sql  string
	}{
		{"short token digest", `INSERT INTO device_access_tokens (device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at) VALUES ('60000000-0000-0000-0000-000000000042','` + inventoryID + `','` + deviceID + `','` + licenseID + `',decode('01','hex'),'disabled',now(),now(),now())`},
		{"second active token", `INSERT INTO device_access_tokens (device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at) VALUES ('60000000-0000-0000-0000-000000000043','` + inventoryID + `','` + deviceID + `','` + licenseID + `',decode(repeat('44',32),'hex'),'active',now(),now(),now())`},
		{"revoked token without timestamp", `INSERT INTO device_access_tokens (device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at) VALUES ('60000000-0000-0000-0000-000000000044','` + inventoryID + `','` + deviceID + `','` + licenseID + `',decode(repeat('46',32),'hex'),'revoked',now(),now(),now())`},
		{"device from another inventory", `INSERT INTO device_access_tokens (device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at) VALUES ('60000000-0000-0000-0000-000000000045','00000000-0000-0000-0000-000000000043','` + deviceID + `','` + licenseID + `',decode(repeat('48',32),'hex'),'disabled',now(),now(),now())`},
		{"api key envelope without version", `UPDATE new_api_bindings SET api_key_envelope=decode('45','hex') WHERE inventory_id='00000000-0000-0000-0000-000000000042'`},
		{"request rate limit", `UPDATE new_api_bindings SET requests_per_minute=0 WHERE inventory_id='00000000-0000-0000-0000-000000000042'`},
		{"concurrent request limit", `UPDATE new_api_bindings SET concurrent_requests=101 WHERE inventory_id='00000000-0000-0000-0000-000000000042'`},
		{"incomplete configured proxy", `UPDATE new_api_bindings SET api_key_envelope=decode('45','hex'),api_key_version='fixture-kek-v1' WHERE inventory_id='00000000-0000-0000-0000-000000000042'`},
		{"null allowed model", `UPDATE new_api_bindings SET api_key_envelope=decode('45','hex'),api_key_version='fixture-kek-v1',base_url='https://api.invalid/v1',default_model='fixture-model',allowed_models=ARRAY[NULL::text] WHERE inventory_id='00000000-0000-0000-0000-000000000042'`},
		{"empty allowed model", `UPDATE new_api_bindings SET api_key_envelope=decode('45','hex'),api_key_version='fixture-kek-v1',base_url='https://api.invalid/v1',default_model='fixture-model',allowed_models=ARRAY['fixture-model',''] WHERE inventory_id='00000000-0000-0000-0000-000000000042'`},
		{"expired admission lease", `INSERT INTO model_proxy_admissions (request_id,device_token_id,started_at,lease_expires_at) VALUES ('70000000-0000-0000-0000-000000000042','60000000-0000-0000-0000-000000000041',now(),now())`},
	}
	for _, fixture := range invalid {
		if _, err := pool.Exec(ctx, fixture.sql); !postgresCode(err, "23514") && !(fixture.name == "second active token" && postgresCode(err, "23505")) && !(fixture.name == "device from another inventory" && postgresCode(err, "23503")) {
			t.Fatalf("%s error = %v, want constraint violation", fixture.name, err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE new_api_bindings SET api_key_envelope=decode('45','hex'),api_key_version='fixture-kek-v1',base_url='https://api.invalid/v1',default_model='fixture-model',allowed_models=ARRAY['fixture-model'] WHERE inventory_id='00000000-0000-0000-0000-000000000042'`); err != nil {
		t.Fatalf("valid proxy mapping: %v", err)
	}
}

func TestMigratePostgreSQLUpgradesLegacyConfiguredBindingFromVersionThree(t *testing.T) {
	databaseURL := os.Getenv("ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ACTIVATION_TEST_DATABASE_URL is not set; v1-v3 upgrade PostgreSQL test skipped")
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
	schema := "activation_upgrade_" + hex.EncodeToString(random)
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
	if _, err := pool.Exec(ctx, migrationLedgerSQL); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []migration{
		{version: 1, contents: initialMigration, checksum: initialMigrationChecksum},
		{version: 2, contents: lifecycleMigration, checksum: lifecycleMigrationChecksum},
		{version: 3, contents: adminMigration, checksum: adminMigrationChecksum},
	} {
		if _, err := pool.Exec(ctx, candidate.contents); err != nil {
			t.Fatalf("apply legacy migration %d: %v", candidate.version, err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO schema_migrations(version,checksum,applied_at) VALUES($1,$2,now())`, candidate.version, candidate.checksum); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO activation_inventory(id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at) VALUES('00000000-0000-0000-0000-000000000051','legacy-51','Legacy 51',decode(repeat('51',32),'hex'),'prepared','configured',now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO new_api_bindings(inventory_id,new_api_user_id,new_api_username,balance_setup_status,status,policy_digest,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000000051','legacy-user-51','legacy-51','configured','active',decode(repeat('52',32),'hex'),now(),now())`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("upgrade legacy v3 schema: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE new_api_bindings SET updated_at=now() WHERE inventory_id='00000000-0000-0000-0000-000000000051'`); err != nil {
		t.Fatalf("legacy configured binding remains writable: %v", err)
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

func TestDeviceTokenStateMappingIsExplicit(t *testing.T) {
	for action, want := range map[adminservice.DeviceTokenAction]string{adminservice.DeviceTokenDisable: "disabled", adminservice.DeviceTokenEnable: "active", adminservice.DeviceTokenRevoke: "revoked", adminservice.DeviceTokenReissue: "active"} {
		got, ok := deviceTokenTargetStatus(action)
		if !ok || got != want {
			t.Fatalf("action=%s got=%s ok=%v", action, got, ok)
		}
	}
}

func TestBeforeCommitFailureIsRedacted(t *testing.T) {
	sensitive := "/runtime/secret/output/device-token.json"
	for _, callback := range []func() error{func() error { return errors.New(sensitive) }, func() error { panic(sensitive) }} {
		err := invokeBeforeCommit(callback)
		if !errors.Is(err, errAdminPublishFailed) || strings.Contains(err.Error(), sensitive) {
			t.Fatalf("error=%v", err)
		}
	}
}

func TestAdminMappingAndDeviceTokenTransactionsPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ACTIVATION_TEST_DATABASE_URL is not set; admin mapping/device-token PostgreSQL test skipped")
	}
	ctx := context.Background()
	root, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	random := make([]byte, 8)
	_, _ = rand.Read(random)
	schema := "admin_security_test_" + hex.EncodeToString(random)
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
	createInventory := func(suffix string) string {
		id := "00000000-0000-4000-8000-000000000" + suffix
		_, createErr := repository.CreateInventory(ctx, []adminservice.InventoryRecord{{InventoryID: id, Username: "UCLAW-" + suffix, UsernameDisplay: "UCLAW-" + suffix, ActivationCodeDigest: bytesOf(0x61), NewAPIUserID: "usr_" + suffix, NewAPIUsername: "user_" + suffix, PolicyDigest: bytesOf(0x62)}}, adminservice.Operation{OperatorID: "operator_fixture", RequestID: "request-create-" + suffix, IdempotencyKey: "admin-create-" + suffix, Reason: "create fixture"})
		if createErr != nil {
			t.Fatal(createErr)
		}
		return id
	}
	mappingID := createInventory("301")
	mappingOp := adminservice.Operation{OperatorID: "operator_fixture", RequestID: "request-map-301", IdempotencyKey: "admin-map-301", Reason: "configure mapping"}
	mapping := adminservice.MappingInput{InventoryID: mappingID, NewAPIUserID: "usr_map_301", NewAPIUsername: "user_map_301", BaseURL: "https://api.example.test/v1", DefaultModel: "model-a", AllowedModels: []string{"model-a"}, RequestsPerMinute: 60, ConcurrentRequests: 2, APIKeyEnvelope: []byte("opaque-envelope"), APIKeyFingerprint: bytesOf(0x71), KeyVersion: "kms-v1", Operation: mappingOp}
	first, err := repository.SetMapping(ctx, mapping)
	if err != nil || first.Status != "configured" {
		t.Fatalf("mapping=%+v err=%v", first, err)
	}
	if _, err = repository.SetMapping(ctx, mapping); err != nil {
		t.Fatalf("mapping replay=%v", err)
	}
	conflict := mapping
	conflict.APIKeyFingerprint = bytesOf(0x72)
	if _, err = repository.SetMapping(ctx, conflict); !errors.Is(err, adminservice.ErrInvalidInput) {
		t.Fatalf("mapping key conflict=%v", err)
	}
	missing := mapping
	missing.InventoryID = "00000000-0000-4000-8000-000000000399"
	missing.Operation = adminservice.Operation{OperatorID: "operator_fixture", RequestID: "request-map-missing", IdempotencyKey: "admin-map-missing", Reason: "missing target"}
	if _, err = repository.SetMapping(ctx, missing); !errors.Is(err, adminservice.ErrInvalidInput) {
		t.Fatalf("missing mapping=%v", err)
	}
	seedToken := func(suffix, status string) (string, string, string) {
		inventoryID := createInventory(suffix)
		deviceID := "10000000-0000-4000-8000-000000000" + suffix
		licenseID := "20000000-0000-4000-8000-000000000" + suffix
		seedActiveAdminFixture(t, ctx, pool, inventoryID, deviceID, licenseID, "grant-"+suffix)
		if _, seedErr := pool.Exec(ctx, `INSERT INTO device_access_tokens(device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,revoked_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,now(),CASE WHEN $6='revoked' THEN now() ELSE NULL END,now(),now())`, "60000000-0000-4000-8000-000000000"+suffix, inventoryID, deviceID, licenseID, bytesOf(byte(suffix[2])), status); seedErr != nil {
			t.Fatal(seedErr)
		}
		return inventoryID, deviceID, licenseID
	}
	_, _, stateLicense := seedToken("302", "active")
	tokenOp := func(id, reason string) adminservice.Operation {
		return adminservice.Operation{OperatorID: "operator_fixture", RequestID: "request-" + id, IdempotencyKey: "admin-" + id, Reason: reason}
	}
	mutate := func(action adminservice.DeviceTokenAction, id string) (adminservice.DeviceTokenResult, error) {
		return repository.MutateDeviceToken(ctx, adminservice.DeviceTokenMutation{Action: action, LicenseID: stateLicense, Operation: tokenOp(id, "state transition")})
	}
	for _, step := range []struct {
		action   adminservice.DeviceTokenAction
		id, want string
		revoked  bool
	}{{adminservice.DeviceTokenDisable, "disable-302", "disabled", false}, {adminservice.DeviceTokenEnable, "enable-302", "active", false}, {adminservice.DeviceTokenRevoke, "revoke-302", "revoked", true}} {
		result, stepErr := mutate(step.action, step.id)
		if stepErr != nil || result.Status != step.want {
			t.Fatalf("%s result=%+v err=%v", step.action, result, stepErr)
		}
		var status string
		var revokedAt *time.Time
		if stepErr = pool.QueryRow(ctx, `SELECT status,revoked_at FROM device_access_tokens WHERE license_id=$1 ORDER BY issued_at DESC LIMIT 1`, stateLicense).Scan(&status, &revokedAt); stepErr != nil || status != step.want || (revokedAt != nil) != step.revoked {
			t.Fatalf("%s db status=%s revoked=%v err=%v", step.action, status, revokedAt, stepErr)
		}
	}
	_, deviceConflict, conflictLicense := seedToken("303", "disabled")
	if _, err = pool.Exec(ctx, `INSERT INTO device_access_tokens(device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at) SELECT '60000000-0000-4000-8000-000000000393',inventory_id,device_id,license_id,$2,'active',now()+interval '1 second',now(),now() FROM device_access_tokens WHERE license_id=$1 LIMIT 1`, conflictLicense, bytesOf(0x73)); err != nil {
		t.Fatal(err)
	}
	if _, err = repository.MutateDeviceToken(ctx, adminservice.DeviceTokenMutation{Action: adminservice.DeviceTokenEnable, LicenseID: conflictLicense, Operation: tokenOp("enable-conflict", "one active guard")}); !errors.Is(err, adminservice.ErrInvalidInput) {
		t.Fatalf("enable conflict device=%s err=%v", deviceConflict, err)
	}
	_, _, reissueLicense := seedToken("304", "active")
	reissue := adminservice.DeviceTokenMutation{Action: adminservice.DeviceTokenReissue, LicenseID: reissueLicense, ReplacementTokenID: "60000000-0000-4000-8000-000000000394", ReplacementDigest: bytesOf(0x74), Operation: tokenOp("reissue-304", "rotate token")}
	called := 0
	result, err := repository.ReissueDeviceToken(ctx, reissue, func() error { called++; return nil })
	if err != nil || result.Status != "active" || called != 1 {
		t.Fatalf("reissue=%+v called=%d err=%v", result, called, err)
	}
	replay, err := repository.ReissueDeviceToken(ctx, reissue, func() error { called++; return nil })
	if err != nil || !replay.Replayed || called != 1 {
		t.Fatalf("replay=%+v called=%d err=%v", replay, called, err)
	}
	var oldRevoked, newActive int
	if err = pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE status='revoked'),count(*) FILTER(WHERE status='active') FROM device_access_tokens WHERE license_id=$1`, reissueLicense).Scan(&oldRevoked, &newActive); err != nil || oldRevoked != 1 || newActive != 1 {
		t.Fatalf("reissue counts revoked=%d active=%d err=%v", oldRevoked, newActive, err)
	}
	_, _, rollbackLicense := seedToken("305", "active")
	rollback := adminservice.DeviceTokenMutation{Action: adminservice.DeviceTokenReissue, LicenseID: rollbackLicense, ReplacementTokenID: "60000000-0000-4000-8000-000000000395", ReplacementDigest: bytesOf(0x75), Operation: tokenOp("reissue-305", "publish failure")}
	if _, err = repository.ReissueDeviceToken(ctx, rollback, func() error { return errors.New("publish failed") }); err == nil {
		t.Fatal("publish failure accepted")
	}
	var active, replacement int
	if err = pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE status='active'),count(*) FILTER(WHERE device_token_id=$2) FROM device_access_tokens WHERE license_id=$1`, rollbackLicense, rollback.ReplacementTokenID).Scan(&active, &replacement); err != nil || active != 1 || replacement != 0 {
		t.Fatalf("rollback active=%d replacement=%d err=%v", active, replacement, err)
	}
	var publishFailed int
	var auditReason string
	if err = pool.QueryRow(ctx, `SELECT count(*),COALESCE(max(reason),'') FROM audit_events WHERE outcome='failed' AND action='device-token.reissue' AND license_id=$1`, rollbackLicense).Scan(&publishFailed, &auditReason); err != nil || publishFailed != 1 || auditReason != "publish failure" {
		t.Fatalf("publish failed audits=%d reason=%q err=%v", publishFailed, auditReason, err)
	}
	panicRollback := rollback
	panicRollback.ReplacementTokenID = "60000000-0000-4000-8000-000000000396"
	panicRollback.ReplacementDigest = bytesOf(0x76)
	panicRollback.Operation = tokenOp("reissue-306", "publish panic")
	if _, err = repository.ReissueDeviceToken(ctx, panicRollback, func() error { panic("publish panic") }); err == nil {
		t.Fatal("publish panic accepted")
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE status='active'),count(*) FILTER(WHERE device_token_id=$2) FROM device_access_tokens WHERE license_id=$1`, rollbackLicense, panicRollback.ReplacementTokenID).Scan(&active, &replacement); err != nil || active != 1 || replacement != 0 {
		t.Fatalf("panic rollback active=%d replacement=%d err=%v", active, replacement, err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE outcome='failed' AND action='device-token.reissue' AND license_id=$1`, rollbackLicense).Scan(&publishFailed); err != nil || publishFailed != 2 {
		t.Fatalf("publish failed audits after panic=%d err=%v", publishFailed, err)
	}
	for index, status := range []string{"prepared", "revoked"} {
		suffix := fmt.Sprintf("%03d", 306+index)
		_, _, inactiveLicense := seedToken(suffix, "active")
		if _, err = pool.Exec(ctx, `UPDATE activation_inventory SET status=$2,activated_at=CASE WHEN $2='prepared' THEN NULL ELSE activated_at END WHERE id=(SELECT inventory_id FROM device_access_tokens WHERE license_id=$1 LIMIT 1)`, inactiveLicense, status); err != nil {
			t.Fatal(err)
		}
		inactive := adminservice.DeviceTokenMutation{Action: adminservice.DeviceTokenReissue, LicenseID: inactiveLicense, ReplacementTokenID: fmt.Sprintf("60000000-0000-4000-8000-000000000%03d", 397+index), ReplacementDigest: bytesOf(byte(0x77 + index)), Operation: tokenOp("reissue-inactive-"+suffix, "inactive inventory")}
		published := false
		if _, err = repository.ReissueDeviceToken(ctx, inactive, func() error { published = true; return nil }); !errors.Is(err, adminservice.ErrInvalidInput) || published {
			t.Fatalf("inventory %s error=%v published=%v", status, err, published)
		}
		if _, err = repository.PrepareDeviceTokenTarget(ctx, inactiveLicense); !errors.Is(err, adminservice.ErrInvalidInput) {
			t.Fatalf("prepare inventory %s=%v", status, err)
		}
		if err = pool.QueryRow(ctx, `SELECT count(*) FROM device_access_tokens WHERE license_id=$1 AND status='active'`, inactiveLicense).Scan(&active); err != nil || active != 1 {
			t.Fatalf("inventory %s old active=%d err=%v", status, active, err)
		}
	}
	var failed int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE outcome='failed' AND action IN ('new-api.mapping.set','device-token.enable')`).Scan(&failed); err != nil || failed < 3 {
		t.Fatalf("failed audits=%d err=%v", failed, err)
	}
}
func seedActiveAdminFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, inventoryID, deviceID, licenseID, tokenID string) {
	t.Helper()
	queries := []string{
		`UPDATE activation_inventory SET status='active',new_api_setup_status='configured',activated_at=now() WHERE id='` + inventoryID + `'`,
		`INSERT INTO devices(device_id,inventory_id,fingerprint_version,fingerprint_sha256,status,created_at,updated_at) VALUES('` + deviceID + `','` + inventoryID + `','uclaw-usb-v1',decode(repeat('31',32),'hex'),'active',now(),now())`,
		`UPDATE new_api_bindings SET device_id='` + deviceID + `',balance_setup_status='configured' WHERE inventory_id='` + inventoryID + `'`,
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

func TestActivationRecoveryRequirementsMatchPersistedStage(t *testing.T) {
	tests := []struct {
		name            string
		record          activation.BoundRecord
		inventoryStatus string
		deviceStatus    string
		licenseStatus   string
		bindingStatus   string
		allowed         bool
	}{
		{name: "expired requested lease", record: activation.BoundRecord{Stage: "requested"}, inventoryStatus: "binding", deviceStatus: "active", licenseStatus: "prepared", bindingStatus: "active", allowed: true},
		{name: "requested inventory already active", record: activation.BoundRecord{Stage: "requested"}, inventoryStatus: "active", deviceStatus: "active", licenseStatus: "prepared", bindingStatus: "active"},
		{name: "requested license revoked", record: activation.BoundRecord{Stage: "requested"}, inventoryStatus: "binding", deviceStatus: "active", licenseStatus: "revoked", bindingStatus: "active"},
		{name: "requested device disabled", record: activation.BoundRecord{Stage: "requested"}, inventoryStatus: "binding", deviceStatus: "disabled", licenseStatus: "prepared", bindingStatus: "active"},
		{name: "requested binding revoked", record: activation.BoundRecord{Stage: "requested"}, inventoryStatus: "binding", deviceStatus: "active", licenseStatus: "prepared", bindingStatus: "revoked"},
		{name: "server bound active material", record: activation.BoundRecord{Stage: "server_bound", ArtifactEnvelope: []byte("artifact"), ArtifactKeyVersion: "v1"}, inventoryStatus: "active", deviceStatus: "active", licenseStatus: "active", bindingStatus: "active", allowed: true},
		{name: "committed active material", record: activation.BoundRecord{Stage: "committed", ArtifactEnvelope: []byte("artifact"), ArtifactKeyVersion: "v1"}, inventoryStatus: "active", deviceStatus: "active", licenseStatus: "active", bindingStatus: "active", allowed: true},
		{name: "bound material with reissued license", record: activation.BoundRecord{Stage: "committed", ArtifactEnvelope: []byte("artifact"), ArtifactKeyVersion: "v1"}, inventoryStatus: "active", deviceStatus: "active", licenseStatus: "reissued", bindingStatus: "active"},
		{name: "bound material with revoked inventory", record: activation.BoundRecord{Stage: "committed", ArtifactEnvelope: []byte("artifact"), ArtifactKeyVersion: "v1"}, inventoryStatus: "revoked", deviceStatus: "active", licenseStatus: "active", bindingStatus: "active"},
		{name: "terminal failed attempt", record: activation.BoundRecord{Stage: "failed_before_bind"}, inventoryStatus: "binding", deviceStatus: "active", licenseStatus: "prepared", bindingStatus: "active"},
		{name: "requested attempt cannot contain final artifact", record: activation.BoundRecord{Stage: "requested", ArtifactEnvelope: []byte("artifact"), ArtifactKeyVersion: "v1"}, inventoryStatus: "active", deviceStatus: "active", licenseStatus: "active", bindingStatus: "active"},
		{name: "server bound attempt requires final artifact", record: activation.BoundRecord{Stage: "server_bound"}, inventoryStatus: "active", deviceStatus: "active", licenseStatus: "active", bindingStatus: "active"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			allowed := activationRecoveryAllowed(test.record, test.inventoryStatus, test.deviceStatus, test.licenseStatus, test.bindingStatus)
			if allowed != test.allowed {
				t.Fatalf("allowed=%v, want %v", allowed, test.allowed)
			}
		})
	}
}

func TestPostgreSQLTransactionLockOrder(t *testing.T) {
	activationSource, err := os.ReadFile("activation_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	lifecycleSource, err := os.ReadFile("lifecycle_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	assertOrderedFragments(t, string(activationSource), "func (repository *ActivationRepository) BeginBinding", "func ensureActivationRecoverable",
		"loadAttempt(ctx, tx, \"attempt.idempotency_key = $1\", input.IdempotencyKey, false)", "ensureActivationRecoverable(ctx, tx, existing)", "loadAttempt(ctx, tx, \"attempt.idempotency_key = $1\", input.IdempotencyKey, true)")
	assertOrderedFragments(t, string(activationSource), "func (repository *ActivationRepository) CompleteBinding", "func (repository *ActivationRepository) CommitActivation",
		"loadAttempt(ctx, tx, \"attempt.activation_id = $1\", input.Record.ActivationID, false)", "ensureActivationRecoverable(ctx, tx, existing)", "loadAttempt(ctx, tx, \"attempt.activation_id = $1\", input.Record.ActivationID, true)")
	assertOrderedFragments(t, string(activationSource), "func insertBinding", "const attemptSelect",
		"INSERT INTO devices", "INSERT INTO licenses", "UPDATE new_api_bindings", "INSERT INTO activation_attempts")
	if !strings.Contains(string(lifecycleSource), "'activation.recovery_authorized','succeeded'") {
		t.Fatal("AuthorizeRecovery must record authorization, not delivery")
	}
	adminSource, err := os.ReadFile("admin_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	assertOrderedFragments(t, string(adminSource), "func (repository *ActivationRepository) mutateDeviceToken", "func invokeBeforeCommit", "SELECT id FROM activation_inventory WHERE id=$1 FOR UPDATE", "SELECT device_id FROM devices WHERE device_id=$1 AND inventory_id=$2 FOR UPDATE", "SELECT license_id FROM licenses", "SELECT inventory_id FROM new_api_bindings", "SELECT device_token_id,status FROM device_access_tokens")
}

func assertOrderedFragments(t *testing.T, source, start, end string, fragments ...string) {
	t.Helper()
	sectionStart := strings.Index(source, start)
	if sectionStart < 0 {
		t.Fatalf("source section %q..%q not found", start, end)
	}
	sectionEnd := strings.Index(source[sectionStart+len(start):], end)
	if sectionEnd < 0 {
		t.Fatalf("source section %q..%q not found", start, end)
	}
	section := source[sectionStart : sectionStart+len(start)+sectionEnd]
	position := -1
	for _, fragment := range fragments {
		next := strings.Index(section, fragment)
		if next < 0 || next <= position {
			t.Fatalf("%s lock order missing or invalid at %q", start, fragment)
		}
		position = next
	}
}

func TestBeginBindingPostgreSQLRecoversExpiredRequestedLeaseAndGuardsBoundArtifact(t *testing.T) {
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
	schema := "activation_recovery_test_" + hex.EncodeToString(random)
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

	digest := [32]byte{0x11}
	requestFingerprint := [32]byte{0x22}
	startupHash := [32]byte{0x33}
	const inventoryID = "00000000-0000-4000-8000-000000000201"
	if _, err = pool.Exec(ctx, `INSERT INTO activation_inventory
		(id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at)
		VALUES($1,'UCLAW-RECOVERY','UCLAW-RECOVERY',$2,'prepared','configured',now())`, inventoryID, digest[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO new_api_bindings
		(inventory_id,new_api_user_id,new_api_username,balance_setup_status,status,policy_digest,created_at,updated_at)
		VALUES($1,'usr_recovery','uclaw_recovery','configured','active',decode(repeat('44',32),'hex'),now(),now())`, inventoryID); err != nil {
		t.Fatal(err)
	}
	repository, _ := NewActivationRepository(pool)
	now := time.Now().UTC()
	record := activation.BoundRecord{
		ActivationID: "30000000-0000-4000-8000-000000000201", DeviceID: "10000000-0000-4000-8000-000000000201",
		LicenseID: "20000000-0000-4000-8000-000000000201", LeaseToken: "40000000-0000-4000-8000-000000000201",
		RequestFingerprint: requestFingerprint, FingerprintVersion: "uclaw-usb-v1", FingerprintSHA256: strings.Repeat("55", 32),
		KeyID: "key_recovery", NotBefore: now, ExpiresAt: now.Add(24 * time.Hour), Revision: 1,
		StartupSecretSalt: bytes.Repeat([]byte{0x66}, 16), StartupSecretHash: startupHash,
		PendingMaterialEnvelope: []byte("pending-material"), PendingMaterialKeyVersion: "v1",
		RequestID: "request-recovery-001", AuditEventID: "50000000-0000-4000-8000-000000000201",
		StatusEventID: "60000000-0000-4000-8000-000000000201", BoundAuditEventID: "70000000-0000-4000-8000-000000000201",
		LeaseExpiresAt: now.Add(time.Minute),
	}
	input := activation.BeginBindingInput{ActivationCodeDigest: digest, IdempotencyKey: "recovery-idempotency-001", Record: record}
	first, err := repository.BeginBinding(ctx, input)
	if err != nil || first.Disposition != activation.BindingAcquired {
		t.Fatalf("first begin=%#v err=%v", first, err)
	}
	conflict := input
	conflict.Record.RequestFingerprint[0]++
	if _, err = repository.BeginBinding(ctx, conflict); !errors.Is(err, activation.ErrIdempotencyConflict) {
		t.Fatalf("different request recovery error=%v", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE activation_inventory SET binding_lease_expires_at=now()-interval '1 second' WHERE id=$1`, inventoryID); err != nil {
		t.Fatal(err)
	}
	input.Record.LeaseToken = "40000000-0000-4000-8000-000000000202"
	resumed, err := repository.BeginBinding(ctx, input)
	if err != nil || resumed.Disposition != activation.BindingAcquired || resumed.Record.LeaseToken != input.Record.LeaseToken {
		t.Fatalf("resumed begin=%#v err=%v", resumed, err)
	}
	if !bytes.Equal(resumed.Record.PendingMaterialEnvelope, record.PendingMaterialEnvelope) {
		t.Fatalf("pending material changed: %q", resumed.Record.PendingMaterialEnvelope)
	}
	resumed.Record.ArtifactEnvelope = []byte("artifact")
	resumed.Record.ArtifactKeyVersion = "v1"
	completed, err := repository.CompleteBinding(ctx, activation.CompleteBindingInput{LeaseToken: resumed.Record.LeaseToken, Record: resumed.Record})
	if err != nil {
		t.Fatal(err)
	}
	input.Record.RequestID = "request-recovery-current-002"
	bound, err := repository.BeginBinding(ctx, input)
	if err != nil || bound.Disposition != activation.BindingBound || !bytes.Equal(bound.Record.ArtifactEnvelope, completed.ArtifactEnvelope) {
		t.Fatalf("bound recovery=%#v err=%v", bound, err)
	}
	if bound.Record.RequestID != record.RequestID || bound.Record.RecoveryRequestID != input.Record.RequestID {
		t.Fatalf("attempt request=%q recovery request=%q", bound.Record.RequestID, bound.Record.RecoveryRequestID)
	}
	var authorizedRequestID string
	if err = pool.QueryRow(ctx, `SELECT request_id FROM audit_events WHERE action='activation.recovery_authorized' ORDER BY created_at DESC LIMIT 1`).Scan(&authorizedRequestID); err != nil {
		t.Fatal(err)
	}
	if authorizedRequestID != input.Record.RequestID {
		t.Fatalf("authorized request=%q want=%q", authorizedRequestID, input.Record.RequestID)
	}
	concurrentCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	start := make(chan struct{})
	errorsByOperation := make(chan error, 2)
	go func() {
		<-start
		_, operationErr := repository.BeginBinding(concurrentCtx, input)
		errorsByOperation <- operationErr
	}()
	go func() {
		<-start
		_, operationErr := repository.Mutate(concurrentCtx, adminservice.Mutation{
			Action: adminservice.ActionRevoke, LicenseID: record.LicenseID, ConfirmTarget: "UCLAW-RECOVERY",
			Operation: adminservice.Operation{OperatorID: "operator-recovery", RequestID: "request-revoke-concurrent", IdempotencyKey: "revoke-concurrent-001", Reason: "concurrency lock order test"},
		})
		errorsByOperation <- operationErr
	}()
	close(start)
	for range 2 {
		select {
		case operationErr := <-errorsByOperation:
			var postgresError *pgconn.PgError
			if errors.As(operationErr, &postgresError) && postgresError.Code == "40P01" {
				t.Fatalf("concurrent recovery/revoke/token deadlocked: %v", operationErr)
			}
		case <-concurrentCtx.Done():
			t.Fatal("concurrent recovery/revoke/token did not complete before timeout")
		}
	}
	if _, err = pool.Exec(ctx, `UPDATE new_api_bindings SET status='revoked' WHERE inventory_id=$1`, inventoryID); err != nil {
		t.Fatal(err)
	}
	if _, err = repository.BeginBinding(ctx, input); !errors.Is(err, activation.ErrActivationCodeAlreadyBound) {
		t.Fatalf("revoked bound recovery error=%v", err)
	}
}

func TestBeginBindingPostgreSQLPersistsDeviceAliasesAndRecoversByAlias(t *testing.T) {
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
	schema := "activation_alias_test_" + hex.EncodeToString(random)
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

	digest := [32]byte{0x91}
	const inventoryID = "00000000-0000-4000-8000-000000000901"
	if _, err = pool.Exec(ctx, `INSERT INTO activation_inventory
		(id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at)
		VALUES($1,'UCLAW-ALIASES','UCLAW-ALIASES',$2,'prepared','configured',now())`, inventoryID, digest[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO new_api_bindings
		(inventory_id,new_api_user_id,new_api_username,balance_setup_status,status,policy_digest,api_key_envelope,api_key_version,base_url,default_model,allowed_models,created_at,updated_at)
		VALUES($1,'usr_aliases','uclaw_aliases','configured','active',decode(repeat('92',32),'hex'),decode('01','hex'),'kms-v1','https://api.invalid/v1','model-a',ARRAY['model-a'],now(),now())`, inventoryID); err != nil {
		t.Fatal(err)
	}

	repository, _ := NewActivationRepository(pool)
	now := time.Now().UTC()
	requestFingerprint := [32]byte{0x93}
	record := activation.BoundRecord{
		ActivationID: "30000000-0000-4000-8000-000000000901", DeviceID: "10000000-0000-4000-8000-000000000901",
		LicenseID: "20000000-0000-4000-8000-000000000901", LeaseToken: "40000000-0000-4000-8000-000000000901",
		RequestFingerprint: requestFingerprint, FingerprintVersion: "uclaw-usb-v1", FingerprintSHA256: strings.Repeat("94", 32),
		DeviceAliases: testDeviceAliases(), KeyID: "key_aliases", NotBefore: now, ExpiresAt: now.Add(24 * time.Hour), Revision: 1,
		StartupSecretSalt: bytes.Repeat([]byte{0x95}, 16), PendingMaterialEnvelope: []byte("pending-material"), PendingMaterialKeyVersion: "v1",
		RequestID: "request-aliases-001", AuditEventID: "50000000-0000-4000-8000-000000000901",
		StatusEventID: "60000000-0000-4000-8000-000000000901", BoundAuditEventID: "70000000-0000-4000-8000-000000000901",
		LeaseExpiresAt: now.Add(time.Minute),
	}
	record.StartupSecretHash = [32]byte{0x96}
	input := activation.BeginBindingInput{ActivationCodeDigest: digest, IdempotencyKey: "aliases-idempotency-001", Record: record}
	if err := repository.ValidateBinding(ctx, activation.ValidateBindingInput{
		ActivationCodeDigest: digest, IdempotencyKey: input.IdempotencyKey, RequestFingerprint: requestFingerprint,
		FingerprintVersion: record.FingerprintVersion, FingerprintSHA256: record.FingerprintSHA256, DeviceAliases: record.DeviceAliases,
	}); err != nil {
		t.Fatal(err)
	}
	first, err := repository.BeginBinding(ctx, input)
	if err != nil || first.Disposition != activation.BindingAcquired {
		t.Fatalf("first begin=%#v err=%v", first, err)
	}
	var aliasCount int
	var evidence string
	if err = pool.QueryRow(ctx, `SELECT count(*),string_agg(evidence::text,' ' ORDER BY target) FROM device_aliases WHERE inventory_id=$1`, inventoryID).Scan(&aliasCount, &evidence); err != nil {
		t.Fatal(err)
	}
	if aliasCount != 2 || strings.Contains(evidence, "volumeName") || strings.Contains(evidence, "mountPath") || strings.Contains(evidence, "driveLetter") {
		t.Fatalf("alias persistence count=%d evidence=%s", aliasCount, evidence)
	}

	first.Record.ArtifactEnvelope = []byte("artifact")
	first.Record.ArtifactKeyVersion = "v1"
	first.Record.DeviceTokenID = "60000000-0000-4000-8000-000000000901"
	first.Record.DeviceTokenDigest = bytes.Repeat([]byte{0x97}, 32)
	completed, err := repository.CompleteBinding(ctx, activation.CompleteBindingInput{LeaseToken: first.Record.LeaseToken, Record: first.Record})
	if err != nil {
		t.Fatal(err)
	}
	if len(completed.DeviceAliases) != 2 || completed.DeviceAliases[0].Target != "macos-arm64" || completed.DeviceAliases[1].Target != "win-x64" {
		t.Fatalf("loaded aliases=%+v", completed.DeviceAliases)
	}

	recoveryFingerprint := [32]byte{0x98}
	recovery := record
	recovery.ActivationID = "30000000-0000-4000-8000-000000000902"
	recovery.DeviceID = "10000000-0000-4000-8000-000000000902"
	recovery.LicenseID = "20000000-0000-4000-8000-000000000902"
	recovery.RequestFingerprint = recoveryFingerprint
	recovery.FingerprintSHA256 = strings.Repeat("99", 32)
	recovery.DeviceAliases = []activation.DeviceAliasInput{testDeviceAliases()[0]}
	recovery.RequestID = "request-aliases-002"
	if err := repository.ValidateBinding(ctx, activation.ValidateBindingInput{
		ActivationCodeDigest: digest, IdempotencyKey: "aliases-idempotency-002", RequestFingerprint: recoveryFingerprint,
		FingerprintVersion: recovery.FingerprintVersion, FingerprintSHA256: recovery.FingerprintSHA256, DeviceAliases: recovery.DeviceAliases,
	}); err != nil {
		t.Fatalf("alias validate=%v", err)
	}
	bound, err := repository.BeginBinding(ctx, activation.BeginBindingInput{ActivationCodeDigest: digest, IdempotencyKey: "aliases-idempotency-002", Record: recovery})
	if err != nil || bound.Disposition != activation.BindingBound || !bytes.Equal(bound.Record.ArtifactEnvelope, completed.ArtifactEnvelope) {
		t.Fatalf("alias recovery=%#v err=%v", bound, err)
	}
	if bound.Record.RecoveryRequestID != recovery.RequestID || len(bound.Record.DeviceAliases) != 2 {
		t.Fatalf("alias recovery record=%+v", bound.Record)
	}
}

func testDeviceAliases() []activation.DeviceAliasInput {
	return []activation.DeviceAliasInput{
		{
			Target: "macos-arm64",
			Fingerprint: activation.DeviceAliasFingerprint{
				Version: "uclaw-usb-v2",
				SHA256:  strings.Repeat("aa", 32),
			},
			Evidence: activation.DeviceAliasEvidence{
				Target: "macos-arm64", Platform: "darwin", Arch: "arm64", Source: "macos-diskutil",
				BusProtocol: "USB", DeviceLocation: "external", Vendor: "ACME", Product: "FLASH DRIVE",
				Revision: "1.00", Serial: "SN123", CapacityBytes: 64_000_000_000,
				VolumeUUID: "4f2b2fc0-3e70-49a0-9dfc-0e012aef0001", MediaUUID: "7A9877AE-2941-4F87-83EF-C9B7DF8DA111",
			},
		},
		{
			Target: "win-x64",
			Fingerprint: activation.DeviceAliasFingerprint{
				Version: "uclaw-usb-v1",
				SHA256:  strings.Repeat("bb", 32),
			},
			Evidence: activation.DeviceAliasEvidence{
				Target: "win-x64", Platform: "win32", Arch: "x64", Source: "windows-storage-descriptor",
				BusType: "USB", Vendor: "ACME", Product: "FLASH DRIVE", Revision: "1.00",
				Serial: "SN123", CapacityBytes: 64_000_000_000, UniqueDescriptorSHA256: strings.Repeat("cc", 32),
			},
		},
	}
}
