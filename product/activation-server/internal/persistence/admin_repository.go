package persistence

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"u-claw-activation-server/internal/admin"
)

func (repository *ActivationRepository) PrepareReissueTarget(ctx context.Context, mutation admin.Mutation) (admin.ReissueTarget, error) {
	fingerprint := adminFingerprint("license.reissue", mutation.Operation, mutation.LicenseID)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return admin.ReissueTarget{}, fmt.Errorf("begin reissue prepare: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var replay admin.MutationResult
	completed, err := claimAdminOperation(ctx, tx, "license.reissue", mutation.Operation, fingerprint, &replay)
	if err != nil {
		return admin.ReissueTarget{}, err
	}
	var target admin.ReissueTarget
	var status string
	err = tx.QueryRow(ctx, `SELECT inventory.username_display,license.revision,license.status
		FROM licenses license JOIN devices device ON device.device_id=license.device_id
		JOIN activation_inventory inventory ON inventory.id=device.inventory_id WHERE license.license_id=$1`, mutation.LicenseID).
		Scan(&target.Username, &target.Revision, &status)
	if completed && status == "reissued" {
		target.Revision = replay.Revision - 1
		if err = tx.Commit(ctx); err != nil {
			return admin.ReissueTarget{}, fmt.Errorf("commit reissue replay prepare: %w", err)
		}
		return target, nil
	}
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && status != "active" && status != "disabled") {
		return admin.ReissueTarget{}, admin.ErrInvalidInput
	}
	if err != nil {
		return admin.ReissueTarget{}, fmt.Errorf("prepare reissue target: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return admin.ReissueTarget{}, fmt.Errorf("commit reissue prepare: %w", err)
	}
	return target, nil
}

func (repository *ActivationRepository) Audit(ctx context.Context, query admin.AuditQuery) ([]admin.AuditEvent, error) {
	rows, err := repository.pool.Query(ctx, `SELECT event_id,COALESCE(actor_id,''),action,outcome,inventory_id,device_id,license_id,request_id,reason,idempotency_key,created_at
		FROM audit_events WHERE ($1::timestamptz IS NULL OR (created_at,event_id) < ($1::timestamptz,$2::uuid))
		ORDER BY created_at DESC,event_id DESC LIMIT $3`, auditBeforeTime(query.Before), auditBeforeID(query.Before), query.Limit)
	if err != nil {
		return nil, fmt.Errorf("query admin audit: %w", err)
	}
	defer rows.Close()
	result := make([]admin.AuditEvent, 0, query.Limit)
	for rows.Next() {
		var event admin.AuditEvent
		var createdAt time.Time
		if err = rows.Scan(&event.EventID, &event.ActorID, &event.Action, &event.Outcome, &event.InventoryID, &event.DeviceID, &event.LicenseID, &event.RequestID, &event.Reason, &event.IdempotencyKey, &createdAt); err != nil {
			return nil, fmt.Errorf("scan admin audit: %w", err)
		}
		event.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		result = append(result, event)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read admin audit: %w", err)
	}
	return result, nil
}

func auditBeforeTime(cursor *admin.AuditCursor) any {
	if cursor == nil {
		return nil
	}
	return cursor.CreatedAt
}

func auditBeforeID(cursor *admin.AuditCursor) any {
	if cursor == nil {
		return nil
	}
	return cursor.EventID
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (repository *ActivationRepository) CreateInventory(ctx context.Context, records []admin.InventoryRecord, operation admin.Operation) ([]admin.InventorySummary, error) {
	fingerprint := adminFingerprint("inventory.create", operation, records)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin admin inventory: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var replay []admin.InventorySummary
	if found, claimErr := claimAdminOperation(ctx, tx, "inventory.create", operation, fingerprint, &replay); claimErr != nil || found {
		if errors.Is(claimErr, admin.ErrInvalidInput) {
			_ = tx.Rollback(ctx)
			claimErr = repository.adminFailure(ctx, "inventory.create", operation, nil, claimErr)
		}
		return replay, claimErr
	}
	result := make([]admin.InventorySummary, len(records))
	for index, record := range records {
		userID, userName, policy := record.NewAPIUserID, record.NewAPIUsername, record.PolicyDigest
		if userID == "" {
			userID = "usr_" + strings.ReplaceAll(record.InventoryID, "-", "")
		}
		if userName == "" {
			userName = "uclaw_" + strings.ReplaceAll(record.InventoryID, "-", "")
		}
		if len(policy) == 0 {
			sum := sha256.Sum256([]byte("uclaw-default-policy-v1"))
			policy = sum[:]
		}
		_, err = tx.Exec(ctx, `INSERT INTO activation_inventory(id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at)
			VALUES($1,$2,$3,$4,'prepared','pending',clock_timestamp())`, record.InventoryID, record.Username, record.UsernameDisplay, record.ActivationCodeDigest)
		if err != nil {
			mapped := mapAdminWriteError(err)
			if errors.Is(mapped, admin.ErrInvalidInput) {
				_ = tx.Rollback(ctx)
				mapped = repository.adminFailure(ctx, "inventory.create", operation, nil, mapped)
			}
			return nil, mapped
		}
		_, err = tx.Exec(ctx, `INSERT INTO new_api_bindings(inventory_id,new_api_user_id,new_api_username,balance_setup_status,status,policy_digest,created_at,updated_at)
			VALUES($1,$2,$3,'pending','active',$4,clock_timestamp(),clock_timestamp())`, record.InventoryID, userID, userName, policy)
		if err != nil {
			mapped := mapAdminWriteError(err)
			if errors.Is(mapped, admin.ErrInvalidInput) {
				_ = tx.Rollback(ctx)
				mapped = repository.adminFailure(ctx, "inventory.create", operation, nil, mapped)
			}
			return nil, mapped
		}
		result[index] = admin.InventorySummary{InventoryID: record.InventoryID, Username: record.UsernameDisplay, Status: "prepared", NewAPISetupStatus: "pending"}
	}
	if err = recordAdminSuccess(ctx, tx, "inventory.create", operation, nil, nil, nil, fingerprint, result); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit admin inventory: %w", err)
	}
	return result, nil
}

func (repository *ActivationRepository) ShowInventory(ctx context.Context, locator admin.InventoryLocator) (admin.InventorySummary, error) {
	query := `SELECT inventory.id,inventory.username_display,inventory.status,inventory.new_api_setup_status,device.device_id,license.license_id
		FROM activation_inventory inventory LEFT JOIN devices device ON device.inventory_id=inventory.id
		LEFT JOIN licenses license ON license.device_id=device.device_id AND license.status IN ('active','disabled','revoked','reissued') WHERE `
	condition, value := inventoryLookup(locator)
	query += condition
	var result admin.InventorySummary
	err := repository.pool.QueryRow(ctx, query, value).Scan(&result.InventoryID, &result.Username, &result.Status, &result.NewAPISetupStatus, &result.DeviceID, &result.LicenseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, admin.ErrInvalidInput
	}
	if err != nil {
		return result, fmt.Errorf("show admin inventory: %w", err)
	}
	return result, nil
}

func inventoryLookup(locator admin.InventoryLocator) (string, string) {
	switch {
	case locator.InventoryID != "":
		return "inventory.id=$1", locator.InventoryID
	case locator.Username != "":
		return "inventory.username_normalized=$1", strings.ToUpper(locator.Username)
	default:
		return "device.device_id=$1", locator.DeviceID
	}
}

func (repository *ActivationRepository) MarkConfigured(ctx context.Context, locator admin.InventoryLocator, operation admin.Operation) (admin.InventorySummary, error) {
	fingerprint := adminFingerprint("new-api.mark-configured", operation, locator)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return admin.InventorySummary{}, fmt.Errorf("begin mark configured: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var replay admin.InventorySummary
	if found, claimErr := claimAdminOperation(ctx, tx, "new-api.mark-configured", operation, fingerprint, &replay); claimErr != nil || found {
		if errors.Is(claimErr, admin.ErrInvalidInput) {
			_ = tx.Rollback(ctx)
			claimErr = repository.adminFailure(ctx, "new-api.mark-configured", operation, nil, claimErr)
		}
		return replay, claimErr
	}
	condition, value := "inventory.id=$1", locator.InventoryID
	if locator.DeviceID != "" {
		condition = "device.device_id=$1"
		value = locator.DeviceID
	}
	var id, username, status string
	err = tx.QueryRow(ctx, `SELECT inventory.id,inventory.username_display,inventory.status FROM activation_inventory inventory LEFT JOIN devices device ON device.inventory_id=inventory.id WHERE `+condition+` FOR UPDATE OF inventory`, value).Scan(&id, &username, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return replay, repository.adminFailure(ctx, "new-api.mark-configured", operation, nil, admin.ErrInvalidInput)
	}
	if err != nil {
		return replay, fmt.Errorf("lock configured inventory: %w", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE activation_inventory SET new_api_setup_status='configured' WHERE id=$1`, id); err != nil {
		return replay, err
	}
	if _, err = tx.Exec(ctx, `UPDATE new_api_bindings SET balance_setup_status='configured',updated_at=clock_timestamp() WHERE inventory_id=$1`, id); err != nil {
		return replay, err
	}
	replay = admin.InventorySummary{InventoryID: id, Username: username, Status: status, NewAPISetupStatus: "configured"}
	if err = recordAdminSuccess(ctx, tx, "new-api.mark-configured", operation, &id, nil, nil, fingerprint, replay); err != nil {
		return replay, err
	}
	if err = tx.Commit(ctx); err != nil {
		return replay, err
	}
	return replay, nil
}

func (repository *ActivationRepository) SetMapping(ctx context.Context, input admin.MappingInput) (admin.MappingSummary, error) {
	action := "new-api.mapping.set"
	fingerprint := adminFingerprint(action, input.Operation, struct {
		InventoryID, NewAPIUserID, NewAPIUsername, BaseURL, DefaultModel, KeyVersion string
		AllowedModels                                                                []string
		RequestsPerMinute, ConcurrentRequests                                        int
		APIKeyFingerprint                                                            []byte
	}{input.InventoryID, input.NewAPIUserID, input.NewAPIUsername, input.BaseURL, input.DefaultModel, input.KeyVersion, input.AllowedModels, input.RequestsPerMinute, input.ConcurrentRequests, input.APIKeyFingerprint})
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return admin.MappingSummary{}, fmt.Errorf("begin mapping set: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var replay admin.MappingSummary
	if found, claimErr := claimAdminOperation(ctx, tx, action, input.Operation, fingerprint, &replay); claimErr != nil || found {
		return replay, claimErr
	}
	var exists string
	if err = tx.QueryRow(ctx, `SELECT id FROM activation_inventory WHERE id=$1 FOR UPDATE`, input.InventoryID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return replay, admin.ErrInvalidInput
	}
	if err != nil {
		return replay, err
	}
	tag, err := tx.Exec(ctx, `UPDATE new_api_bindings SET new_api_user_id=$2,new_api_username=$3,api_key_envelope=$4,api_key_version=$5,base_url=$6,default_model=$7,allowed_models=$8,requests_per_minute=$9,concurrent_requests=$10,balance_setup_status='configured',updated_at=clock_timestamp() WHERE inventory_id=$1`, input.InventoryID, input.NewAPIUserID, input.NewAPIUsername, input.APIKeyEnvelope, input.KeyVersion, input.BaseURL, input.DefaultModel, input.AllowedModels, input.RequestsPerMinute, input.ConcurrentRequests)
	if err != nil {
		return replay, mapAdminWriteError(err)
	}
	if tag.RowsAffected() != 1 {
		return replay, admin.ErrInvalidInput
	}
	if _, err = tx.Exec(ctx, `UPDATE activation_inventory SET new_api_setup_status='configured' WHERE id=$1`, input.InventoryID); err != nil {
		return replay, err
	}
	replay = admin.MappingSummary{InventoryID: input.InventoryID, NewAPIUserID: input.NewAPIUserID, NewAPIUsername: input.NewAPIUsername, BaseURLHost: hostOnly(input.BaseURL), DefaultModel: input.DefaultModel, AllowedModels: input.AllowedModels, RequestsPerMinute: input.RequestsPerMinute, ConcurrentRequests: input.ConcurrentRequests, KeyVersion: input.KeyVersion, Status: "configured"}
	if err = recordAdminSuccess(ctx, tx, action, input.Operation, &input.InventoryID, nil, nil, fingerprint, replay); err != nil {
		return replay, err
	}
	if err = tx.Commit(ctx); err != nil {
		return replay, err
	}
	return replay, nil
}

func (repository *ActivationRepository) ShowMapping(ctx context.Context, inventoryID string) (admin.MappingSummary, error) {
	var result admin.MappingSummary
	var baseURL string
	var updated time.Time
	err := repository.pool.QueryRow(ctx, `SELECT inventory_id,new_api_user_id,new_api_username,base_url,default_model,allowed_models,requests_per_minute,concurrent_requests,api_key_version,status,updated_at FROM new_api_bindings WHERE inventory_id=$1 AND api_key_envelope IS NOT NULL`, inventoryID).Scan(&result.InventoryID, &result.NewAPIUserID, &result.NewAPIUsername, &baseURL, &result.DefaultModel, &result.AllowedModels, &result.RequestsPerMinute, &result.ConcurrentRequests, &result.KeyVersion, &result.Status, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, admin.ErrInvalidInput
	}
	if err != nil {
		return result, fmt.Errorf("show mapping: %w", err)
	}
	result.BaseURLHost = hostOnly(baseURL)
	result.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return result, nil
}

func (repository *ActivationRepository) MutateDeviceToken(ctx context.Context, mutation admin.DeviceTokenMutation) (admin.DeviceTokenResult, error) {
	action := "device-token." + string(mutation.Action)
	fingerprint := adminFingerprint(action, mutation.Operation, mutation.LicenseID)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return admin.DeviceTokenResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var replay admin.DeviceTokenResult
	if found, claimErr := claimAdminOperation(ctx, tx, action, mutation.Operation, fingerprint, &replay); claimErr != nil || found {
		return replay, claimErr
	}
	var tokenID, inventoryID, deviceID, status string
	err = tx.QueryRow(ctx, `SELECT token.device_token_id,token.inventory_id,token.device_id,token.status FROM device_access_tokens token JOIN licenses license ON license.license_id=token.license_id AND license.device_id=token.device_id JOIN devices device ON device.device_id=token.device_id AND device.inventory_id=token.inventory_id JOIN new_api_bindings binding ON binding.inventory_id=token.inventory_id AND binding.device_id=token.device_id WHERE token.license_id=$1 AND license.status='active' AND device.status='active' AND binding.status='active' ORDER BY token.issued_at DESC LIMIT 1 FOR UPDATE OF token`, mutation.LicenseID).Scan(&tokenID, &inventoryID, &deviceID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return replay, admin.ErrInvalidInput
	}
	if err != nil {
		return replay, err
	}
	target := string(mutation.Action)
	if mutation.Action == admin.DeviceTokenDisable && status != "active" || mutation.Action == admin.DeviceTokenEnable && status != "disabled" || mutation.Action == admin.DeviceTokenRevoke && status == "revoked" || mutation.Action == admin.DeviceTokenReissue && status != "active" {
		return replay, admin.ErrInvalidInput
	}
	if mutation.Action == admin.DeviceTokenReissue {
		if len(mutation.ReplacementDigest) != 32 || mutation.ReplacementTokenID == "" {
			return replay, admin.ErrInvalidInput
		}
		if _, err = tx.Exec(ctx, `UPDATE device_access_tokens SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE device_token_id=$1`, tokenID); err != nil {
			return replay, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO device_access_tokens(device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,revoked_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',clock_timestamp(),NULL,clock_timestamp(),clock_timestamp())`, mutation.ReplacementTokenID, inventoryID, deviceID, mutation.LicenseID, mutation.ReplacementDigest); err != nil {
			return replay, mapAdminWriteError(err)
		}
		tokenID = mutation.ReplacementTokenID
		target = "active"
	} else {
		revokedAt := "NULL"
		if mutation.Action == admin.DeviceTokenRevoke {
			revokedAt = "clock_timestamp()"
		}
		if _, err = tx.Exec(ctx, `UPDATE device_access_tokens SET status=$2,revoked_at=`+revokedAt+`,updated_at=clock_timestamp() WHERE device_token_id=$1`, tokenID, target); err != nil {
			return replay, err
		}
	}
	replay = admin.DeviceTokenResult{DeviceTokenID: tokenID, InventoryID: inventoryID, DeviceID: deviceID, LicenseID: mutation.LicenseID, Status: target}
	if err = recordAdminSuccess(ctx, tx, action, mutation.Operation, &inventoryID, &deviceID, &mutation.LicenseID, fingerprint, replay); err != nil {
		return replay, err
	}
	if err = tx.Commit(ctx); err != nil {
		return replay, err
	}
	return replay, nil
}

func (repository *ActivationRepository) PrepareDeviceTokenTarget(ctx context.Context, licenseID string) (admin.DeviceTokenResult, error) {
	var result admin.DeviceTokenResult
	err := repository.pool.QueryRow(ctx, `SELECT token.inventory_id,token.device_id,token.license_id,token.status FROM device_access_tokens token JOIN licenses license ON license.license_id=token.license_id AND license.device_id=token.device_id JOIN devices device ON device.device_id=token.device_id AND device.inventory_id=token.inventory_id JOIN new_api_bindings binding ON binding.inventory_id=token.inventory_id AND binding.device_id=token.device_id WHERE token.license_id=$1 AND token.status='active' AND license.status='active' AND device.status='active' AND binding.status='active' ORDER BY token.issued_at DESC LIMIT 1`, licenseID).Scan(&result.InventoryID, &result.DeviceID, &result.LicenseID, &result.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, admin.ErrInvalidInput
	}
	if err != nil {
		return result, fmt.Errorf("prepare device token target: %w", err)
	}
	return result, nil
}

func hostOnly(raw string) string {
	start := strings.Index(raw, "://")
	if start < 0 {
		return ""
	}
	host := raw[start+3:]
	if slash := strings.IndexByte(host, '/'); slash >= 0 {
		host = host[:slash]
	}
	return host
}

func (repository *ActivationRepository) Mutate(ctx context.Context, mutation admin.Mutation) (admin.MutationResult, error) {
	action := "license." + string(mutation.Action)
	fingerprint := adminFingerprint(action, mutation.Operation, mutation.LicenseID)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return admin.MutationResult{}, fmt.Errorf("begin admin mutation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var replay admin.MutationResult
	if found, claimErr := claimAdminOperation(ctx, tx, action, mutation.Operation, fingerprint, &replay); claimErr != nil || found {
		if claimErr != nil && errors.Is(claimErr, admin.ErrInvalidInput) {
			_ = tx.Rollback(ctx)
			claimErr = repository.adminFailure(ctx, action, mutation.Operation, &mutation.LicenseID, claimErr)
		}
		return replay, claimErr
	}
	var deviceID, inventoryID, status, usernameDisplay, usernameNormalized string
	var revision int64
	err = tx.QueryRow(ctx, `SELECT license.device_id,device.inventory_id FROM licenses license
		JOIN devices device ON device.device_id=license.device_id WHERE license.license_id=$1`, mutation.LicenseID).
		Scan(&deviceID, &inventoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return replay, repository.adminFailure(ctx, action, mutation.Operation, nil, admin.ErrInvalidInput)
	}
	if err != nil {
		return replay, fmt.Errorf("load admin mutation scope: %w", err)
	}
	err = tx.QueryRow(ctx, `SELECT username_display,username_normalized FROM activation_inventory WHERE id=$1 FOR UPDATE`, inventoryID).
		Scan(&usernameDisplay, &usernameNormalized)
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT device_id FROM devices WHERE device_id=$1 AND inventory_id=$2 FOR UPDATE`, deviceID, inventoryID).Scan(&deviceID)
	}
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT status,revision FROM licenses WHERE license_id=$1 AND device_id=$2 FOR UPDATE`, mutation.LicenseID, deviceID).Scan(&status, &revision)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return replay, repository.adminFailure(ctx, action, mutation.Operation, nil, admin.ErrInvalidInput)
	}
	if err != nil {
		return replay, fmt.Errorf("lock admin mutation scope: %w", err)
	}
	target := map[admin.Action]string{admin.ActionDisable: "disabled", admin.ActionEnable: "active", admin.ActionRevoke: "revoked", admin.ActionReissue: "reissued"}[mutation.Action]
	if !validAdminTransition(status, target) {
		_ = tx.Rollback(ctx)
		return replay, repository.adminFailure(ctx, action, mutation.Operation, &mutation.LicenseID, admin.ErrInvalidInput)
	}
	revision++
	var replacementID *string
	if mutation.Action == admin.ActionReissue {
		if mutation.Replacement == nil {
			_ = tx.Rollback(ctx)
			return replay, repository.adminFailure(ctx, action, mutation.Operation, &mutation.LicenseID, admin.ErrInvalidInput)
		}
		id := mutation.Replacement.InventoryID
		replacementID = &id
		suffix := fmt.Sprintf("-r%d", revision)
		normalized := strings.ToUpper(trimIdentifier(usernameNormalized, len(suffix)) + suffix)
		display := trimIdentifier(usernameDisplay, len(suffix)) + suffix
		if mutation.Replacement.EntitlementRevision != revision || mutation.Replacement.Username != normalized || mutation.Replacement.UsernameDisplay != display {
			_ = tx.Rollback(ctx)
			if auditErr := repository.auditAdminFailure(ctx, action, mutation.Operation, &mutation.LicenseID); auditErr != nil {
				return replay, auditErr
			}
			return replay, admin.ErrInvalidInput
		}
		_, err = tx.Exec(ctx, `INSERT INTO activation_inventory(id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,replaces_license_id,entitlement_revision,created_at) VALUES($1,$2,$3,$4,'prepared','pending',$5,$6,clock_timestamp())`, id, normalized, display, mutation.Replacement.ActivationCodeDigest, mutation.LicenseID, revision)
		if err != nil {
			mapped := mapAdminWriteError(err)
			if errors.Is(mapped, admin.ErrInvalidInput) {
				_ = tx.Rollback(ctx)
				mapped = repository.adminFailure(ctx, action, mutation.Operation, &mutation.LicenseID, mapped)
			}
			return replay, mapped
		}
		var oldUserID, oldAPIUsername string
		var policy []byte
		err = tx.QueryRow(ctx, `SELECT new_api_user_id,new_api_username,policy_digest FROM new_api_bindings WHERE inventory_id=$1`, inventoryID).Scan(&oldUserID, &oldAPIUsername, &policy)
		if err != nil {
			return replay, fmt.Errorf("load replacement binding: %w", err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO new_api_bindings(inventory_id,new_api_user_id,new_api_username,balance_setup_status,status,policy_digest,created_at,updated_at) VALUES($1,$2,$3,'pending','active',$4,clock_timestamp(),clock_timestamp())`, id, trimIdentifier(oldUserID, len(suffix))+suffix, trimIdentifier(oldAPIUsername, len(suffix))+suffix, policy)
		if err != nil {
			mapped := mapAdminWriteError(err)
			if errors.Is(mapped, admin.ErrInvalidInput) {
				_ = tx.Rollback(ctx)
				mapped = repository.adminFailure(ctx, action, mutation.Operation, &mutation.LicenseID, mapped)
			}
			return replay, mapped
		}
	}
	_, err = tx.Exec(ctx, `UPDATE licenses SET status=$1,revision=$2,replacement_inventory_id=$3,updated_at=clock_timestamp() WHERE license_id=$4`, target, revision, replacementID, mutation.LicenseID)
	if err != nil {
		return replay, err
	}
	deviceStatus := target
	if mutation.Action == admin.ActionEnable {
		deviceStatus = "active"
	}
	_, err = tx.Exec(ctx, `UPDATE devices SET status=$1,updated_at=clock_timestamp() WHERE device_id=$2`, deviceStatus, deviceID)
	if err != nil {
		return replay, err
	}
	if mutation.Action != admin.ActionEnable {
		_, err = tx.Exec(ctx, `UPDATE token_grants SET status='revoked',revoked_at=clock_timestamp() WHERE license_id=$1 AND status='active'`, mutation.LicenseID)
		if err != nil {
			return replay, err
		}
	}
	bindingStatus := map[admin.Action]string{admin.ActionDisable: "disabled", admin.ActionEnable: "active", admin.ActionRevoke: "revoked", admin.ActionReissue: "revoked"}[mutation.Action]
	if _, err = tx.Exec(ctx, `UPDATE new_api_bindings SET status=$1,updated_at=clock_timestamp() WHERE inventory_id=$2`, bindingStatus, inventoryID); err != nil {
		return replay, err
	}
	if mutation.Action == admin.ActionRevoke || mutation.Action == admin.ActionReissue {
		_, err = tx.Exec(ctx, `UPDATE activation_inventory SET status='revoked' WHERE id=$1`, inventoryID)
		if err != nil {
			return replay, err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO license_status_events(event_id,license_id,revision,status,replacement_inventory_id,created_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,clock_timestamp())`, mutation.LicenseID, revision, target, replacementID)
	if err != nil {
		return replay, err
	}
	replay = admin.MutationResult{LicenseID: mutation.LicenseID, Status: target, Revision: revision, ReplacementInventoryID: replacementID}
	if err = recordAdminSuccess(ctx, tx, action, mutation.Operation, &inventoryID, &deviceID, &mutation.LicenseID, fingerprint, replay); err != nil {
		return replay, err
	}
	if err = tx.Commit(ctx); err != nil {
		return replay, fmt.Errorf("commit admin mutation: %w", err)
	}
	return replay, nil
}

func adminFingerprint(action string, operation admin.Operation, payload any) []byte {
	encoded, _ := json.Marshal([]any{"uclaw-admin-v1", action, operation.OperatorID, operation.Reason, payload})
	sum := sha256.Sum256(encoded)
	return sum[:]
}
func claimAdminOperation(ctx context.Context, tx pgx.Tx, action string, operation admin.Operation, fingerprint []byte, result any) (bool, error) {
	if _, err := tx.Exec(ctx, `INSERT INTO admin_operations(idempotency_key,request_fingerprint,operator_id,request_id,action,status,result,created_at)
		VALUES($1,$2,$3,$4,$5,'pending',NULL,clock_timestamp()) ON CONFLICT (idempotency_key) DO NOTHING`, operation.IdempotencyKey, fingerprint, operation.OperatorID, operation.RequestID, action); err != nil {
		return false, err
	}
	var stored []byte
	var encoded []byte
	var status string
	err := tx.QueryRow(ctx, `SELECT request_fingerprint,status,result FROM admin_operations WHERE idempotency_key=$1 FOR UPDATE`, operation.IdempotencyKey).Scan(&stored, &status, &encoded)
	if err != nil {
		return false, err
	}
	if !equalBytes(stored, fingerprint) {
		return false, admin.ErrInvalidInput
	}
	if status == "pending" {
		return false, nil
	}
	if status != "completed" || len(encoded) == 0 {
		return false, admin.ErrInvalidInput
	}
	if err = json.Unmarshal(encoded, result); err != nil {
		return false, fmt.Errorf("decode admin replay: %w", err)
	}
	return true, nil
}
func recordAdminSuccess(ctx context.Context, tx pgx.Tx, action string, operation admin.Operation, inventoryID, deviceID, licenseID *string, fingerprint []byte, result any) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_events(event_id,actor_type,actor_id,action,outcome,inventory_id,device_id,license_id,request_id,reason,idempotency_key,created_at) VALUES(gen_random_uuid(),'operator',$1,$2,'succeeded',$3,$4,$5,$6,$7,$8,clock_timestamp())`, operation.OperatorID, action, inventoryID, deviceID, licenseID, operation.RequestID, operation.Reason, operation.IdempotencyKey); err != nil {
		return err
	}
	resultTag, err := tx.Exec(ctx, `UPDATE admin_operations SET status='completed',result=$1 WHERE idempotency_key=$2 AND request_fingerprint=$3 AND status='pending'`, encoded, operation.IdempotencyKey, fingerprint)
	if err == nil && resultTag.RowsAffected() != 1 {
		return admin.ErrInvalidInput
	}
	return err
}

func (repository *ActivationRepository) auditAdminFailure(ctx context.Context, action string, operation admin.Operation, licenseID *string) error {
	_, err := repository.pool.Exec(ctx, `INSERT INTO audit_events(event_id,actor_type,actor_id,action,outcome,license_id,request_id,reason,idempotency_key,created_at)
		VALUES(gen_random_uuid(),'operator',$1,$2,'failed',$3,$4,$5,$6,clock_timestamp())`, operation.OperatorID, action, licenseID, operation.RequestID, operation.Reason, operation.IdempotencyKey)
	if err != nil {
		return fmt.Errorf("record failed admin audit: %w", err)
	}
	return nil
}

func (repository *ActivationRepository) adminFailure(ctx context.Context, action string, operation admin.Operation, licenseID *string, businessError error) error {
	if err := repository.auditAdminFailure(ctx, action, operation, licenseID); err != nil {
		return err
	}
	return businessError
}
func validAdminTransition(from, to string) bool {
	switch to {
	case "disabled":
		return from == "active"
	case "active":
		return from == "disabled"
	case "revoked", "reissued":
		return from == "active" || from == "disabled"
	}
	return false
}
func trimIdentifier(value string, suffix int) string {
	limit := 127 - suffix
	if len(value) > limit {
		return value[:limit]
	}
	return value
}
func mapAdminWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23514") {
		return admin.ErrInvalidInput
	}
	return fmt.Errorf("admin write: %w", err)
}

var _ = hex.EncodeToString
