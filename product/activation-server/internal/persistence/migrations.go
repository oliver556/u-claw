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
	latestMigrationVersion  int64 = 2
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

var initialMigrationChecksum = func() []byte {
	digest := sha256.Sum256([]byte(initialMigration))
	return digest[:]
}()

var lifecycleMigrationChecksum = func() []byte {
	digest := sha256.Sum256([]byte(lifecycleMigration))
	return digest[:]
}()

func InitialMigrationSQL() string {
	return initialMigration
}

func LifecycleMigrationSQL() string {
	return lifecycleMigration
}

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
