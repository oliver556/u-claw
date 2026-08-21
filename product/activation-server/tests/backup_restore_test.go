package tests

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrationScriptUsesDedicatedLeastPrivilegeRoles(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "deploy", "migrate.sh"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(contents)
	for _, required := range []string{
		"ACTIVATION_MIGRATION_ROLE",
		"ACTIVATION_APP_ROLE",
		"NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION",
		"REVOKE CREATE ON SCHEMA",
		"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA",
		"has_database_privilege",
		"REVOKE TEMPORARY ON DATABASE",
		"has_schema_privilege",
		"pg_has_role",
		"ALTER TABLE %I.%I OWNER TO %I",
		"REVOKE %I FROM %I",
		"application role unexpectedly has DDL privilege",
		"sha256sum",
		"shasum",
		"checksum_004",
		"004_device_access_proxy.sql",
		"WHERE version = 4",
		"VALUES (4, decode('$checksum_004', 'hex'), now())",
		"checksum_005",
		"005_release_policy.sql",
		"WHERE version = 5",
		"VALUES (5, decode('$checksum_005', 'hex'), now())",
		"checksum_006",
		"006_device_aliases.sql",
		"WHERE version = 6",
		"VALUES (6, decode('$checksum_006', 'hex'), now())",
		"REVOKE INSERT, UPDATE, DELETE ON TABLE public.schema_migrations",
		"Rollback server/admin binaries may reuse this current migrator or skip migration",
		"Do not run an older migrator against a schema with newer ledger entries",
	} {
		if !strings.Contains(script, required) {
			t.Errorf("migrate.sh missing least-privilege control %q", required)
		}
	}
	grantAt := strings.Index(script, "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public")
	revokeLedgerAt := strings.Index(script, "REVOKE INSERT, UPDATE, DELETE ON TABLE public.schema_migrations")
	if grantAt < 0 || revokeLedgerAt <= grantAt {
		t.Fatal("migrate.sh must revoke schema_migrations DML after broad application table grants")
	}
}

func TestProductionGatewayRateLimitReturnsActivationErrorJSON(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "deploy", "compose.production.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	compose := string(contents)
	for _, required := range []string{
		`ngx.status = 429`,
		`ngx.header["Content-Type"] = "application/json"`,
		`ngx.header["Retry-After"] = "60"`,
		`requestId = "gateway-rate-limit"`,
		`activationId = cjson.null`,
		`code = "RATE_LIMIT_EXCEEDED"`,
		`stage = cjson.null`,
		`retryable = true`,
		`supportCode = "RATE-LIMIT"`,
		`return ngx.exit(429)`,
	} {
		if !strings.Contains(compose, required) {
			t.Errorf("production rate limiter missing activation error contract %q", required)
		}
	}
	if strings.Contains(compose, `if count > item[3] then return ngx.exit(429) end`) {
		t.Error("production rate limiter returns an empty 429 response")
	}
}

func TestBackupRestorePreservesActivationStateAndExcludesPlaintextSecrets(t *testing.T) {
	databaseURL := os.Getenv("ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ACTIVATION_TEST_DATABASE_URL is not set; backup/restore PostgreSQL test skipped")
	}
	for _, command := range []string{"psql", "pg_dump", "pg_restore"} {
		if _, err := exec.LookPath(command); err != nil {
			t.Fatalf("%s is required when ACTIVATION_TEST_DATABASE_URL is set: %v", command, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	maintenanceURL, err := databaseURLWithName(databaseURL, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.New(ctx, maintenanceURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()

	suffix := randomHex(t, 6)
	sourceDB := "activation_backup_src_" + suffix
	restoreDB := "activation_backup_dst_" + suffix
	migrationRole := "activation_migrator_" + suffix
	appRole := "activation_app_" + suffix
	for _, database := range []string{sourceDB, restoreDB} {
		if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{database}.Sanitize()); err != nil {
			t.Fatalf("create temporary database %s: %v", database, err)
		}
	}
	defer cleanupDatabasesAndRoles(context.Background(), admin, []string{sourceDB, restoreDB}, []string{appRole, migrationRole})

	sourceURL, err := databaseURLWithName(databaseURL, sourceDB)
	if err != nil {
		t.Fatal(err)
	}
	runCommand(t, filepath.Join("..", "deploy"), []string{
		"ACTIVATION_DATABASE_URL=" + sourceURL,
		"ACTIVATION_MIGRATION_ROLE=" + migrationRole,
		"ACTIVATION_MIGRATION_PASSWORD=migration-password-" + suffix,
		"ACTIVATION_APP_ROLE=" + appRole,
		"ACTIVATION_APP_PASSWORD=app-password-" + suffix,
	}, "sh", "./migrate.sh")
	appURL, err := databaseURLForRole(sourceURL, appRole, "app-password-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	assertApplicationRoleHasNoDDL(t, ctx, appURL)

	source, err := pgxpool.New(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	plaintextActivationCode := "ACTIVATION-PLAINTEXT-MUST-NOT-BE-IN-BACKUP-" + suffix
	plaintextStartupSecret := "STARTUP-PLAINTEXT-MUST-NOT-BE-IN-BACKUP-" + suffix
	plaintextDeviceToken := "uclaw_dt_" + randomHex(t, 24)
	plaintextNewAPIKey := "new_api_key_" + randomHex(t, 24)
	tokenDigest, apiEnvelope := insertRestoreFixtures(t, ctx, source, plaintextActivationCode, plaintextStartupSecret, plaintextDeviceToken, plaintextNewAPIKey)

	dumpPath := filepath.Join(t.TempDir(), "activation.dump")
	runCommand(t, "", nil, "pg_dump", "--format=custom", "--no-owner", "--no-acl", "--file", dumpPath, sourceURL)
	logicalDumpPath := filepath.Join(t.TempDir(), "activation.sql")
	runCommand(t, "", nil, "pg_restore", "--file", logicalDumpPath, dumpPath)
	dump, err := os.ReadFile(logicalDumpPath)
	if err != nil {
		t.Fatal(err)
	}
	for name, secret := range map[string]string{
		"activation code": plaintextActivationCode,
		"startup secret":  plaintextStartupSecret,
		"device token":    plaintextDeviceToken,
		"New API key":     plaintextNewAPIKey,
	} {
		if bytes.Contains(dump, []byte(secret)) {
			t.Fatalf("backup contains plaintext %s marker", name)
		}
	}

	restoreURL, err := databaseURLWithName(databaseURL, restoreDB)
	if err != nil {
		t.Fatal(err)
	}
	runCommand(t, "", nil, "pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "--dbname", restoreURL, dumpPath)
	runCommand(t, filepath.Join("..", "deploy"), []string{
		"ACTIVATION_DATABASE_URL=" + restoreURL,
		"ACTIVATION_MIGRATION_ROLE=" + migrationRole,
		"ACTIVATION_MIGRATION_PASSWORD=migration-password-" + suffix,
		"ACTIVATION_APP_ROLE=" + appRole,
		"ACTIVATION_APP_PASSWORD=app-password-" + suffix,
	}, "sh", "./migrate.sh")
	restored, err := pgxpool.New(ctx, restoreURL)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()

	assertRestoredState(t, ctx, restored, tokenDigest, apiEnvelope)
	assertRestoredUniqueConstraints(t, ctx, restored)
	restoredAppURL, err := databaseURLForRole(restoreURL, appRole, "app-password-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	assertApplicationRoleHasNoDDL(t, ctx, restoredAppURL)
}

func assertRestoredUniqueConstraints(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	statements := []struct {
		name string
		sql  string
	}{
		{"inventory username", `INSERT INTO activation_inventory (id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at) VALUES ('00000000-0000-0000-0000-000000000091','fixture-prepared','duplicate',decode(repeat('91',32),'hex'),'prepared','pending',now())`},
		{"activation digest", `INSERT INTO activation_inventory (id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at) VALUES ('00000000-0000-0000-0000-000000000092','fixture-unique','duplicate',decode(repeat('02',32),'hex'),'prepared','pending',now())`},
		{"device fingerprint", `INSERT INTO devices (device_id,inventory_id,fingerprint_version,fingerprint_sha256,status,created_at,updated_at) VALUES ('10000000-0000-0000-0000-000000000093','00000000-0000-0000-0000-000000000002','uclaw-usb-v1',decode(repeat('13',32),'hex'),'active',now(),now())`},
		{"license revision", `INSERT INTO licenses (license_id,device_id,status,revision,key_id,startup_secret_salt,startup_secret_hash,not_before,expires_at,created_at,updated_at) VALUES ('20000000-0000-0000-0000-000000000093','10000000-0000-0000-0000-000000000003','active',2,'fixture-key',decode(repeat('93',16),'hex'),decode(repeat('93',32),'hex'),now(),now()+interval '30 days',now(),now())`},
		{"activation idempotency", `INSERT INTO activation_attempts (activation_id,idempotency_key,request_fingerprint,stage,request_id,created_at,updated_at) VALUES ('30000000-0000-0000-0000-000000000093','fixture-activation',decode(repeat('93',32),'hex'),'requested','fixture-duplicate',now(),now())`},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement.sql); !postgresCode(err, "23505") {
			t.Fatalf("restored %s unique constraint error = %v, want SQLSTATE 23505", statement.name, err)
		}
	}
}

func assertApplicationRoleHasNoDDL(t *testing.T, ctx context.Context, appURL string) {
	t.Helper()
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	var tableCount int
	if err := app.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&tableCount); err != nil {
		t.Fatalf("application role cannot read migrated tables: %v", err)
	}
	if _, err := app.Exec(ctx, `INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (999,decode(repeat('99',32),'hex'),now())`); !postgresCode(err, "42501") {
		t.Fatalf("application role schema_migrations write error = %v, want SQLSTATE 42501", err)
	}
	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	const fixtureID = "90000000-0000-0000-0000-000000000001"
	if _, err := tx.Exec(ctx, `INSERT INTO activation_inventory
		(id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at)
		VALUES ($1,'app-role-dml','App Role DML',decode(repeat('90',32),'hex'),'prepared','pending',now())`, fixtureID); err != nil {
		t.Fatalf("application role cannot insert: %v", err)
	}
	if tag, err := tx.Exec(ctx, `UPDATE activation_inventory SET username_display='App Role Updated' WHERE id=$1`, fixtureID); err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("application role cannot update: tag=%v err=%v", tag, err)
	}
	if tag, err := tx.Exec(ctx, `DELETE FROM activation_inventory WHERE id=$1`, fixtureID); err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("application role cannot delete: tag=%v err=%v", tag, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		"CREATE TABLE app_role_must_not_create(id integer)",
		"CREATE TEMP TABLE app_role_must_not_create_temp(id integer)",
		"CREATE SCHEMA app_role_must_not_create",
	} {
		if _, err := app.Exec(ctx, statement); !postgresCode(err, "42501") {
			t.Fatalf("application role DDL error = %v, want SQLSTATE 42501 for %q", err, statement)
		}
	}
}

func insertRestoreFixtures(t *testing.T, ctx context.Context, pool *pgxpool.Pool, activationCode, startupSecret, deviceToken, newAPIKey string) ([]byte, []byte) {
	t.Helper()
	activationDigest := sha256.Sum256([]byte(activationCode))
	startupHash := sha256.Sum256([]byte(startupSecret))
	tokenDigest := sha256.Sum256([]byte(deviceToken))
	apiEnvelope := sha256.Sum256([]byte("new-api-envelope-v1:" + newAPIKey))
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO activation_inventory
			(id, username_normalized, username_display, activation_code_digest, status, new_api_setup_status, entitlement_revision, created_at, activated_at) VALUES
			('00000000-0000-0000-0000-000000000001','fixture-prepared','Fixture Prepared',$1,'prepared','pending',1,now(),NULL),
			('00000000-0000-0000-0000-000000000002','fixture-binding','Fixture Binding',decode(repeat('02',32),'hex'),'binding','pending',1,now(),NULL),
			('00000000-0000-0000-0000-000000000003','fixture-active','Fixture Active',decode(repeat('03',32),'hex'),'active','configured',3,now(),now())`, []any{activationDigest[:]}},
		{`INSERT INTO devices (device_id,inventory_id,fingerprint_version,fingerprint_sha256,status,created_at,updated_at)
			VALUES ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000003','uclaw-usb-v1',decode(repeat('13',32),'hex'),'reissued',now(),now())`, nil},
		{`INSERT INTO licenses (license_id,device_id,status,revision,key_id,startup_secret_salt,startup_secret_hash,not_before,expires_at,created_at,updated_at) VALUES
			('20000000-0000-0000-0000-000000000032','10000000-0000-0000-0000-000000000003','active',2,'fixture-key',decode(repeat('22',16),'hex'),$1,now(),now()+interval '30 days',now(),now())`, []any{startupHash[:]}},
		{`INSERT INTO licenses (license_id,device_id,status,revision,key_id,startup_secret_salt,startup_secret_hash,not_before,expires_at,replacement_license_id,created_at,updated_at)
			VALUES ('20000000-0000-0000-0000-000000000031','10000000-0000-0000-0000-000000000003','reissued',1,'fixture-key',decode(repeat('21',16),'hex'),$1,now(),now()+interval '30 days','20000000-0000-0000-0000-000000000032','2026-01-01T00:00:00Z',now())`, []any{startupHash[:]}},
		{`INSERT INTO new_api_bindings
			(inventory_id,device_id,new_api_user_id,new_api_username,balance_setup_status,status,policy_digest,api_key_envelope,api_key_version,base_url,default_model,allowed_models,requests_per_minute,concurrent_requests,created_at,updated_at)
			VALUES ('00000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','fixture-api-user','fixture-api','configured','active',decode(repeat('23',32),'hex'),$1,'fixture-kek-v1','https://api.invalid/v1','fixture-model',ARRAY['fixture-model'],120,4,now(),now())`, []any{apiEnvelope[:]}},
		{`INSERT INTO device_access_tokens
			(device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at)
			VALUES ('60000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000032',$1,'active',now(),now(),now())`, []any{tokenDigest[:]}},
		{`INSERT INTO model_proxy_admissions
			(request_id,device_token_id,started_at,lease_expires_at,completed_at)
			VALUES ('70000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000003','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z','2026-01-01T00:00:30Z')`, nil},
		{`INSERT INTO activation_attempts
			(activation_id,idempotency_key,inventory_id,device_id,license_id,request_fingerprint,stage,artifact_envelope,artifact_key_version,request_id,active_status_event_id,bound_audit_event_id,artifact_generation,commit_idempotency_key,created_at,updated_at,committed_at)
			VALUES ('30000000-0000-0000-0000-000000000003','fixture-activation','00000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000032',decode(repeat('33',32),'hex'),'committed',decode('55434c41572d454e56454c4f50452d5631','hex'),'fixture-kek-v1','fixture-request','40000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000003',7,'fixture-commit',now(),now(),now())`, nil},
		{`INSERT INTO audit_events (event_id,actor_type,actor_id,action,outcome,inventory_id,device_id,license_id,request_id,created_at,reason,idempotency_key) VALUES
			('50000000-0000-0000-0000-000000000001','operator','restore-test','inventory.prepared','succeeded','00000000-0000-0000-0000-000000000001',NULL,NULL,'fixture-prepared',now(),'fixture','audit-1'),
			('50000000-0000-0000-0000-000000000002','system',NULL,'inventory.binding','succeeded','00000000-0000-0000-0000-000000000002',NULL,NULL,'fixture-binding',now(),'fixture','audit-2'),
			('50000000-0000-0000-0000-000000000003','client','fixture-client','license.active','succeeded','00000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000032','fixture-active',now(),'fixture','audit-3'),
			('50000000-0000-0000-0000-000000000004','operator','restore-test','license.reissued','succeeded','00000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000031','fixture-reissued',now(),'fixture','audit-4')`, nil},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("insert backup fixture: %v", err)
		}
	}
	return tokenDigest[:], apiEnvelope[:]
}

func assertRestoredState(t *testing.T, ctx context.Context, pool *pgxpool.Pool, expectedTokenDigest, expectedAPIEnvelope []byte) {
	t.Helper()
	var prepared, binding, active, reissued, audits int
	var entitlementRevision, oldRevision, newRevision, artifactGeneration int64
	var envelope []byte
	var apiEnvelope, tokenDigest []byte
	var defaultModel string
	var admissionCount int
	err := pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE status='prepared'), count(*) FILTER (WHERE status='binding'), count(*) FILTER (WHERE status='active'),
		max(entitlement_revision) FROM activation_inventory`).Scan(&prepared, &binding, &active, &entitlementRevision)
	if err != nil {
		t.Fatal(err)
	}
	err = pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE status='reissued'),
		max(revision) FILTER (WHERE status='reissued'), max(revision) FILTER (WHERE status='active') FROM licenses`).Scan(&reissued, &oldRevision, &newRevision)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT artifact_envelope, artifact_generation FROM activation_attempts WHERE idempotency_key='fixture-activation'`).Scan(&envelope, &artifactGeneration); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE request_id LIKE 'fixture-%'`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT api_key_envelope,default_model FROM new_api_bindings WHERE inventory_id='00000000-0000-0000-0000-000000000003'`).Scan(&apiEnvelope, &defaultModel); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT token_digest FROM device_access_tokens WHERE device_token_id='60000000-0000-0000-0000-000000000003'`).Scan(&tokenDigest); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM model_proxy_admissions WHERE device_token_id='60000000-0000-0000-0000-000000000003' AND completed_at IS NOT NULL`).Scan(&admissionCount); err != nil {
		t.Fatal(err)
	}
	if prepared != 1 || binding != 1 || active != 1 || reissued != 1 {
		t.Fatalf("restored states prepared=%d binding=%d active=%d reissued=%d", prepared, binding, active, reissued)
	}
	if entitlementRevision != 3 || oldRevision != 1 || newRevision != 2 || artifactGeneration != 7 {
		t.Fatalf("restored revisions entitlement=%d old=%d new=%d artifact=%d", entitlementRevision, oldRevision, newRevision, artifactGeneration)
	}
	if string(envelope) != "UCLAW-ENVELOPE-V1" || audits != 4 {
		t.Fatalf("restored artifact=%q audits=%d", envelope, audits)
	}
	if !bytes.Equal(apiEnvelope, expectedAPIEnvelope) || defaultModel != "fixture-model" || !bytes.Equal(tokenDigest, expectedTokenDigest) || admissionCount != 1 {
		t.Fatalf("restored proxy state api_envelope=%q model=%q token_digest_len=%d admissions=%d", apiEnvelope, defaultModel, len(tokenDigest), admissionCount)
	}
}

func databaseURLWithName(rawURL, database string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return "", fmt.Errorf("ACTIVATION_TEST_DATABASE_URL must be a postgres URL")
	}
	parsed.Path = "/" + database
	return parsed.String(), nil
}

func databaseURLForRole(rawURL, username, password string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	parsed.User = url.UserPassword(username, password)
	return parsed.String(), nil
}

func randomHex(t *testing.T, size int) string {
	t.Helper()
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(value)
}

func runCommand(t *testing.T, directory string, environment []string, name string, args ...string) {
	t.Helper()
	command := exec.Command(name, args...)
	command.Dir = directory
	command.Env = append(os.Environ(), environment...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s failed: %v\n%s", name, err, output)
	}
}

func cleanupDatabasesAndRoles(ctx context.Context, admin *pgxpool.Pool, databases, roles []string) {
	for _, database := range databases {
		_, _ = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{database}.Sanitize()+" WITH (FORCE)")
	}
	for _, role := range roles {
		_, _ = admin.Exec(ctx, "DROP ROLE IF EXISTS "+pgx.Identifier{role}.Sanitize())
	}
}

func postgresCode(err error, code string) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == code
}
