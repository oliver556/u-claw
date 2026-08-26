package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"uclaw-cloud-api/internal/recharge"
)

// CreateOrder inserts a new payment order for a selected recharge plan.
func (s *Store) CreateOrder(ctx context.Context, order recharge.Order) (recharge.Order, error) {
	row := s.db.QueryRowContext(ctx, `
INSERT INTO payment_orders (
  order_no,
  uclaw_user_id,
  provider,
  amount_cents,
  quota_tokens,
  status,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, order_no, uclaw_user_id, provider, amount_cents, quota_tokens, status,
  provider_trade_no, paid_at, credited_at, last_error, created_at, updated_at
`, order.OrderNo, order.UClawUserID, order.Provider, order.AmountCents, order.Quota, order.Status, order.CreatedAt, order.UpdatedAt)
	created, err := scanRechargeOrder(row)
	if err != nil {
		return recharge.Order{}, fmt.Errorf("create recharge order: %w", err)
	}
	return created, nil
}

// ListOrdersForUser returns recent recharge orders for the caller.
func (s *Store) ListOrdersForUser(ctx context.Context, userID int64, limit int) ([]recharge.Order, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, order_no, uclaw_user_id, provider, amount_cents, quota_tokens, status,
  provider_trade_no, paid_at, credited_at, last_error, created_at, updated_at
FROM payment_orders
WHERE uclaw_user_id = $1
ORDER BY created_at DESC, id DESC
LIMIT $2
`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("list recharge orders: %w", err)
	}
	defer rows.Close()

	var orders []recharge.Order
	for rows.Next() {
		order, err := scanRechargeOrder(rows)
		if err != nil {
			return nil, fmt.Errorf("scan recharge order: %w", err)
		}
		orders = append(orders, order)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate recharge orders: %w", err)
	}
	return orders, nil
}

// GetOrderForUser returns a recharge order only if it belongs to the caller.
func (s *Store) GetOrderForUser(ctx context.Context, orderNo string, userID int64) (recharge.Order, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, order_no, uclaw_user_id, provider, amount_cents, quota_tokens, status,
  provider_trade_no, paid_at, credited_at, last_error, created_at, updated_at
FROM payment_orders
WHERE order_no = $1 AND uclaw_user_id = $2
`, orderNo, userID)
	order, err := scanRechargeOrder(row)
	if err != nil {
		return recharge.Order{}, fmt.Errorf("get recharge order for user: %w", err)
	}
	return order, nil
}

// GetOrder returns a recharge order by its public order number.
func (s *Store) GetOrder(ctx context.Context, orderNo string) (recharge.Order, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, order_no, uclaw_user_id, provider, amount_cents, quota_tokens, status,
  provider_trade_no, paid_at, credited_at, last_error, created_at, updated_at
FROM payment_orders
WHERE order_no = $1
`, orderNo)
	order, err := scanRechargeOrder(row)
	if err != nil {
		return recharge.Order{}, fmt.Errorf("get recharge order: %w", err)
	}
	return order, nil
}

// SaveCallback persists a payment provider event and ignores exact duplicate callback ids.
func (s *Store) SaveCallback(ctx context.Context, callback recharge.Callback) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO payment_callbacks (
  payment_order_id,
  provider,
  provider_event_id,
  signature_valid,
  payload_redacted,
  received_at
) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
`, callback.OrderID, callback.Provider, callback.ProviderEventID, callback.SignatureValid, callback.PayloadRedacted, callback.ReceivedAt)
	if err != nil {
		return fmt.Errorf("save payment callback: %w", err)
	}
	return nil
}

// MarkPaid accepts a successful provider callback without moving credited orders backward.
func (s *Store) MarkPaid(ctx context.Context, orderNo string, providerTradeNo string, paidAt time.Time) (recharge.Order, error) {
	row := s.db.QueryRowContext(ctx, `
UPDATE payment_orders
SET status = CASE WHEN status IN ('created', 'credit_failed') THEN 'paid' ELSE status END,
  provider_trade_no = COALESCE(provider_trade_no, $2),
  paid_at = COALESCE(paid_at, $3),
  updated_at = now()
WHERE order_no = $1
RETURNING id, order_no, uclaw_user_id, provider, amount_cents, quota_tokens, status,
  provider_trade_no, paid_at, credited_at, last_error, created_at, updated_at
`, orderNo, providerTradeNo, paidAt)
	order, err := scanRechargeOrder(row)
	if err != nil {
		return recharge.Order{}, fmt.Errorf("mark recharge order paid: %w", err)
	}
	return order, nil
}

// BeginCredit atomically claims a paid order so repeated callbacks cannot double-credit New API.
func (s *Store) BeginCredit(ctx context.Context, orderNo string) (recharge.Order, bool, error) {
	row := s.db.QueryRowContext(ctx, `
UPDATE payment_orders
SET status = 'crediting', updated_at = now()
WHERE order_no = $1 AND status IN ('paid', 'credit_failed')
RETURNING id, order_no, uclaw_user_id, provider, amount_cents, quota_tokens, status,
  provider_trade_no, paid_at, credited_at, last_error, created_at, updated_at
`, orderNo)
	order, err := scanRechargeOrder(row)
	if err == nil {
		return order, true, nil
	}
	if err != sql.ErrNoRows {
		return recharge.Order{}, false, fmt.Errorf("begin recharge credit: %w", err)
	}
	existing, getErr := s.GetOrder(ctx, orderNo)
	if getErr != nil {
		return recharge.Order{}, false, getErr
	}
	return existing, false, nil
}

// MarkCredited records that New API accepted the quota addition.
func (s *Store) MarkCredited(ctx context.Context, orderNo string, creditedAt time.Time) (recharge.Order, error) {
	row := s.db.QueryRowContext(ctx, `
UPDATE payment_orders
SET status = 'credited',
  credited_at = $2,
  last_error = NULL,
  updated_at = now()
WHERE order_no = $1
RETURNING id, order_no, uclaw_user_id, provider, amount_cents, quota_tokens, status,
  provider_trade_no, paid_at, credited_at, last_error, created_at, updated_at
`, orderNo, creditedAt)
	order, err := scanRechargeOrder(row)
	if err != nil {
		return recharge.Order{}, fmt.Errorf("mark recharge order credited: %w", err)
	}
	return order, nil
}

// MarkCreditFailed keeps the paid order retryable after a New API outage.
func (s *Store) MarkCreditFailed(ctx context.Context, orderNo string, lastError string) (recharge.Order, error) {
	row := s.db.QueryRowContext(ctx, `
UPDATE payment_orders
SET status = 'credit_failed',
  last_error = $2,
  updated_at = now()
WHERE order_no = $1
RETURNING id, order_no, uclaw_user_id, provider, amount_cents, quota_tokens, status,
  provider_trade_no, paid_at, credited_at, last_error, created_at, updated_at
`, orderNo, lastError)
	order, err := scanRechargeOrder(row)
	if err != nil {
		return recharge.Order{}, fmt.Errorf("mark recharge order credit failed: %w", err)
	}
	return order, nil
}

// GetNewAPIAccount loads the mapped New API user for quota crediting.
func (s *Store) GetNewAPIAccount(ctx context.Context, userID int64) (recharge.Account, error) {
	var account recharge.Account
	var newAPIUserID sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
SELECT uclaw_user_id, newapi_user_id
FROM newapi_accounts
WHERE uclaw_user_id = $1
`, userID).Scan(&account.UClawUserID, &newAPIUserID)
	if err != nil {
		return recharge.Account{}, fmt.Errorf("get newapi account: %w", err)
	}
	if newAPIUserID.Valid {
		account.NewAPIUserID = newAPIUserID.Int64
	}
	return account, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

// scanRechargeOrder normalizes nullable SQL fields into the recharge domain model.
func scanRechargeOrder(row rowScanner) (recharge.Order, error) {
	var order recharge.Order
	var providerTradeNo sql.NullString
	var paidAt sql.NullTime
	var creditedAt sql.NullTime
	var lastError sql.NullString
	if err := row.Scan(
		&order.ID,
		&order.OrderNo,
		&order.UClawUserID,
		&order.Provider,
		&order.AmountCents,
		&order.Quota,
		&order.Status,
		&providerTradeNo,
		&paidAt,
		&creditedAt,
		&lastError,
		&order.CreatedAt,
		&order.UpdatedAt,
	); err != nil {
		return recharge.Order{}, err
	}
	if providerTradeNo.Valid {
		order.ProviderTradeNo = providerTradeNo.String
	}
	if paidAt.Valid {
		order.PaidAt = &paidAt.Time
	}
	if creditedAt.Valid {
		order.CreditedAt = &creditedAt.Time
	}
	if lastError.Valid {
		order.LastError = lastError.String
	}
	return order, nil
}
