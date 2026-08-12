package persistence

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"u-claw-activation-server/internal/lifecycle"
)

func (repository *ActivationRepository) GetLicense(ctx context.Context, licenseID string) (lifecycle.License, error) {
	var record lifecycle.License
	var replacement *string
	err := repository.pool.QueryRow(ctx, `SELECT license_id,device_id,status,revision,not_before,expires_at,
		replacement_license_id,updated_at,startup_secret_salt,startup_secret_hash FROM licenses WHERE license_id=$1`, licenseID).
		Scan(&record.LicenseID, &record.DeviceID, &record.Status, &record.Revision, &record.NotBefore, &record.ExpiresAt,
			&replacement, &record.UpdatedAt, &record.StartupSecretSalt, &record.StartupSecretHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return lifecycle.License{}, lifecycle.ErrAuthentication
	}
	if err != nil {
		return lifecycle.License{}, fmt.Errorf("load license status: %w", err)
	}
	record.ReplacementLicenseID = replacement
	return record, nil
}

func (repository *ActivationRepository) ExpireLicense(ctx context.Context, licenseID string, now time.Time) (lifecycle.License, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return lifecycle.License{}, fmt.Errorf("begin license expiry: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var record lifecycle.License
	var replacement *string
	err = tx.QueryRow(ctx, `SELECT license_id,device_id,status,revision,not_before,expires_at,
		replacement_license_id,updated_at,startup_secret_salt,startup_secret_hash FROM licenses WHERE license_id=$1 FOR UPDATE`, licenseID).
		Scan(&record.LicenseID, &record.DeviceID, &record.Status, &record.Revision, &record.NotBefore, &record.ExpiresAt,
			&replacement, &record.UpdatedAt, &record.StartupSecretSalt, &record.StartupSecretHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return lifecycle.License{}, lifecycle.ErrAuthentication
	}
	if err != nil {
		return lifecycle.License{}, fmt.Errorf("lock license expiry: %w", err)
	}
	record.ReplacementLicenseID = replacement
	if record.Status == "active" && !now.Before(record.ExpiresAt) {
		record.Status = "expired"
		record.Revision++
		record.UpdatedAt = now
		if _, err := tx.Exec(ctx, `UPDATE licenses SET status='expired',revision=$1,updated_at=$2 WHERE license_id=$3`, record.Revision, now, licenseID); err != nil {
			return lifecycle.License{}, fmt.Errorf("persist license expiry: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO license_status_events
			(event_id,license_id,revision,status,created_at) VALUES (gen_random_uuid(),$1,$2,'expired',$3)`, licenseID, record.Revision, now); err != nil {
			return lifecycle.License{}, fmt.Errorf("record license expiry: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return lifecycle.License{}, fmt.Errorf("commit license expiry: %w", err)
	}
	return record, nil
}

func (repository *ActivationRepository) GetActivationForRecovery(ctx context.Context, activationID string) (lifecycle.RecoveryRecord, error) {
	var record lifecycle.RecoveryRecord
	err := repository.pool.QueryRow(ctx, `SELECT attempt.activation_id,attempt.device_id,attempt.license_id,attempt.artifact_envelope,attempt.artifact_key_version
		FROM activation_attempts attempt
		JOIN licenses license ON license.license_id=attempt.license_id AND license.device_id=attempt.device_id
		JOIN devices device ON device.device_id=attempt.device_id
		JOIN activation_inventory inventory ON inventory.id=attempt.inventory_id AND inventory.id=device.inventory_id
		JOIN new_api_bindings binding ON binding.inventory_id=inventory.id AND binding.device_id=device.device_id
		WHERE attempt.activation_id=$1 AND attempt.stage IN ('server_bound','committed')
		AND license.status='active' AND device.status='active' AND inventory.status='active' AND binding.status='active'`, activationID).
		Scan(&record.ActivationID, &record.DeviceID, &record.LicenseID, &record.ArtifactEnvelope, &record.ArtifactKeyVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return lifecycle.RecoveryRecord{}, lifecycle.ErrAuthentication
	}
	if err != nil {
		return lifecycle.RecoveryRecord{}, fmt.Errorf("load activation recovery: %w", err)
	}
	return record, nil
}

func (repository *ActivationRepository) RecordRecovery(ctx context.Context, activationID, requestID, outcome string) error {
	if outcome != "succeeded" && outcome != "failed" {
		return lifecycle.ErrUnavailable
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin recovery audit: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var inventoryID, deviceID, licenseID string
	err = tx.QueryRow(ctx, `SELECT inventory_id,device_id,license_id FROM activation_attempts WHERE activation_id=$1 FOR SHARE`, activationID).Scan(&inventoryID, &deviceID, &licenseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return lifecycle.ErrAuthentication
	}
	if err != nil {
		return fmt.Errorf("load recovery audit scope: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO audit_events
		(event_id,actor_type,actor_id,action,outcome,inventory_id,device_id,license_id,request_id,created_at)
		VALUES (gen_random_uuid(),'client',$1,'activation.recovered',$2,$3,$4,$5,$6,clock_timestamp())`, deviceID, outcome, inventoryID, deviceID, licenseID, requestID)
	if err != nil {
		return fmt.Errorf("record recovery audit: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit recovery audit: %w", err)
	}
	return nil
}

func (repository *ActivationRepository) CreateTokenGrant(ctx context.Context, grant lifecycle.TokenGrant) (lifecycle.TokenGrant, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return lifecycle.TokenGrant{}, fmt.Errorf("begin token grant: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, grant.IdempotencyKey); err != nil {
		return lifecycle.TokenGrant{}, fmt.Errorf("lock token idempotency key: %w", err)
	}
	existing, found, err := loadTokenGrant(ctx, tx, grant.IdempotencyKey, true)
	if err != nil {
		return lifecycle.TokenGrant{}, err
	}
	if found {
		return compareTokenGrant(existing, grant)
	}
	var licenseStatus, deviceStatus, bindingStatus, setupStatus string
	var notBefore, expiresAt time.Time
	err = tx.QueryRow(ctx, `SELECT status,not_before,expires_at FROM licenses WHERE license_id=$1 AND device_id=$2 FOR UPDATE`, grant.LicenseID, grant.DeviceID).Scan(&licenseStatus, &notBefore, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return lifecycle.TokenGrant{}, lifecycle.ErrAuthentication
	}
	if err != nil {
		return lifecycle.TokenGrant{}, fmt.Errorf("lock token license: %w", err)
	}
	err = tx.QueryRow(ctx, `SELECT status FROM devices WHERE device_id=$1 FOR UPDATE`, grant.DeviceID).Scan(&deviceStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return lifecycle.TokenGrant{}, lifecycle.ErrAuthentication
	}
	if err != nil {
		return lifecycle.TokenGrant{}, fmt.Errorf("lock token device: %w", err)
	}
	var policyDigest []byte
	err = tx.QueryRow(ctx, `SELECT status,balance_setup_status,policy_digest FROM new_api_bindings WHERE device_id=$1 FOR UPDATE`, grant.DeviceID).Scan(&bindingStatus, &setupStatus, &policyDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return lifecycle.TokenGrant{}, lifecycle.ErrAuthentication
	}
	if err != nil {
		return lifecycle.TokenGrant{}, fmt.Errorf("lock token binding: %w", err)
	}
	if licenseStatus != "active" || deviceStatus != "active" || bindingStatus != "active" || setupStatus != "configured" || grant.IssuedAt.Before(notBefore) || !grant.IssuedAt.Before(expiresAt) || grant.ExpiresAt.After(expiresAt) {
		return lifecycle.TokenGrant{}, lifecycle.ErrAuthentication
	}
	_, err = tx.Exec(ctx, `INSERT INTO token_grants
		(jti,device_id,license_id,policy_digest,status,issued_at,expires_at,created_at,idempotency_key)
		VALUES($1,$2,$3,$4,'active',$5,$6,$5,$7)`, grant.JTI, grant.DeviceID, grant.LicenseID, policyDigest, grant.IssuedAt, grant.ExpiresAt, grant.IdempotencyKey)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return lifecycle.TokenGrant{}, lifecycle.ErrIdempotencyConflict
		}
		return lifecycle.TokenGrant{}, fmt.Errorf("create token grant: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return lifecycle.TokenGrant{}, fmt.Errorf("commit token grant: %w", err)
	}
	return grant, nil
}

func (repository *ActivationRepository) loadTokenGrant(ctx context.Context, key string) (lifecycle.TokenGrant, bool, error) {
	return loadTokenGrant(ctx, repository.pool, key, false)
}

type tokenGrantQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func loadTokenGrant(ctx context.Context, query tokenGrantQuerier, key string, lock bool) (lifecycle.TokenGrant, bool, error) {
	var grant lifecycle.TokenGrant
	statement := `SELECT jti,device_id,license_id,idempotency_key,issued_at,expires_at FROM token_grants WHERE idempotency_key=$1`
	if lock {
		statement += ` FOR UPDATE`
	}
	err := query.QueryRow(ctx, statement, key).
		Scan(&grant.JTI, &grant.DeviceID, &grant.LicenseID, &grant.IdempotencyKey, &grant.IssuedAt, &grant.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return lifecycle.TokenGrant{}, false, nil
	}
	if err != nil {
		return lifecycle.TokenGrant{}, false, fmt.Errorf("load token grant: %w", err)
	}
	return grant, true, nil
}

func compareTokenGrant(existing, requested lifecycle.TokenGrant) (lifecycle.TokenGrant, error) {
	if existing.JTI != requested.JTI || existing.DeviceID != requested.DeviceID || existing.LicenseID != requested.LicenseID {
		return lifecycle.TokenGrant{}, lifecycle.ErrIdempotencyConflict
	}
	return existing, nil
}
