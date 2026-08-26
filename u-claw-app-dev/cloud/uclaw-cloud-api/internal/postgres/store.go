package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"uclaw-cloud-api/internal/auth"
)

// Store implements persistent auth and activation-code storage on PostgreSQL.
type Store struct {
	db               *sql.DB
	activationPepper string
}

// Open connects to PostgreSQL and verifies the database is reachable.
func Open(ctx context.Context, databaseURL string, activationPepper string) (*Store, error) {
	databaseURL = strings.TrimSpace(databaseURL)
	if databaseURL == "" {
		return nil, fmt.Errorf("database url is required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return NewStore(db, activationPepper), nil
}

// NewStore wraps an existing sql.DB for tests or custom process wiring.
func NewStore(db *sql.DB, activationPepper string) *Store {
	return &Store{
		db:               db,
		activationPepper: strings.TrimSpace(activationPepper),
	}
}

// Close closes the underlying PostgreSQL pool.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// SaveSMSCode saves or replaces the current phone-purpose SMS code.
func (s *Store) SaveSMSCode(ctx context.Context, phone string, purpose string, code auth.SMSCode) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO sms_codes (phone, purpose, code_hash, expires_at, consumed, created_at, consumed_at)
VALUES ($1, $2, $3, $4, false, now(), NULL)
ON CONFLICT (phone, purpose) DO UPDATE SET
  code_hash = EXCLUDED.code_hash,
  expires_at = EXCLUDED.expires_at,
  consumed = false,
  created_at = now(),
  consumed_at = NULL
`, phone, purpose, code.CodeHash, code.ExpiresAt)
	if err != nil {
		return fmt.Errorf("save sms code: %w", err)
	}
	return nil
}

// ConsumeSMSCode marks a valid SMS code as consumed exactly once.
func (s *Store) ConsumeSMSCode(ctx context.Context, phone string, purpose string, codeHash string, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `
UPDATE sms_codes
SET consumed = true, consumed_at = $5
WHERE phone = $1 AND purpose = $2 AND code_hash = $3 AND consumed = false AND expires_at > $4
`, phone, purpose, codeHash, now, now)
	if err != nil {
		return fmt.Errorf("consume sms code: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("consume sms code rows: %w", err)
	}
	if rows != 1 {
		return fmt.Errorf("sms code is invalid")
	}
	return nil
}

// UpsertUser creates or updates a verified U-Claw phone user.
func (s *Store) UpsertUser(ctx context.Context, phone string, verifiedAt time.Time) (auth.User, error) {
	var user auth.User
	err := s.db.QueryRowContext(ctx, `
INSERT INTO uclaw_users (phone, phone_verified_at, status, created_at, updated_at)
VALUES ($1, $2, 'active', now(), now())
ON CONFLICT (phone) DO UPDATE SET
  phone_verified_at = EXCLUDED.phone_verified_at,
  updated_at = now()
RETURNING id, phone
`, phone, verifiedAt).Scan(&user.ID, &user.Phone)
	if err != nil {
		return auth.User{}, fmt.Errorf("upsert user: %w", err)
	}
	return user, nil
}

// Redeem binds an existing activation code to a verified user once.
func (s *Store) Redeem(ctx context.Context, code string, userID int64, phone string, at time.Time) error {
	codeHash := s.activationCodeHash(code)
	result, err := s.db.ExecContext(ctx, `
UPDATE activation_codes
SET status = 'bound',
  bound_user_id = $2,
  bound_phone = $3,
  bound_at = $4
WHERE code_hash = $1
  AND status = 'unused'
  AND (expires_at IS NULL OR expires_at > $4)
`, codeHash, userID, phone, at)
	if err != nil {
		return fmt.Errorf("redeem activation code: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("redeem activation code rows: %w", err)
	}
	if rows != 1 {
		return fmt.Errorf("activation code is invalid or already bound")
	}
	return nil
}

// SeedActivationCode inserts an unused code hash for printed-card operations.
func (s *Store) SeedActivationCode(ctx context.Context, code string, batchID sql.NullInt64) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO activation_codes (batch_id, code_hash, status, created_at)
VALUES ($1, $2, 'unused', now())
ON CONFLICT (code_hash) DO NOTHING
`, batchID, s.activationCodeHash(code))
	if err != nil {
		return fmt.Errorf("seed activation code: %w", err)
	}
	return nil
}

// activationCodeHash hashes printed codes before they enter PostgreSQL.
func (s *Store) activationCodeHash(code string) string {
	normalized := strings.ToUpper(strings.TrimSpace(code))
	sum := sha256.Sum256([]byte(normalized + ":" + s.activationPepper))
	return hex.EncodeToString(sum[:])
}
