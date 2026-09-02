package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"uclaw-cloud-api/internal/usage"
)

const ecommerceImageUsageSchemaSQL = `
CREATE TABLE IF NOT EXISTS ecommerce_image_usage_events (
  id BIGSERIAL PRIMARY KEY,
  uclaw_user_id BIGINT NOT NULL REFERENCES uclaw_users(id),
  newapi_user_id BIGINT NOT NULL,
  phone TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  model_name TEXT NOT NULL,
  token_name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  output_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_count INTEGER NOT NULL,
  quota_tokens BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ecommerce_image_usage_user_created
  ON ecommerce_image_usage_events(uclaw_user_id, created_at DESC);
`

// EnsureEcommerceImageUsageSchema creates the direct image billing table during
// startup so older production deployments do not lose ecommerce usage charges
// when a numbered SQL migration was missed.
func (s *Store) EnsureEcommerceImageUsageSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("postgres store is not initialized")
	}
	if _, err := s.db.ExecContext(ctx, ecommerceImageUsageSchemaSQL); err != nil {
		return fmt.Errorf("ensure ecommerce image usage schema: %w", err)
	}
	return nil
}

// isUndefinedTableError detects PostgreSQL missing-relation failures from both
// pgx structured errors and wrapped production messages.
func isUndefinedTableError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "sqlstate 42p01") ||
		strings.Contains(message, "relation \"ecommerce_image_usage_events\" does not exist")
}

// ensureEcommerceImageUsageSchemaAfterUndefinedTable retries schema creation at
// the failing call site. It protects long-running production processes that did
// not pass through the latest Open() startup guard before handling usage traffic.
func (s *Store) ensureEcommerceImageUsageSchemaAfterUndefinedTable(ctx context.Context, err error) bool {
	if !isUndefinedTableError(err) {
		return false
	}
	return s.EnsureEcommerceImageUsageSchema(ctx) == nil
}

// ClaimEcommerceImageUsage inserts one idempotent ecommerce image billing event.
func (s *Store) ClaimEcommerceImageUsage(ctx context.Context, event usage.EcommerceImageUsageEvent) (usage.EcommerceImageUsageEvent, bool, error) {
	outputTypes, err := json.Marshal(event.OutputTypes)
	if err != nil {
		return usage.EcommerceImageUsageEvent{}, false, fmt.Errorf("marshal ecommerce usage output types: %w", err)
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now()
	}
	return s.claimEcommerceImageUsage(ctx, event, string(outputTypes), true)
}

func (s *Store) claimEcommerceImageUsage(ctx context.Context, event usage.EcommerceImageUsageEvent, outputTypes string, retryMissingTable bool) (usage.EcommerceImageUsageEvent, bool, error) {
	row := s.db.QueryRowContext(ctx, `
INSERT INTO ecommerce_image_usage_events (
  uclaw_user_id,
  newapi_user_id,
  phone,
  request_id,
  model_name,
  token_name,
  platform,
  output_types,
  image_count,
  quota_tokens,
  status,
  created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
ON CONFLICT (request_id) DO NOTHING
RETURNING id, created_at
`, event.UserID, event.NewAPIUserID, event.Phone, event.RequestID, event.Model, event.TokenName, event.Platform, string(outputTypes), event.ImageCount, event.Quota, event.Status, event.CreatedAt)
	var createdAt time.Time
	if err := row.Scan(&event.ID, &createdAt); err != nil {
		if retryMissingTable && s.ensureEcommerceImageUsageSchemaAfterUndefinedTable(ctx, err) {
			return s.claimEcommerceImageUsage(ctx, event, outputTypes, false)
		}
		if err == sql.ErrNoRows {
			existing, getErr := s.getEcommerceImageUsageByRequestID(ctx, event.RequestID)
			if getErr != nil {
				return usage.EcommerceImageUsageEvent{}, false, getErr
			}
			return existing, false, nil
		}
		return usage.EcommerceImageUsageEvent{}, false, fmt.Errorf("claim ecommerce image usage: %w", err)
	}
	event.CreatedAt = createdAt
	return event, true, nil
}

// MarkEcommerceImageUsageSettled marks a claimed event as actually debited.
func (s *Store) MarkEcommerceImageUsageSettled(ctx context.Context, requestID string) (usage.EcommerceImageUsageEvent, error) {
	return s.markEcommerceImageUsageSettled(ctx, requestID, true)
}

func (s *Store) markEcommerceImageUsageSettled(ctx context.Context, requestID string, retryMissingTable bool) (usage.EcommerceImageUsageEvent, error) {
	row := s.db.QueryRowContext(ctx, `
UPDATE ecommerce_image_usage_events
SET status = 'settled'
WHERE request_id = $1
RETURNING id, uclaw_user_id, newapi_user_id, phone, request_id, model_name, token_name,
  platform, output_types, image_count, quota_tokens, status, created_at
`, requestID)
	event, err := scanEcommerceImageUsage(row)
	if err != nil && retryMissingTable && s.ensureEcommerceImageUsageSchemaAfterUndefinedTable(ctx, err) {
		return s.markEcommerceImageUsageSettled(ctx, requestID, false)
	}
	return event, err
}

// ReleaseEcommerceImageUsageClaim removes an unbilled pending event.
func (s *Store) ReleaseEcommerceImageUsageClaim(ctx context.Context, requestID string) error {
	_, err := s.db.ExecContext(ctx, `
DELETE FROM ecommerce_image_usage_events
WHERE request_id = $1 AND status = 'pending'
`, requestID)
	if s.ensureEcommerceImageUsageSchemaAfterUndefinedTable(ctx, err) {
		_, err = s.db.ExecContext(ctx, `
DELETE FROM ecommerce_image_usage_events
WHERE request_id = $1 AND status = 'pending'
`, requestID)
	}
	if err != nil {
		return fmt.Errorf("release ecommerce image usage claim: %w", err)
	}
	return nil
}

// ListEcommerceImageUsage returns recent direct ecommerce image billing events.
func (s *Store) ListEcommerceImageUsage(ctx context.Context, userID int64, limit int) ([]usage.EcommerceImageUsageEvent, error) {
	if limit <= 0 {
		limit = 50
	}
	return s.listEcommerceImageUsage(ctx, userID, limit, true)
}

func (s *Store) listEcommerceImageUsage(ctx context.Context, userID int64, limit int, retryMissingTable bool) ([]usage.EcommerceImageUsageEvent, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, uclaw_user_id, newapi_user_id, phone, request_id, model_name, token_name,
  platform, output_types, image_count, quota_tokens, status, created_at
FROM ecommerce_image_usage_events
WHERE uclaw_user_id = $1
  AND status = 'settled'
ORDER BY created_at DESC, id DESC
LIMIT $2
`, userID, limit)
	if err != nil {
		if retryMissingTable && s.ensureEcommerceImageUsageSchemaAfterUndefinedTable(ctx, err) {
			return s.listEcommerceImageUsage(ctx, userID, limit, false)
		}
		return nil, fmt.Errorf("list ecommerce image usage: %w", err)
	}
	defer rows.Close()

	var events []usage.EcommerceImageUsageEvent
	for rows.Next() {
		event, scanErr := scanEcommerceImageUsage(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ecommerce image usage: %w", err)
	}
	return events, nil
}

func (s *Store) getEcommerceImageUsageByRequestID(ctx context.Context, requestID string) (usage.EcommerceImageUsageEvent, error) {
	return s.getEcommerceImageUsageByRequestIDWithRetry(ctx, requestID, true)
}

func (s *Store) getEcommerceImageUsageByRequestIDWithRetry(ctx context.Context, requestID string, retryMissingTable bool) (usage.EcommerceImageUsageEvent, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, uclaw_user_id, newapi_user_id, phone, request_id, model_name, token_name,
  platform, output_types, image_count, quota_tokens, status, created_at
FROM ecommerce_image_usage_events
WHERE request_id = $1
`, requestID)
	event, err := scanEcommerceImageUsage(row)
	if err != nil && retryMissingTable && s.ensureEcommerceImageUsageSchemaAfterUndefinedTable(ctx, err) {
		return s.getEcommerceImageUsageByRequestIDWithRetry(ctx, requestID, false)
	}
	return event, err
}

type ecommerceUsageScanner interface {
	Scan(dest ...any) error
}

func scanEcommerceImageUsage(scanner ecommerceUsageScanner) (usage.EcommerceImageUsageEvent, error) {
	var event usage.EcommerceImageUsageEvent
	var outputTypesRaw []byte
	if err := scanner.Scan(
		&event.ID,
		&event.UserID,
		&event.NewAPIUserID,
		&event.Phone,
		&event.RequestID,
		&event.Model,
		&event.TokenName,
		&event.Platform,
		&outputTypesRaw,
		&event.ImageCount,
		&event.Quota,
		&event.Status,
		&event.CreatedAt,
	); err != nil {
		return usage.EcommerceImageUsageEvent{}, fmt.Errorf("scan ecommerce image usage: %w", err)
	}
	if len(outputTypesRaw) > 0 {
		if err := json.Unmarshal(outputTypesRaw, &event.OutputTypes); err != nil {
			return usage.EcommerceImageUsageEvent{}, fmt.Errorf("decode ecommerce usage output types: %w", err)
		}
	}
	return event, nil
}
