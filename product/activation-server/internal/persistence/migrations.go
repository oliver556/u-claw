package persistence

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	migrationAdvisoryLockID int64 = 0x55434c41574d4947
	migrationLockSQL              = "SELECT pg_advisory_xact_lock($1)"
	latestMigrationVersion  int64 = 6
)

const migrationLedgerSQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version BIGINT PRIMARY KEY CHECK (version > 0),
    checksum BYTEA NOT NULL CHECK (octet_length(checksum) = 32),
    applied_at TIMESTAMPTZ NOT NULL
)`

//go:embed migrations/001_initial.sql
var initialMigration string

//go:embed migrations/002_lifecycle.sql
var lifecycleMigration string

//go:embed migrations/003_admin.sql
var adminMigration string

//go:embed migrations/004_device_access_proxy.sql
var deviceAccessProxyMigration string

//go:embed migrations/005_release_policy.sql
var releasePolicyMigration string

//go:embed migrations/006_device_aliases.sql
var deviceAliasesMigration string

var initialMigrationChecksum = func() []byte {
	digest := sha256.Sum256([]byte(initialMigration))
	return digest[:]
}()

var lifecycleMigrationChecksum = func() []byte {
	digest := sha256.Sum256([]byte(lifecycleMigration))
	return digest[:]
}()

var adminMigrationChecksum = func() []byte {
	digest := sha256.Sum256([]byte(adminMigration))
	return digest[:]
}()

var deviceAccessProxyMigrationChecksum = func() []byte {
	digest := sha256.Sum256([]byte(deviceAccessProxyMigration))
	return digest[:]
}()

var releasePolicyMigrationChecksum = func() []byte {
	digest := sha256.Sum256([]byte(releasePolicyMigration))
	return digest[:]
}()

var deviceAliasesMigrationChecksum = func() []byte {
	digest := sha256.Sum256([]byte(deviceAliasesMigration))
	return digest[:]
}()

func InitialMigrationSQL() string {
	return initialMigration
}

func LifecycleMigrationSQL() string {
	return lifecycleMigration
}

func AdminMigrationSQL() string { return adminMigration }

func DeviceAccessProxyMigrationSQL() string { return deviceAccessProxyMigration }

func ReleasePolicyMigrationSQL() string { return releasePolicyMigration }

func DeviceAliasesMigrationSQL() string { return deviceAliasesMigration }

type migration struct {
	version  int64
	contents string
	checksum []byte
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("PostgreSQL pool is required")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, migrationLockSQL, migrationAdvisoryLockID); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	if _, err := tx.Exec(ctx, migrationLedgerSQL); err != nil {
		return fmt.Errorf("create migration ledger: %w", err)
	}

	for _, candidate := range []migration{
		{version: 1, contents: initialMigration, checksum: initialMigrationChecksum},
		{version: 2, contents: lifecycleMigration, checksum: lifecycleMigrationChecksum},
		{version: 3, contents: adminMigration, checksum: adminMigrationChecksum},
		{version: 4, contents: deviceAccessProxyMigration, checksum: deviceAccessProxyMigrationChecksum},
		{version: 5, contents: releasePolicyMigration, checksum: releasePolicyMigrationChecksum},
		{version: 6, contents: deviceAliasesMigration, checksum: deviceAliasesMigrationChecksum},
	} {
		var checksum []byte
		err = tx.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE version = $1", candidate.version).Scan(&checksum)
		switch {
		case err == nil:
			if !equalBytes(checksum, candidate.checksum) {
				return fmt.Errorf("migration %d checksum mismatch", candidate.version)
			}
		case errors.Is(err, pgx.ErrNoRows):
			if _, err := tx.Exec(ctx, candidate.contents); err != nil {
				return fmt.Errorf("apply migration %d: %w", candidate.version, err)
			}
			if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, now())", candidate.version, candidate.checksum); err != nil {
				return fmt.Errorf("record migration %d: %w", candidate.version, err)
			}
		default:
			return fmt.Errorf("read migration %d ledger: %w", candidate.version, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration transaction: %w", err)
	}
	return nil
}

func VerifyMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("PostgreSQL pool is required")
	}
	for _, candidate := range []migration{
		{version: 1, checksum: initialMigrationChecksum},
		{version: 2, checksum: lifecycleMigrationChecksum},
		{version: 3, checksum: adminMigrationChecksum},
		{version: 4, checksum: deviceAccessProxyMigrationChecksum},
		{version: 5, checksum: releasePolicyMigrationChecksum},
		{version: 6, checksum: deviceAliasesMigrationChecksum},
	} {
		var checksum []byte
		err := pool.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE version = $1", candidate.version).Scan(&checksum)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("migration %d is not applied", candidate.version)
		}
		if err != nil {
			return fmt.Errorf("read migration %d ledger: %w", candidate.version, err)
		}
		if !equalBytes(checksum, candidate.checksum) {
			return fmt.Errorf("migration %d checksum mismatch", candidate.version)
		}
	}
	return nil
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var difference byte
	for index := range left {
		difference |= left[index] ^ right[index]
	}
	return difference == 0
}
