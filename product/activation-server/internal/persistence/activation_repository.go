package persistence

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"u-claw-activation-server/internal/activation"
)

type ActivationRepository struct{ pool *pgxpool.Pool }

func NewActivationRepository(pool *pgxpool.Pool) (*ActivationRepository, error) {
	if pool == nil {
		return nil, errors.New("PostgreSQL pool is required")
	}
	return &ActivationRepository{pool: pool}, nil
}

func (repository *ActivationRepository) ValidateBinding(ctx context.Context, input activation.ValidateBindingInput) error {
	fingerprint, err := decodeFingerprint(input.FingerprintSHA256)
	if err != nil {
		return activation.ErrActivationInvalid
	}
	existing, found, err := repository.loadAttemptByIdempotency(ctx, input.IdempotencyKey)
	if err != nil {
		return err
	}
	if found {
		if !bytes.Equal(existing.RequestFingerprint[:], input.RequestFingerprint[:]) {
			return activation.ErrIdempotencyConflict
		}
		return nil
	}
	var inventoryID, status, setupStatus string
	var mappingReady bool
	var boundVersion *string
	var boundFingerprint []byte
	err = repository.pool.QueryRow(ctx, `SELECT inventory.id,inventory.status,inventory.new_api_setup_status,
		COALESCE(binding.status='active' AND binding.balance_setup_status='configured'
			AND length(binding.api_key_envelope)>0 AND binding.api_key_version<>'' AND binding.base_url<>''
			AND binding.default_model<>'' AND cardinality(binding.allowed_models)>0
			AND binding.default_model=ANY(binding.allowed_models),false),
		device.fingerprint_version,device.fingerprint_sha256 FROM activation_inventory inventory
		LEFT JOIN new_api_bindings binding ON binding.inventory_id=inventory.id
		LEFT JOIN devices device ON device.inventory_id=inventory.id WHERE inventory.activation_code_digest=$1`,
		input.ActivationCodeDigest[:]).Scan(&inventoryID, &status, &setupStatus, &mappingReady, &boundVersion, &boundFingerprint)
	if errors.Is(err, pgx.ErrNoRows) {
		return activation.ErrActivationInvalid
	}
	if err != nil {
		return fmt.Errorf("validate activation inventory: %w", err)
	}
	if setupStatus != "configured" || !mappingReady {
		return activation.ErrNewAPINotConfigured
	}
	if status == "prepared" {
		return nil
	}
	if boundVersion != nil && *boundVersion == input.FingerprintVersion && bytes.Equal(boundFingerprint, fingerprint) {
		return nil
	}
	if len(input.DeviceAliases) > 0 {
		matched, err := repository.deviceAliasMatches(ctx, inventoryID, input.DeviceAliases)
		if err != nil {
			return err
		}
		if matched {
			return nil
		}
	}
	return activation.ErrActivationCodeAlreadyBound
}

func (repository *ActivationRepository) loadAttemptByIdempotency(ctx context.Context, key string) (activation.BoundRecord, bool, error) {
	conn, err := repository.pool.Acquire(ctx)
	if err != nil {
		return activation.BoundRecord{}, false, fmt.Errorf("acquire activation lookup: %w", err)
	}
	defer conn.Release()
	record, found, err := scanAttempt(conn.QueryRow(ctx, attemptSelect+" WHERE attempt.idempotency_key=$1", key))
	if err != nil || !found {
		return record, found, err
	}
	if err := loadDeviceAliases(ctx, conn, &record); err != nil {
		return activation.BoundRecord{}, false, err
	}
	return record, true, nil
}

func (repository *ActivationRepository) deviceAliasMatches(ctx context.Context, inventoryID string, aliases []activation.DeviceAliasInput) (bool, error) {
	for _, alias := range aliases {
		fingerprint, err := decodeFingerprint(alias.Fingerprint.SHA256)
		if err != nil {
			return false, activation.ErrActivationInvalid
		}
		var exists bool
		err = repository.pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM device_aliases
			WHERE inventory_id=$1 AND target=$2 AND fingerprint_version=$3 AND fingerprint_sha256=$4
		)`, inventoryID, alias.Target, alias.Fingerprint.Version, fingerprint).Scan(&exists)
		if err != nil {
			return false, fmt.Errorf("match device alias: %w", err)
		}
		if exists {
			return true, nil
		}
	}
	return false, nil
}

func (repository *ActivationRepository) BeginBinding(ctx context.Context, input activation.BeginBindingInput) (activation.BeginBindingResult, error) {
	if _, err := decodeFingerprint(input.Record.FingerprintSHA256); err != nil {
		return activation.BeginBindingResult{}, activation.ErrActivationInvalid
	}
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return activation.BeginBindingResult{}, fmt.Errorf("begin activation transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	existing, found, err := loadAttempt(ctx, tx, "attempt.idempotency_key = $1", input.IdempotencyKey, false)
	if err != nil {
		return activation.BeginBindingResult{}, err
	}
	if found {
		if err = ensureActivationRecoverable(ctx, tx, existing); err != nil {
			return activation.BeginBindingResult{}, err
		}
		existing, found, err = loadAttempt(ctx, tx, "attempt.idempotency_key = $1", input.IdempotencyKey, true)
		if err != nil {
			return activation.BeginBindingResult{}, err
		}
		if !found {
			return activation.BeginBindingResult{}, activation.ErrActivationInProgress
		}
		return resumeExisting(ctx, tx, input, existing)
	}

	var inventoryID, status, setupStatus, defaultModel string
	var entitlementRevision int64
	err = tx.QueryRow(ctx, `SELECT id,status,new_api_setup_status,entitlement_revision
		FROM activation_inventory WHERE activation_code_digest = $1 FOR UPDATE`, input.ActivationCodeDigest[:]).
		Scan(&inventoryID, &status, &setupStatus, &entitlementRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return activation.BeginBindingResult{}, activation.ErrActivationInvalid
	}
	if err != nil {
		return activation.BeginBindingResult{}, fmt.Errorf("lock activation inventory: %w", err)
	}
	if setupStatus != "configured" {
		return activation.BeginBindingResult{}, activation.ErrNewAPINotConfigured
	}
	var mappingReady bool
	err = tx.QueryRow(ctx, `SELECT status='active' AND balance_setup_status='configured'
		AND length(api_key_envelope)>0 AND api_key_version<>'' AND base_url<>''
		AND default_model<>'' AND cardinality(allowed_models)>0 AND default_model=ANY(allowed_models),default_model
		FROM new_api_bindings WHERE inventory_id=$1 FOR UPDATE`, inventoryID).Scan(&mappingReady, &defaultModel)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !mappingReady) {
		return activation.BeginBindingResult{}, activation.ErrNewAPINotConfigured
	}
	if err != nil {
		return activation.BeginBindingResult{}, fmt.Errorf("lock activation mapping: %w", err)
	}
	if status != "prepared" {
		recovered, ok, loadErr := loadAttemptByInventoryAndDevice(ctx, tx, inventoryID, input.Record)
		if loadErr != nil {
			return activation.BeginBindingResult{}, loadErr
		}
		if ok {
			if loadErr = ensureActivationRecoverable(ctx, tx, recovered); loadErr != nil {
				return activation.BeginBindingResult{}, loadErr
			}
			recovered, ok, loadErr = loadAttempt(ctx, tx, "attempt.activation_id = $1", recovered.ActivationID, true)
			if loadErr != nil {
				return activation.BeginBindingResult{}, loadErr
			}
			if !ok {
				return activation.BeginBindingResult{}, activation.ErrActivationInProgress
			}
			if recovered.ArtifactEnvelope != nil {
				if err := recordActivationRecovery(ctx, tx, recovered, input.Record.RequestID); err != nil {
					return activation.BeginBindingResult{}, err
				}
				if err := tx.Commit(ctx); err != nil {
					return activation.BeginBindingResult{}, fmt.Errorf("commit recovery lookup: %w", err)
				}
				recovered.RecoveryRequestID = input.Record.RequestID
				return activation.BeginBindingResult{Disposition: activation.BindingBound, Record: recovered}, nil
			}
			return resumeExisting(ctx, tx, input, recovered)
		}
		return activation.BeginBindingResult{}, activation.ErrActivationCodeAlreadyBound
	}

	record := input.Record
	record.InventoryID, record.UsernameID, record.Revision = inventoryID, inventoryID, entitlementRevision
	record.DefaultModel = defaultModel
	if err := insertBinding(ctx, tx, input, record); err != nil {
		return activation.BeginBindingResult{}, mapBindingError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return activation.BeginBindingResult{}, fmt.Errorf("commit activation binding: %w", err)
	}
	return activation.BeginBindingResult{Disposition: activation.BindingAcquired, Record: record}, nil
}

func ensureActivationRecoverable(ctx context.Context, tx pgx.Tx, record activation.BoundRecord) error {
	var inventoryStatus, deviceStatus, licenseStatus, bindingStatus string
	err := tx.QueryRow(ctx, `SELECT status FROM activation_inventory WHERE id=$1 FOR UPDATE`, record.InventoryID).Scan(&inventoryStatus)
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT status FROM devices WHERE device_id=$1 AND inventory_id=$2 FOR UPDATE`, record.DeviceID, record.InventoryID).Scan(&deviceStatus)
	}
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT status FROM licenses WHERE license_id=$1 AND device_id=$2 FOR UPDATE`, record.LicenseID, record.DeviceID).Scan(&licenseStatus)
	}
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT status FROM new_api_bindings WHERE inventory_id=$1 AND device_id=$2 FOR UPDATE`, record.InventoryID, record.DeviceID).Scan(&bindingStatus)
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return activation.ErrActivationCodeAlreadyBound
		}
		return fmt.Errorf("verify activation recovery status: %w", err)
	}
	if !activationRecoveryAllowed(record, inventoryStatus, deviceStatus, licenseStatus, bindingStatus) {
		return activation.ErrActivationCodeAlreadyBound
	}
	return nil
}

func recordActivationRecovery(ctx context.Context, tx pgx.Tx, record activation.BoundRecord, requestID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO audit_events
		(event_id,actor_type,actor_id,action,outcome,inventory_id,device_id,license_id,request_id,created_at)
		VALUES (gen_random_uuid(),'client',$1,'activation.recovery_authorized','succeeded',$2,$3,$4,$5,clock_timestamp())`,
		record.DeviceID, record.InventoryID, record.DeviceID, record.LicenseID, requestID)
	if err != nil {
		return fmt.Errorf("record activation recovery: %w", err)
	}
	return nil
}

func activationRecoveryAllowed(record activation.BoundRecord, inventoryStatus, deviceStatus, licenseStatus, bindingStatus string) bool {
	if deviceStatus != "active" || bindingStatus != "active" {
		return false
	}
	if record.Stage == "requested" && len(record.ArtifactEnvelope) == 0 {
		return inventoryStatus == "binding" && licenseStatus == "prepared"
	}
	if (record.Stage == "server_bound" || record.Stage == "committed") &&
		len(record.ArtifactEnvelope) > 0 && record.ArtifactKeyVersion != "" {
		return inventoryStatus == "active" && licenseStatus == "active"
	}
	return false
}

func (repository *ActivationRepository) CompleteBinding(ctx context.Context, input activation.CompleteBindingInput) (activation.BoundRecord, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return activation.BoundRecord{}, fmt.Errorf("begin activation completion: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	existing, found, err := loadAttempt(ctx, tx, "attempt.activation_id = $1", input.Record.ActivationID, false)
	if err != nil {
		return activation.BoundRecord{}, err
	}
	if !found {
		return activation.BoundRecord{}, activation.ErrActivationInProgress
	}
	if err = ensureActivationRecoverable(ctx, tx, existing); err != nil {
		return activation.BoundRecord{}, err
	}
	existing, found, err = loadAttempt(ctx, tx, "attempt.activation_id = $1", input.Record.ActivationID, true)
	if err != nil {
		return activation.BoundRecord{}, err
	}
	if !found {
		return activation.BoundRecord{}, activation.ErrActivationInProgress
	}
	if existing.InventoryID != input.Record.InventoryID || existing.DeviceID != input.Record.DeviceID ||
		existing.LicenseID != input.Record.LicenseID {
		return activation.BoundRecord{}, activation.ErrActivationInProgress
	}
	if existing.Stage == "server_bound" || existing.Stage == "committed" {
		if len(existing.ArtifactEnvelope) > 0 && existing.ArtifactKeyVersion != "" {
			if err := tx.Commit(ctx); err != nil {
				return activation.BoundRecord{}, fmt.Errorf("commit completed lookup: %w", err)
			}
			return existing, nil
		}
		return activation.BoundRecord{}, activation.ErrActivationInProgress
	}
	if existing.Stage != "requested" || existing.LeaseToken != input.LeaseToken {
		return activation.BoundRecord{}, activation.ErrActivationInProgress
	}
	record := existing
	record.ArtifactEnvelope = input.Record.ArtifactEnvelope
	record.ArtifactKeyVersion = input.Record.ArtifactKeyVersion
	record.DeviceTokenID = input.Record.DeviceTokenID
	record.DeviceTokenDigest = append([]byte(nil), input.Record.DeviceTokenDigest...)
	if record.DeviceTokenID == "" || len(record.DeviceTokenDigest) != 32 {
		return activation.BoundRecord{}, activation.ErrActivationInProgress
	}
	if _, err := tx.Exec(ctx, `INSERT INTO device_access_tokens
		(device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,'active',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
		record.DeviceTokenID, record.InventoryID, record.DeviceID, record.LicenseID, record.DeviceTokenDigest); err != nil {
		return activation.BoundRecord{}, fmt.Errorf("create activation device token: %w", err)
	}

	var completedAt time.Time
	err = tx.QueryRow(ctx, `UPDATE activation_inventory SET status='active', activated_at=clock_timestamp(),
		binding_lease_token=NULL, binding_lease_expires_at=NULL
		WHERE id=$1 AND status='binding' AND binding_lease_token=$2 RETURNING activated_at`, record.InventoryID, input.LeaseToken).
		Scan(&completedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return activation.BoundRecord{}, activation.ErrActivationInProgress
		}
		return activation.BoundRecord{}, fmt.Errorf("complete activation inventory: %w", err)
	}
	result, err := tx.Exec(ctx, `UPDATE licenses SET status='active',updated_at=$1
		WHERE license_id=$2 AND status='prepared'`, completedAt, record.LicenseID)
	if err != nil {
		return activation.BoundRecord{}, fmt.Errorf("activate license: %w", err)
	}
	if result.RowsAffected() != 1 {
		return activation.BoundRecord{}, activation.ErrActivationInProgress
	}
	result, err = tx.Exec(ctx, `UPDATE activation_attempts SET artifact_envelope=$1, artifact_key_version=$2,
		pending_material_envelope=NULL, pending_material_key_version=NULL, stage='server_bound', updated_at=clock_timestamp()
		WHERE activation_id=$3 AND stage='requested'`, record.ArtifactEnvelope, record.ArtifactKeyVersion, record.ActivationID)
	if err != nil {
		return activation.BoundRecord{}, fmt.Errorf("complete activation attempt: %w", err)
	}
	if result.RowsAffected() != 1 {
		return activation.BoundRecord{}, activation.ErrActivationInProgress
	}
	if _, err := tx.Exec(ctx, `INSERT INTO license_status_events(event_id,license_id,revision,status,created_at)
		VALUES ($1,$2,$3,'active',$4)`, record.StatusEventID, record.LicenseID, record.Revision, completedAt); err != nil {
		return activation.BoundRecord{}, fmt.Errorf("record active license status: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_events
		(event_id,actor_type,actor_id,action,outcome,inventory_id,device_id,license_id,request_id,created_at)
		VALUES ($1,'client',$2,'activation.bound','succeeded',$3,$4,$5,$6,$7)`, record.BoundAuditEventID,
		record.DeviceID, record.InventoryID, record.DeviceID, record.LicenseID, record.RequestID, completedAt); err != nil {
		return activation.BoundRecord{}, fmt.Errorf("record bound activation audit: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE licenses old_license SET replacement_license_id=$1,replacement_inventory_id=NULL,updated_at=$2
		FROM activation_inventory replacement WHERE replacement.id=$3 AND replacement.replaces_license_id=old_license.license_id
		AND old_license.status='reissued' AND old_license.replacement_inventory_id=$3`, record.LicenseID, completedAt, record.InventoryID); err != nil {
		return activation.BoundRecord{}, fmt.Errorf("complete replacement license link: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return activation.BoundRecord{}, fmt.Errorf("commit activation completion: %w", err)
	}
	return record, nil
}

func (repository *ActivationRepository) CommitActivation(ctx context.Context, input activation.CommitInput) error {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin activation commit: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var stage string
	var commitKey *string
	var generation *int64
	err = tx.QueryRow(ctx, `SELECT stage,commit_idempotency_key,artifact_generation FROM activation_attempts WHERE activation_id=$1 FOR UPDATE`, input.ActivationID).
		Scan(&stage, &commitKey, &generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return activation.ErrActivationInvalid
	}
	if err != nil {
		return fmt.Errorf("load activation commit: %w", err)
	}
	if err := validateCommitReplay(stage, commitKey, generation, input); err != nil {
		return err
	}
	if stage == "committed" {
		if commitKey != nil && generation != nil {
			return tx.Commit(ctx)
		}
	}
	if stage != "server_bound" {
		return activation.ErrActivationInProgress
	}
	result, err := tx.Exec(ctx, `UPDATE activation_attempts SET stage='committed',artifact_generation=$1,
		commit_idempotency_key=$2,committed_at=clock_timestamp(),updated_at=clock_timestamp()
		WHERE activation_id=$3 AND stage='server_bound'`, input.ArtifactGeneration, input.IdempotencyKey, input.ActivationID)
	if err != nil {
		return fmt.Errorf("commit activation attempt: %w", err)
	}
	if result.RowsAffected() != 1 {
		return activation.ErrActivationInProgress
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit activation transaction: %w", err)
	}
	return nil
}

func validateCommitReplay(stage string, commitKey *string, generation *int64, input activation.CommitInput) error {
	if stage != "committed" {
		return nil
	}
	if commitKey == nil || generation == nil || *commitKey != input.IdempotencyKey || *generation != input.ArtifactGeneration {
		return activation.ErrIdempotencyConflict
	}
	return nil
}

func resumeExisting(ctx context.Context, tx pgx.Tx, input activation.BeginBindingInput, existing activation.BoundRecord) (activation.BeginBindingResult, error) {
	if !bytes.Equal(existing.RequestFingerprint[:], input.Record.RequestFingerprint[:]) {
		return activation.BeginBindingResult{}, activation.ErrIdempotencyConflict
	}
	if existing.ArtifactEnvelope != nil {
		if err := recordActivationRecovery(ctx, tx, existing, input.Record.RequestID); err != nil {
			return activation.BeginBindingResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return activation.BeginBindingResult{}, fmt.Errorf("commit bound lookup: %w", err)
		}
		existing.RecoveryRequestID = input.Record.RequestID
		return activation.BeginBindingResult{Disposition: activation.BindingBound, Record: existing}, nil
	}
	leaseMicros := input.Record.LeaseExpiresAt.Sub(input.Record.NotBefore).Microseconds()
	var leaseExpiresAt time.Time
	err := tx.QueryRow(ctx, `UPDATE activation_inventory SET binding_lease_token=$1,
		binding_lease_expires_at=clock_timestamp()+$2*interval '1 microsecond'
		WHERE id=$3 AND status='binding' AND binding_lease_token=$4 AND binding_lease_expires_at <= clock_timestamp()
		RETURNING binding_lease_expires_at`, input.Record.LeaseToken, leaseMicros, existing.InventoryID, existing.LeaseToken).
		Scan(&leaseExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return activation.BeginBindingResult{}, activation.ErrActivationInProgress
		}
		return activation.BeginBindingResult{}, fmt.Errorf("renew activation lease: %w", err)
	}
	existing.LeaseToken, existing.LeaseExpiresAt = input.Record.LeaseToken, leaseExpiresAt
	if err := tx.Commit(ctx); err != nil {
		return activation.BeginBindingResult{}, fmt.Errorf("commit activation lease: %w", err)
	}
	return activation.BeginBindingResult{Disposition: activation.BindingAcquired, Record: existing, LeaseRecovered: true}, nil
}

func insertBinding(ctx context.Context, tx pgx.Tx, input activation.BeginBindingInput, record activation.BoundRecord) error {
	leaseMicros := record.LeaseExpiresAt.Sub(record.NotBefore).Microseconds()
	err := tx.QueryRow(ctx, `UPDATE activation_inventory SET status='binding', binding_request_fingerprint=$1,
		binding_lease_token=$2,binding_lease_expires_at=clock_timestamp()+$3*interval '1 microsecond'
		WHERE id=$4 AND status='prepared' RETURNING binding_lease_expires_at`, record.RequestFingerprint[:],
		record.LeaseToken, leaseMicros, record.InventoryID).Scan(&record.LeaseExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return activation.ErrActivationCodeAlreadyBound
		}
		return err
	}
	fingerprint, err := decodeFingerprint(record.FingerprintSHA256)
	if err != nil {
		return activation.ErrActivationInvalid
	}
	if _, err := tx.Exec(ctx, `INSERT INTO devices
		(device_id,inventory_id,fingerprint_version,fingerprint_sha256,status,created_at,updated_at)
		VALUES ($1,$2,$3,$4,'active',clock_timestamp(),clock_timestamp())`, record.DeviceID, record.InventoryID, record.FingerprintVersion,
		fingerprint); err != nil {
		return err
	}
	if err := insertDeviceAliases(ctx, tx, record); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO licenses
		(license_id,device_id,status,revision,key_id,startup_secret_salt,startup_secret_hash,not_before,expires_at,created_at,updated_at)
		VALUES ($1,$2,'prepared',$3,$4,$5,$6,$7,$8,clock_timestamp(),clock_timestamp())`, record.LicenseID, record.DeviceID, record.Revision,
		record.KeyID, record.StartupSecretSalt, record.StartupSecretHash[:], record.NotBefore, record.ExpiresAt); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `UPDATE new_api_bindings SET device_id=$1,updated_at=clock_timestamp()
		WHERE inventory_id=$2 AND device_id IS NULL AND balance_setup_status='configured' AND status='active'`,
		record.DeviceID, record.InventoryID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return activation.ErrNewAPINotConfigured
	}
	if _, err := tx.Exec(ctx, `INSERT INTO activation_attempts
		(activation_id,idempotency_key,inventory_id,device_id,license_id,request_fingerprint,stage,
		pending_material_envelope,pending_material_key_version,request_id,active_status_event_id,bound_audit_event_id,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,'requested',$7,$8,$9,$10,$11,clock_timestamp(),clock_timestamp())`, record.ActivationID, input.IdempotencyKey,
		record.InventoryID, record.DeviceID, record.LicenseID, record.RequestFingerprint[:], record.PendingMaterialEnvelope,
		record.PendingMaterialKeyVersion, record.RequestID, record.StatusEventID, record.BoundAuditEventID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO audit_events
		(event_id,actor_type,actor_id,action,outcome,inventory_id,device_id,license_id,request_id,created_at)
		VALUES ($1,'client',$2,'activation.requested','succeeded',$3,$4,$5,$6,clock_timestamp())`, record.AuditEventID,
		record.DeviceID, record.InventoryID, record.DeviceID, record.LicenseID, record.RequestID)
	return err
}

const attemptSelect = `SELECT attempt.activation_id,attempt.inventory_id,inventory.id,device.device_id,license.license_id,
	inventory.binding_lease_token,inventory.binding_lease_expires_at,attempt.request_fingerprint,
	device.fingerprint_version,encode(device.fingerprint_sha256,'hex'),license.key_id,license.not_before,
	license.expires_at,license.revision,license.startup_secret_salt,license.startup_secret_hash,
	attempt.pending_material_envelope,attempt.pending_material_key_version,attempt.artifact_envelope,attempt.artifact_key_version,attempt.stage,
	attempt.request_id,attempt.active_status_event_id,attempt.bound_audit_event_id,binding.default_model
	FROM activation_attempts attempt JOIN activation_inventory inventory ON inventory.id=attempt.inventory_id
	JOIN devices device ON device.device_id=attempt.device_id JOIN licenses license ON license.license_id=attempt.license_id
	JOIN new_api_bindings binding ON binding.inventory_id=attempt.inventory_id AND binding.device_id=attempt.device_id`

func loadAttempt(ctx context.Context, tx pgx.Tx, where string, argument any, lock bool) (activation.BoundRecord, bool, error) {
	query := attemptSelect + " WHERE " + where
	if lock {
		query += " FOR UPDATE OF attempt"
	}
	record, found, err := scanAttempt(tx.QueryRow(ctx, query, argument))
	if err != nil || !found {
		return record, found, err
	}
	if err := loadDeviceAliases(ctx, tx, &record); err != nil {
		return activation.BoundRecord{}, false, err
	}
	return record, true, nil
}

func loadAttemptByInventoryAndDevice(ctx context.Context, tx pgx.Tx, inventoryID string, record activation.BoundRecord) (activation.BoundRecord, bool, error) {
	fingerprint, err := decodeFingerprint(record.FingerprintSHA256)
	if err != nil {
		return activation.BoundRecord{}, false, activation.ErrActivationInvalid
	}
	matched, found, err := scanAttempt(tx.QueryRow(ctx, attemptSelect+` WHERE attempt.inventory_id=$1 AND device.fingerprint_version=$2
		AND device.fingerprint_sha256=$3 AND inventory.status='active' AND device.status='active'
		AND license.status='active' AND EXISTS (SELECT 1 FROM new_api_bindings binding
		WHERE binding.inventory_id=inventory.id AND binding.device_id=device.device_id AND binding.status='active')
		ORDER BY attempt.created_at DESC LIMIT 1`, inventoryID,
		record.FingerprintVersion, fingerprint))
	if err != nil || found {
		if found {
			if err := loadDeviceAliases(ctx, tx, &matched); err != nil {
				return activation.BoundRecord{}, false, err
			}
		}
		return matched, found, err
	}
	for _, alias := range record.DeviceAliases {
		matched, found, err = loadAttemptByInventoryAndAlias(ctx, tx, inventoryID, alias)
		if err != nil || found {
			if found {
				if err := loadDeviceAliases(ctx, tx, &matched); err != nil {
					return activation.BoundRecord{}, false, err
				}
			}
			return matched, found, err
		}
	}
	return activation.BoundRecord{}, false, nil
}

func loadAttemptByInventoryAndAlias(ctx context.Context, tx pgx.Tx, inventoryID string, alias activation.DeviceAliasInput) (activation.BoundRecord, bool, error) {
	fingerprint, err := decodeFingerprint(alias.Fingerprint.SHA256)
	if err != nil {
		return activation.BoundRecord{}, false, activation.ErrActivationInvalid
	}
	return scanAttempt(tx.QueryRow(ctx, attemptSelect+` JOIN device_aliases alias
		ON alias.inventory_id=inventory.id AND alias.device_id=device.device_id
		WHERE attempt.inventory_id=$1 AND alias.target=$2 AND alias.fingerprint_version=$3
		AND alias.fingerprint_sha256=$4 AND inventory.status='active' AND device.status='active'
		AND license.status='active' AND EXISTS (SELECT 1 FROM new_api_bindings binding
		WHERE binding.inventory_id=inventory.id AND binding.device_id=device.device_id AND binding.status='active')
		ORDER BY attempt.created_at DESC LIMIT 1`, inventoryID,
		alias.Target, alias.Fingerprint.Version, fingerprint))
}

type deviceAliasEvidenceRecord struct {
	Target                 string `json:"target"`
	Platform               string `json:"platform"`
	Arch                   string `json:"arch"`
	Source                 string `json:"source"`
	BusType                string `json:"busType,omitempty"`
	BusProtocol            string `json:"busProtocol,omitempty"`
	DeviceLocation         string `json:"deviceLocation,omitempty"`
	Vendor                 string `json:"vendor"`
	Product                string `json:"product"`
	Revision               string `json:"revision,omitempty"`
	Serial                 string `json:"serial"`
	CapacityBytes          int64  `json:"capacityBytes"`
	UniqueDescriptorSHA256 string `json:"uniqueDescriptorSha256,omitempty"`
	VolumeUUID             string `json:"volumeUuid,omitempty"`
	MediaUUID              string `json:"mediaUuid,omitempty"`
}

func insertDeviceAliases(ctx context.Context, tx pgx.Tx, record activation.BoundRecord) error {
	for _, alias := range record.DeviceAliases {
		fingerprint, err := decodeFingerprint(alias.Fingerprint.SHA256)
		if err != nil {
			return activation.ErrActivationInvalid
		}
		evidence, err := json.Marshal(deviceAliasEvidenceRecord{
			Target: alias.Evidence.Target, Platform: alias.Evidence.Platform, Arch: alias.Evidence.Arch, Source: alias.Evidence.Source,
			BusType: alias.Evidence.BusType, BusProtocol: alias.Evidence.BusProtocol, DeviceLocation: alias.Evidence.DeviceLocation,
			Vendor: alias.Evidence.Vendor, Product: alias.Evidence.Product, Revision: alias.Evidence.Revision,
			Serial: alias.Evidence.Serial, CapacityBytes: alias.Evidence.CapacityBytes,
			UniqueDescriptorSHA256: alias.Evidence.UniqueDescriptorSHA256, VolumeUUID: alias.Evidence.VolumeUUID, MediaUUID: alias.Evidence.MediaUUID,
		})
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO device_aliases
			(inventory_id,device_id,target,fingerprint_version,fingerprint_sha256,evidence,created_at)
			VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`,
			record.InventoryID, record.DeviceID, alias.Target, alias.Fingerprint.Version, fingerprint, evidence); err != nil {
			return err
		}
	}
	return nil
}

type deviceAliasQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func loadDeviceAliases(ctx context.Context, queryer deviceAliasQueryer, record *activation.BoundRecord) error {
	rows, err := queryer.Query(ctx, `SELECT target,fingerprint_version,encode(fingerprint_sha256,'hex'),evidence
		FROM device_aliases WHERE inventory_id=$1 AND device_id=$2 ORDER BY target`, record.InventoryID, record.DeviceID)
	if err != nil {
		return fmt.Errorf("load device aliases: %w", err)
	}
	defer rows.Close()
	var aliases []activation.DeviceAliasInput
	for rows.Next() {
		var alias activation.DeviceAliasInput
		var evidence []byte
		if err := rows.Scan(&alias.Target, &alias.Fingerprint.Version, &alias.Fingerprint.SHA256, &evidence); err != nil {
			return fmt.Errorf("scan device alias: %w", err)
		}
		decoder := json.NewDecoder(bytes.NewReader(evidence))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&alias.Evidence); err != nil {
			return fmt.Errorf("decode device alias evidence: %w", err)
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return fmt.Errorf("decode device alias evidence: %w", err)
		}
		aliases = append(aliases, alias)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("scan device aliases: %w", err)
	}
	record.DeviceAliases = aliases
	return nil
}

type rowScanner interface{ Scan(...any) error }

func scanAttempt(row rowScanner) (activation.BoundRecord, bool, error) {
	var record activation.BoundRecord
	var leaseToken *string
	var leaseExpiry *time.Time
	var requestFingerprint, startupHash []byte
	var pendingVersion, artifactVersion *string
	err := row.Scan(&record.ActivationID, &record.InventoryID, &record.UsernameID, &record.DeviceID, &record.LicenseID,
		&leaseToken, &leaseExpiry, &requestFingerprint, &record.FingerprintVersion, &record.FingerprintSHA256,
		&record.KeyID, &record.NotBefore, &record.ExpiresAt, &record.Revision, &record.StartupSecretSalt, &startupHash,
		&record.PendingMaterialEnvelope, &pendingVersion, &record.ArtifactEnvelope, &artifactVersion, &record.Stage,
		&record.RequestID, &record.StatusEventID, &record.BoundAuditEventID, &record.DefaultModel)
	if errors.Is(err, pgx.ErrNoRows) {
		return activation.BoundRecord{}, false, nil
	}
	if err != nil {
		return activation.BoundRecord{}, false, fmt.Errorf("load activation attempt: %w", err)
	}
	copy(record.RequestFingerprint[:], requestFingerprint)
	copy(record.StartupSecretHash[:], startupHash)
	if leaseToken != nil {
		record.LeaseToken = *leaseToken
	}
	if leaseExpiry != nil {
		record.LeaseExpiresAt = *leaseExpiry
	}
	if pendingVersion != nil {
		record.PendingMaterialKeyVersion = *pendingVersion
	}
	if artifactVersion != nil {
		record.ArtifactKeyVersion = *artifactVersion
	}
	return record, true, nil
}

func mapBindingError(err error) error {
	if errors.Is(err, activation.ErrActivationCodeAlreadyBound) || errors.Is(err, activation.ErrNewAPINotConfigured) {
		return err
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		switch postgresError.ConstraintName {
		case "activation_attempts_idempotency_key_key":
			return activation.ErrIdempotencyConflict
		case "devices_fingerprint_version_fingerprint_sha256_key", "device_aliases_target_fingerprint_unique":
			return activation.ErrActivationCodeAlreadyBound
		}
	}
	return fmt.Errorf("persist activation binding: %w", err)
}

func decodeFingerprint(value string) ([]byte, error) {
	if len(value) != 64 {
		return nil, errors.New("invalid fingerprint")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || hex.EncodeToString(decoded) != value {
		return nil, errors.New("invalid fingerprint")
	}
	return decoded, nil
}
