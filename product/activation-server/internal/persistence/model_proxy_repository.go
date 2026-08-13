package persistence

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"u-claw-activation-server/internal/modelproxy"
)

const modelProxyLockDomain int64 = 0x55434c4157505258

type ModelProxyRepository struct{ pool *pgxpool.Pool }

func NewModelProxyRepository(pool *pgxpool.Pool) (*ModelProxyRepository, error) {
	if pool == nil {
		return nil, errors.New("PostgreSQL pool is required")
	}
	return &ModelProxyRepository{pool: pool}, nil
}
func (r *ModelProxyRepository) AuthorizeByDigest(ctx context.Context, digest [32]byte) (modelproxy.Authorization, error) {
	var a modelproxy.Authorization
	err := r.pool.QueryRow(ctx, `SELECT token.device_token_id,token.inventory_id,token.device_id,token.license_id,token.status,inventory.status,device.status,CASE WHEN license.status='active' AND license.not_before<=clock_timestamp() AND license.expires_at>clock_timestamp() THEN 'active' ELSE 'inactive' END,binding.status,inventory.new_api_setup_status,binding.balance_setup_status,COALESCE(binding.api_key_envelope,''::bytea),COALESCE(binding.api_key_version,''),COALESCE(binding.base_url,''),COALESCE(binding.default_model,''),binding.allowed_models,binding.requests_per_minute,binding.concurrent_requests FROM device_access_tokens token JOIN activation_inventory inventory ON inventory.id=token.inventory_id JOIN devices device ON device.device_id=token.device_id AND device.inventory_id=token.inventory_id JOIN licenses license ON license.license_id=token.license_id AND license.device_id=token.device_id JOIN new_api_bindings binding ON binding.inventory_id=token.inventory_id AND binding.device_id=token.device_id WHERE token.token_digest=$1`, digest[:]).Scan(&a.TokenID, &a.InventoryID, &a.DeviceID, &a.LicenseID, &a.TokenStatus, &a.InventoryStatus, &a.DeviceStatus, &a.LicenseStatus, &a.BindingStatus, &a.SetupStatus, &a.BalanceStatus, &a.Envelope, &a.KeyVersion, &a.BaseURL, &a.DefaultModel, &a.AllowedModels, &a.RequestsPerMinute, &a.ConcurrentRequests)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, modelproxy.ErrNotFound
	}
	if err != nil {
		return a, fmt.Errorf("authorize model proxy token: %w", err)
	}
	return a, nil
}
func (r *ModelProxyRepository) Admit(ctx context.Context, tokenID, requestID string, rpm, concurrent int, lease time.Duration) error {
	if rpm <= 0 || concurrent <= 0 || lease < time.Second || lease > 2*time.Minute {
		return modelproxy.ErrAdmissionLimited
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin model proxy admission: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, tokenID, modelProxyLockDomain); err != nil {
		return fmt.Errorf("lock model proxy admission: %w", err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM model_proxy_admissions WHERE ctid IN (SELECT ctid FROM model_proxy_admissions WHERE device_token_id=$1 AND ((completed_at IS NULL AND lease_expires_at<=clock_timestamp()) OR started_at<clock_timestamp()-interval '10 minutes') LIMIT 1000)`, tokenID); err != nil {
		return fmt.Errorf("clean model proxy leases: %w", err)
	}
	var recent, active int
	err = tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE started_at>clock_timestamp()-interval '1 minute'),count(*) FILTER (WHERE completed_at IS NULL AND lease_expires_at>clock_timestamp()) FROM model_proxy_admissions WHERE device_token_id=$1`, tokenID).Scan(&recent, &active)
	if err != nil {
		return fmt.Errorf("count model proxy admission: %w", err)
	}
	if recent >= rpm || active >= concurrent {
		return modelproxy.ErrAdmissionLimited
	}
	if _, err = tx.Exec(ctx, `INSERT INTO model_proxy_admissions(request_id,device_token_id,started_at,lease_expires_at) VALUES($1,$2,clock_timestamp(),clock_timestamp()+make_interval(secs => $3))`, requestID, tokenID, lease.Seconds()); err != nil {
		return fmt.Errorf("insert model proxy admission: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit model proxy admission: %w", err)
	}
	return nil
}
func (r *ModelProxyRepository) Complete(ctx context.Context, requestID string) error {
	_, err := r.pool.Exec(ctx, `UPDATE model_proxy_admissions SET completed_at=COALESCE(completed_at,clock_timestamp()) WHERE request_id=$1`, requestID)
	if err != nil {
		return fmt.Errorf("complete model proxy admission: %w", err)
	}
	return nil
}
func (r *ModelProxyRepository) Audit(ctx context.Context, a modelproxy.Audit) error {
	eventID, err := proxyUUID()
	if err != nil {
		return errors.New("model proxy audit unavailable")
	}
	outcome := "failed"
	if a.Outcome == "succeeded" || a.Outcome == "admitted" {
		outcome = "succeeded"
	}
	action := "model-proxy.request"
	if a.Route == "models" || a.Route == "chat" {
		action = "model-proxy." + a.Route
	}
	_, err = r.pool.Exec(ctx, `INSERT INTO audit_events(event_id,actor_type,actor_id,action,outcome,inventory_id,device_id,license_id,request_id,created_at) VALUES($1,'client',$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`, eventID, a.TokenID, action, outcome, a.InventoryID, a.DeviceID, a.LicenseID, a.RequestID)
	if err != nil {
		return fmt.Errorf("record model proxy audit: %w", err)
	}
	return nil
}
func proxyUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	s := hex.EncodeToString(b)
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:], nil
}
