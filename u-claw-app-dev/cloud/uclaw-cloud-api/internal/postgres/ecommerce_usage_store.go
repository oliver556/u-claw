package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"uclaw-cloud-api/internal/usage"
)

// ClaimEcommerceImageUsage inserts one idempotent ecommerce image billing event.
func (s *Store) ClaimEcommerceImageUsage(ctx context.Context, event usage.EcommerceImageUsageEvent) (usage.EcommerceImageUsageEvent, bool, error) {
	outputTypes, err := json.Marshal(event.OutputTypes)
	if err != nil {
		return usage.EcommerceImageUsageEvent{}, false, fmt.Errorf("marshal ecommerce usage output types: %w", err)
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now()
	}
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
	row := s.db.QueryRowContext(ctx, `
UPDATE ecommerce_image_usage_events
SET status = 'settled'
WHERE request_id = $1
RETURNING id, uclaw_user_id, newapi_user_id, phone, request_id, model_name, token_name,
  platform, output_types, image_count, quota_tokens, status, created_at
`, requestID)
	return scanEcommerceImageUsage(row)
}

// ReleaseEcommerceImageUsageClaim removes an unbilled pending event.
func (s *Store) ReleaseEcommerceImageUsageClaim(ctx context.Context, requestID string) error {
	_, err := s.db.ExecContext(ctx, `
DELETE FROM ecommerce_image_usage_events
WHERE request_id = $1 AND status = 'pending'
`, requestID)
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
	row := s.db.QueryRowContext(ctx, `
SELECT id, uclaw_user_id, newapi_user_id, phone, request_id, model_name, token_name,
  platform, output_types, image_count, quota_tokens, status, created_at
FROM ecommerce_image_usage_events
WHERE request_id = $1
`, requestID)
	return scanEcommerceImageUsage(row)
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
