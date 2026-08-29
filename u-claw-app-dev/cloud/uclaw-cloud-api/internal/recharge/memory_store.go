package recharge

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// MemoryStore is a local/test recharge store with the same idempotency semantics as PostgreSQL.
type MemoryStore struct {
	mu        sync.Mutex
	nextID    int64
	orders    map[string]Order
	callbacks map[string]Callback
	accounts  map[int64]Account
}

// NewMemoryStore returns an in-process store for unit tests and local smoke routes.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		nextID:    1,
		orders:    make(map[string]Order),
		callbacks: make(map[string]Callback),
		accounts:  make(map[int64]Account),
	}
}

// SaveAccount records the New API mapping needed by tests before virtual callbacks.
func (s *MemoryStore) SaveAccount(account Account) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts[account.UClawUserID] = account
}

// CreateOrder saves a new recharge order.
func (s *MemoryStore) CreateOrder(_ context.Context, order Order) (Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.orders[order.OrderNo]; exists {
		return Order{}, fmt.Errorf("order already exists")
	}
	order.ID = s.nextID
	s.nextID++
	if order.CreatedAt.IsZero() {
		order.CreatedAt = time.Now()
	}
	if order.UpdatedAt.IsZero() {
		order.UpdatedAt = order.CreatedAt
	}
	s.orders[order.OrderNo] = order
	return order, nil
}

// ListOrdersForUser returns recent orders for one Bavi-box user.
func (s *MemoryStore) ListOrdersForUser(_ context.Context, userID int64, limit int) ([]Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		limit = 20
	}
	orders := make([]Order, 0, len(s.orders))
	for _, order := range s.orders {
		if order.UClawUserID == userID {
			orders = append(orders, order)
		}
	}
	for i := 0; i < len(orders); i++ {
		for j := i + 1; j < len(orders); j++ {
			if orders[j].CreatedAt.After(orders[i].CreatedAt) {
				orders[i], orders[j] = orders[j], orders[i]
			}
		}
	}
	if len(orders) > limit {
		orders = orders[:limit]
	}
	return orders, nil
}

// GetOrderForUser returns one order only when it belongs to the requested user.
func (s *MemoryStore) GetOrderForUser(_ context.Context, orderNo string, userID int64) (Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, ok := s.orders[orderNo]
	if !ok || order.UClawUserID != userID {
		return Order{}, fmt.Errorf("order not found")
	}
	return order, nil
}

// GetOrder returns one order by public order number.
func (s *MemoryStore) GetOrder(_ context.Context, orderNo string) (Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, ok := s.orders[orderNo]
	if !ok {
		return Order{}, fmt.Errorf("order not found")
	}
	return order, nil
}

// SaveCallback records a provider event once; duplicate events are ignored for idempotency.
func (s *MemoryStore) SaveCallback(_ context.Context, callback Callback) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := callback.Provider + "|" + callback.ProviderEventID
	if _, exists := s.callbacks[key]; exists {
		return nil
	}
	s.callbacks[key] = callback
	return nil
}

// MarkPaid moves an order to paid unless it is already farther along.
func (s *MemoryStore) MarkPaid(_ context.Context, orderNo string, providerTradeNo string, paidAt time.Time) (Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, ok := s.orders[orderNo]
	if !ok {
		return Order{}, fmt.Errorf("order not found")
	}
	if order.Status == StatusCreated || order.Status == StatusCreditFailed {
		order.Status = StatusPaid
		order.ProviderTradeNo = providerTradeNo
		order.PaidAt = &paidAt
		order.UpdatedAt = paidAt
		s.orders[orderNo] = order
	}
	return order, nil
}

// BeginCredit atomically claims one paid order for New API quota crediting.
func (s *MemoryStore) BeginCredit(_ context.Context, orderNo string) (Order, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, ok := s.orders[orderNo]
	if !ok {
		return Order{}, false, fmt.Errorf("order not found")
	}
	if order.Status != StatusPaid && order.Status != StatusCreditFailed {
		return order, false, nil
	}
	order.Status = StatusCrediting
	order.UpdatedAt = time.Now()
	s.orders[orderNo] = order
	return order, true, nil
}

// MarkCredited marks New API quota crediting as complete.
func (s *MemoryStore) MarkCredited(_ context.Context, orderNo string, creditedAt time.Time) (Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, ok := s.orders[orderNo]
	if !ok {
		return Order{}, fmt.Errorf("order not found")
	}
	order.Status = StatusCredited
	order.CreditedAt = &creditedAt
	order.LastError = ""
	order.UpdatedAt = creditedAt
	s.orders[orderNo] = order
	return order, nil
}

// MarkCreditFailed records why a paid order could not be credited to New API.
func (s *MemoryStore) MarkCreditFailed(_ context.Context, orderNo string, lastError string) (Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, ok := s.orders[orderNo]
	if !ok {
		return Order{}, fmt.Errorf("order not found")
	}
	order.Status = StatusCreditFailed
	order.LastError = lastError
	order.UpdatedAt = time.Now()
	s.orders[orderNo] = order
	return order, nil
}

// GetNewAPIAccount returns the mapped New API user for a Bavi-box user.
func (s *MemoryStore) GetNewAPIAccount(_ context.Context, userID int64) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	account, ok := s.accounts[userID]
	if !ok {
		return Account{}, fmt.Errorf("newapi account not found")
	}
	return account, nil
}
