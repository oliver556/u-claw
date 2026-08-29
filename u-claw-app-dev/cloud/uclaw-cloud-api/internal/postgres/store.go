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

	"uclaw-cloud-api/internal/activation"
	"uclaw-cloud-api/internal/admin"
	"uclaw-cloud-api/internal/auth"
	"uclaw-cloud-api/internal/provisioning"
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
  AND (
    (status = 'unused' AND (expires_at IS NULL OR expires_at > $4))
    OR (status = 'bound' AND bound_user_id = $2 AND bound_phone = $3)
  )
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

// BindFirstStart binds an activation code and returns the persistent U-Claw user id for provisioning.
func (s *Store) BindFirstStart(ctx context.Context, code string, username string, at time.Time) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin first-start activation: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	username = strings.ToUpper(strings.TrimSpace(username))
	var userID int64
	if err = tx.QueryRowContext(ctx, `
INSERT INTO uclaw_users (phone, phone_verified_at, status, created_at, updated_at)
VALUES ($1, $2, 'active', now(), now())
ON CONFLICT (phone) DO UPDATE SET
  phone_verified_at = COALESCE(uclaw_users.phone_verified_at, EXCLUDED.phone_verified_at),
  updated_at = now()
RETURNING id
`, username, at).Scan(&userID); err != nil {
		return 0, fmt.Errorf("upsert first-start user: %w", err)
	}

	result, err := tx.ExecContext(ctx, `
UPDATE activation_codes
SET status = 'bound',
  bound_user_id = $2,
  bound_phone = $3,
  bound_at = $4
WHERE code_hash = $1
  AND (
    (status = 'unused' AND (expires_at IS NULL OR expires_at > $4))
    OR (status = 'bound' AND bound_user_id = $2 AND bound_phone = $3)
  )
`, s.activationCodeHash(code), userID, username, at)
	if err != nil {
		return 0, fmt.Errorf("bind first-start activation code: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("bind first-start activation code rows: %w", err)
	}
	if rows != 1 {
		return 0, fmt.Errorf("activation code is invalid or already bound")
	}
	if err = tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit first-start activation: %w", err)
	}
	committed = true
	return userID, nil
}

// RecordFirstStartAttempt stores the activation-only server-bound checkpoint.
func (s *Store) RecordFirstStartAttempt(ctx context.Context, attempt activation.FirstStartAttempt, at time.Time) error {
	stage := strings.TrimSpace(attempt.Stage)
	if stage == "" {
		stage = "server_bound"
	}
	artifactStatus := strings.TrimSpace(attempt.ArtifactStatus)
	if artifactStatus == "" {
		artifactStatus = "pending_client_write"
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO activation_attempts (
  activation_id,
  username_normalized,
  usb_fingerprint_summary,
  stage,
  artifact_status,
  write_status,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, '', $6, $6)
ON CONFLICT (activation_id) DO UPDATE SET
  username_normalized = EXCLUDED.username_normalized,
  usb_fingerprint_summary = EXCLUDED.usb_fingerprint_summary,
  stage = CASE
    WHEN activation_attempts.stage = 'committed' THEN activation_attempts.stage
    ELSE EXCLUDED.stage
  END,
  artifact_status = CASE
    WHEN activation_attempts.stage = 'committed' THEN activation_attempts.artifact_status
    ELSE EXCLUDED.artifact_status
  END,
  updated_at = EXCLUDED.updated_at
`, strings.TrimSpace(attempt.ActivationID), strings.TrimSpace(attempt.UsernameNormalized), strings.TrimSpace(attempt.USBFingerprintSummary), stage, artifactStatus, at)
	if err != nil {
		return fmt.Errorf("record first-start activation attempt: %w", err)
	}
	return nil
}

// CommitFirstStartAttempt stores the verified client write-helper checkpoint.
func (s *Store) CommitFirstStartAttempt(ctx context.Context, activationID string, writeStatus string, at time.Time) error {
	result, err := s.db.ExecContext(ctx, `
UPDATE activation_attempts
SET stage = 'committed',
  artifact_status = 'client_write_verified',
  write_status = $2,
  committed_at = COALESCE(committed_at, $3),
  updated_at = $3
WHERE activation_id = $1
  AND stage IN ('server_bound', 'committed')
`, strings.TrimSpace(activationID), strings.TrimSpace(writeStatus), at)
	if err != nil {
		return fmt.Errorf("commit first-start activation attempt: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("commit first-start activation attempt rows: %w", err)
	}
	if rows != 1 {
		return fmt.Errorf("activation id is unknown")
	}
	return nil
}

// SaveNewAPIAccount upserts the New API account mapping after successful provisioning.
func (s *Store) SaveNewAPIAccount(ctx context.Context, account provisioning.Account) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO newapi_accounts (
  uclaw_user_id,
  newapi_base_url,
  newapi_user_id,
  newapi_username,
  token_fingerprint,
  token_rotated_at,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6, now(), now())
ON CONFLICT (uclaw_user_id) DO UPDATE SET
  newapi_base_url = EXCLUDED.newapi_base_url,
  newapi_user_id = EXCLUDED.newapi_user_id,
  newapi_username = EXCLUDED.newapi_username,
  token_fingerprint = EXCLUDED.token_fingerprint,
  token_rotated_at = EXCLUDED.token_rotated_at,
  updated_at = now()
`, account.UClawUserID, account.NewAPIBaseURL, account.NewAPIUserID, account.NewAPIUsername, account.TokenFingerprint, account.TokenRotatedAt)
	if err != nil {
		return fmt.Errorf("save newapi account: %w", err)
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

// CreateActivationBatch creates a labeled group for operator-generated codes.
func (s *Store) CreateActivationBatch(ctx context.Context, name string, note string, createdBy string) (int64, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "manual"
	}
	var id int64
	err := s.db.QueryRowContext(ctx, `
INSERT INTO activation_batches (name, note, created_by, created_at)
VALUES ($1, $2, $3, now())
RETURNING id
`, name, strings.TrimSpace(note), strings.TrimSpace(createdBy)).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create activation batch: %w", err)
	}
	return id, nil
}

// CreateActivationCode inserts one generated code and returns its redacted row.
func (s *Store) CreateActivationCode(ctx context.Context, code string, batchID sql.NullInt64, at time.Time) (admin.ActivationCode, error) {
	var row activationCodeRow
	err := s.db.QueryRowContext(ctx, `
INSERT INTO activation_codes (batch_id, code_hash, status, created_at)
VALUES ($1, $2, 'unused', $3)
RETURNING id, batch_id, status, bound_user_id, bound_phone, bound_at, created_at, expires_at
`, batchID, s.activationCodeHash(code), at).Scan(
		&row.ID,
		&row.BatchID,
		&row.Status,
		&row.BoundUserID,
		&row.BoundPhone,
		&row.BoundAt,
		&row.CreatedAt,
		&row.ExpiresAt,
	)
	if err != nil {
		return admin.ActivationCode{}, fmt.Errorf("create activation code: %w", err)
	}
	return row.toAdminRecord(), nil
}

// ListActivationCodes returns recent activation inventory for the admin console.
func (s *Store) ListActivationCodes(ctx context.Context, filter admin.ActivationCodeFilter) ([]admin.ActivationCode, error) {
	status := strings.ToLower(strings.TrimSpace(filter.Status))
	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT
  ac.id,
  ac.batch_id,
  COALESCE(ab.name, ''),
  ac.status,
  ac.bound_user_id,
  ac.bound_phone,
  ac.bound_at,
  ac.created_at,
  ac.expires_at,
  na.newapi_user_id,
  COALESCE(na.newapi_username, ''),
  COALESCE(na.newapi_base_url, ''),
  na.token_rotated_at,
  COALESCE(aa.activation_id, ''),
  COALESCE(aa.stage, ''),
  aa.committed_at
FROM activation_codes ac
LEFT JOIN activation_batches ab ON ab.id = ac.batch_id
LEFT JOIN newapi_accounts na ON na.uclaw_user_id = ac.bound_user_id
LEFT JOIN LATERAL (
  SELECT activation_id, stage, committed_at
  FROM activation_attempts
  WHERE username_normalized = ac.bound_phone
  ORDER BY created_at DESC
  LIMIT 1
) aa ON true
WHERE ($1 = '' OR ac.status = $1)
ORDER BY ac.created_at DESC, ac.id DESC
LIMIT $2
`, status, limit)
	if err != nil {
		return nil, fmt.Errorf("list activation codes: %w", err)
	}
	defer rows.Close()

	var records []admin.ActivationCode
	for rows.Next() {
		row, err := scanActivationCodeView(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, row.toAdminRecord())
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list activation codes rows: %w", err)
	}
	return records, nil
}

// GetActivationCode returns one activation inventory row.
func (s *Store) GetActivationCode(ctx context.Context, id int64) (admin.ActivationCode, error) {
	row := activationCodeViewRow{}
	err := s.db.QueryRowContext(ctx, `
SELECT
  ac.id,
  ac.batch_id,
  COALESCE(ab.name, ''),
  ac.status,
  ac.bound_user_id,
  ac.bound_phone,
  ac.bound_at,
  ac.created_at,
  ac.expires_at,
  na.newapi_user_id,
  COALESCE(na.newapi_username, ''),
  COALESCE(na.newapi_base_url, ''),
  na.token_rotated_at,
  COALESCE(aa.activation_id, ''),
  COALESCE(aa.stage, ''),
  aa.committed_at
FROM activation_codes ac
LEFT JOIN activation_batches ab ON ab.id = ac.batch_id
LEFT JOIN newapi_accounts na ON na.uclaw_user_id = ac.bound_user_id
LEFT JOIN LATERAL (
  SELECT activation_id, stage, committed_at
  FROM activation_attempts
  WHERE username_normalized = ac.bound_phone
  ORDER BY created_at DESC
  LIMIT 1
) aa ON true
WHERE ac.id = $1
`, id).Scan(
		&row.ID,
		&row.BatchID,
		&row.BatchName,
		&row.Status,
		&row.BoundUserID,
		&row.BoundPhone,
		&row.BoundAt,
		&row.CreatedAt,
		&row.ExpiresAt,
		&row.NewAPIUserID,
		&row.NewAPIUsername,
		&row.NewAPIBaseURL,
		&row.NewAPITokenRotatedAt,
		&row.LatestActivationID,
		&row.LatestActivationStage,
		&row.LatestActivationCommit,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return admin.ActivationCode{}, fmt.Errorf("activation code not found")
		}
		return admin.ActivationCode{}, fmt.Errorf("get activation code: %w", err)
	}
	return row.toAdminRecord(), nil
}

// DisableActivationCode prevents future first-use binding of an inventory row.
func (s *Store) DisableActivationCode(ctx context.Context, id int64, _ string, at time.Time) error {
	result, err := s.db.ExecContext(ctx, `
UPDATE activation_codes
SET status = 'disabled'
WHERE id = $1 AND status IN ('unused', 'disabled')
  AND (expires_at IS NULL OR expires_at > $2)
`, id, at)
	if err != nil {
		return fmt.Errorf("disable activation code: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("disable activation code rows: %w", err)
	}
	if rows != 1 {
		return fmt.Errorf("activation code is not disableable")
	}
	return nil
}

// ReissueActivationCode atomically retires an unused code and creates a replacement.
func (s *Store) ReissueActivationCode(ctx context.Context, id int64, replacementCode string, at time.Time) (admin.ActivationCode, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return admin.ActivationCode{}, fmt.Errorf("begin reissue activation code: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	var batchID sql.NullInt64
	err = tx.QueryRowContext(ctx, `
UPDATE activation_codes
SET status = 'reissued'
WHERE id = $1 AND status IN ('unused', 'disabled')
RETURNING batch_id
`, id).Scan(&batchID)
	if err != nil {
		if err == sql.ErrNoRows {
			return admin.ActivationCode{}, fmt.Errorf("activation code is not reissueable")
		}
		return admin.ActivationCode{}, fmt.Errorf("reissue activation code: %w", err)
	}

	var row activationCodeRow
	err = tx.QueryRowContext(ctx, `
INSERT INTO activation_codes (batch_id, code_hash, status, created_at)
VALUES ($1, $2, 'unused', $3)
RETURNING id, batch_id, status, bound_user_id, bound_phone, bound_at, created_at, expires_at
`, batchID, s.activationCodeHash(replacementCode), at).Scan(
		&row.ID,
		&row.BatchID,
		&row.Status,
		&row.BoundUserID,
		&row.BoundPhone,
		&row.BoundAt,
		&row.CreatedAt,
		&row.ExpiresAt,
	)
	if err != nil {
		return admin.ActivationCode{}, fmt.Errorf("insert replacement activation code: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return admin.ActivationCode{}, fmt.Errorf("commit reissue activation code: %w", err)
	}
	committed = true
	return row.toAdminRecord(), nil
}

// activationCodeHash hashes printed codes before they enter PostgreSQL.
func (s *Store) activationCodeHash(code string) string {
	normalized := strings.ToUpper(strings.TrimSpace(code))
	sum := sha256.Sum256([]byte(normalized + ":" + s.activationPepper))
	return hex.EncodeToString(sum[:])
}

type activationCodeRow struct {
	ID          int64
	BatchID     sql.NullInt64
	Status      string
	BoundUserID sql.NullInt64
	BoundPhone  sql.NullString
	BoundAt     sql.NullTime
	CreatedAt   time.Time
	ExpiresAt   sql.NullTime
}

type activationCodeViewRow struct {
	activationCodeRow
	BatchName              string
	NewAPIUserID           sql.NullInt64
	NewAPIUsername         string
	NewAPIBaseURL          string
	NewAPITokenRotatedAt   sql.NullTime
	LatestActivationID     string
	LatestActivationStage  string
	LatestActivationCommit sql.NullTime
}

type activationCodeRowScanner interface {
	Scan(dest ...any) error
}

// scanActivationCodeView keeps list and detail scans aligned.
func scanActivationCodeView(scanner activationCodeRowScanner) (activationCodeViewRow, error) {
	var row activationCodeViewRow
	err := scanner.Scan(
		&row.ID,
		&row.BatchID,
		&row.BatchName,
		&row.Status,
		&row.BoundUserID,
		&row.BoundPhone,
		&row.BoundAt,
		&row.CreatedAt,
		&row.ExpiresAt,
		&row.NewAPIUserID,
		&row.NewAPIUsername,
		&row.NewAPIBaseURL,
		&row.NewAPITokenRotatedAt,
		&row.LatestActivationID,
		&row.LatestActivationStage,
		&row.LatestActivationCommit,
	)
	if err != nil {
		return activationCodeViewRow{}, fmt.Errorf("scan activation code view: %w", err)
	}
	return row, nil
}

// toAdminRecord converts nullable DB columns into JSON-friendly pointers.
func (row activationCodeRow) toAdminRecord() admin.ActivationCode {
	record := admin.ActivationCode{
		ID:        row.ID,
		Status:    row.Status,
		CreatedAt: row.CreatedAt,
	}
	if row.BatchID.Valid {
		record.BatchID = &row.BatchID.Int64
	}
	if row.BoundUserID.Valid {
		record.BoundUserID = &row.BoundUserID.Int64
	}
	if row.BoundPhone.Valid {
		record.BoundPhone = row.BoundPhone.String
	}
	if row.BoundAt.Valid {
		record.BoundAt = &row.BoundAt.Time
	}
	if row.ExpiresAt.Valid {
		record.ExpiresAt = &row.ExpiresAt.Time
	}
	return record
}

// toAdminRecord converts joined DB columns into JSON-friendly pointers.
func (row activationCodeViewRow) toAdminRecord() admin.ActivationCode {
	record := row.activationCodeRow.toAdminRecord()
	record.BatchName = row.BatchName
	if row.NewAPIUserID.Valid {
		record.NewAPIUserID = &row.NewAPIUserID.Int64
	}
	record.NewAPIUsername = row.NewAPIUsername
	record.NewAPIBaseURL = row.NewAPIBaseURL
	if row.NewAPITokenRotatedAt.Valid {
		record.NewAPITokenRotatedAt = &row.NewAPITokenRotatedAt.Time
	}
	record.LatestActivationID = row.LatestActivationID
	record.LatestActivationStage = row.LatestActivationStage
	if row.LatestActivationCommit.Valid {
		record.LatestActivationCommit = &row.LatestActivationCommit.Time
	}
	return record
}
