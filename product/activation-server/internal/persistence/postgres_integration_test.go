package persistence

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
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
	if migrationVersion != 1 || len(initialMigrationChecksum) != 32 {
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
		"new_api_bindings", "token_grants", "audit_events", "license_status_events", "schema_migrations",
	}).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 9 {
		t.Fatalf("table count = %d, want 9", tableCount)
	}
	var migrationCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = 1 AND octet_length(checksum) = 32`).Scan(&migrationCount); err != nil {
		t.Fatal(err)
	}
	if migrationCount != 1 {
		t.Fatalf("migration record count = %d, want 1", migrationCount)
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
