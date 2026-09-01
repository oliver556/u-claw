package usage

import (
	"context"
	"sync"
	"time"
)

// MemoryStore is a test/local store for direct ecommerce image usage events.
type MemoryStore struct {
	mu     sync.Mutex
	events map[string]EcommerceImageUsageEvent
}

// NewMemoryStore returns an in-process ecommerce usage store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{events: make(map[string]EcommerceImageUsageEvent)}
}

// ClaimEcommerceImageUsage saves one direct ecommerce image billing event once.
func (s *MemoryStore) ClaimEcommerceImageUsage(_ context.Context, event EcommerceImageUsageEvent) (EcommerceImageUsageEvent, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.events[event.RequestID]; ok {
		return existing, false, nil
	}
	if event.ID == 0 {
		event.ID = int64(len(s.events) + 1)
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now()
	}
	s.events[event.RequestID] = event
	return event, true, nil
}

// MarkEcommerceImageUsageSettled marks a claimed event as actually debited.
func (s *MemoryStore) MarkEcommerceImageUsageSettled(_ context.Context, requestID string) (EcommerceImageUsageEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	event := s.events[requestID]
	event.Status = "settled"
	s.events[requestID] = event
	return event, nil
}

// ReleaseEcommerceImageUsageClaim removes an unbilled pending event.
func (s *MemoryStore) ReleaseEcommerceImageUsageClaim(_ context.Context, requestID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if event, ok := s.events[requestID]; ok && event.Status == "pending" {
		delete(s.events, requestID)
	}
	return nil
}

// ListEcommerceImageUsage returns recent direct ecommerce image billing events.
func (s *MemoryStore) ListEcommerceImageUsage(_ context.Context, userID int64, limit int) ([]EcommerceImageUsageEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		limit = 50
	}
	events := make([]EcommerceImageUsageEvent, 0, len(s.events))
	for _, event := range s.events {
		if event.UserID == userID && event.Status == "settled" {
			events = append(events, event)
		}
	}
	for i := 0; i < len(events); i++ {
		for j := i + 1; j < len(events); j++ {
			if events[j].CreatedAt.After(events[i].CreatedAt) {
				events[i], events[j] = events[j], events[i]
			}
		}
	}
	if len(events) > limit {
		events = events[:limit]
	}
	return events, nil
}
