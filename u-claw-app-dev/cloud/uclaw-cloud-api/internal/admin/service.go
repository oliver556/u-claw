package admin

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"fmt"
	"strings"
	"sync"
	"time"
)

const maxGenerateCount = 50

// Store defines the operational surface needed by the minimal admin console.
type Store interface {
	CreateActivationBatch(ctx context.Context, name string, note string, createdBy string) (int64, error)
	CreateActivationCode(ctx context.Context, code string, batchID sql.NullInt64, at time.Time) (ActivationCode, error)
	ListActivationCodes(ctx context.Context, filter ActivationCodeFilter) ([]ActivationCode, error)
	GetActivationCode(ctx context.Context, id int64) (ActivationCode, error)
	DisableActivationCode(ctx context.Context, id int64, reason string, at time.Time) error
	ReissueActivationCode(ctx context.Context, id int64, replacementCode string, at time.Time) (ActivationCode, error)
}

// ActivationCodeFilter limits list queries for the admin console.
type ActivationCodeFilter struct {
	Status string
	Limit  int
}

// ActivationCode is a redacted operational view of one inventory row.
type ActivationCode struct {
	ID                     int64      `json:"id"`
	BatchID                *int64     `json:"batchId,omitempty"`
	BatchName              string     `json:"batchName,omitempty"`
	Status                 string     `json:"status"`
	BoundUserID            *int64     `json:"boundUserId,omitempty"`
	BoundPhone             string     `json:"boundPhone,omitempty"`
	BoundAt                *time.Time `json:"boundAt,omitempty"`
	CreatedAt              time.Time  `json:"createdAt"`
	ExpiresAt              *time.Time `json:"expiresAt,omitempty"`
	NewAPIUserID           *int64     `json:"newapiUserId,omitempty"`
	NewAPIUsername         string     `json:"newapiUsername,omitempty"`
	NewAPIBaseURL          string     `json:"newapiBaseUrl,omitempty"`
	NewAPITokenRotatedAt   *time.Time `json:"newapiTokenRotatedAt,omitempty"`
	LatestActivationID     string     `json:"latestActivationId,omitempty"`
	LatestActivationStage  string     `json:"latestActivationStage,omitempty"`
	LatestActivationCommit *time.Time `json:"latestActivationCommit,omitempty"`
	PlainCode              string     `json:"code,omitempty"`
}

// GenerateRequest describes a batch of codes to create and show once.
type GenerateRequest struct {
	Count     int    `json:"count"`
	BatchName string `json:"batchName"`
	Note      string `json:"note"`
	CreatedBy string `json:"createdBy"`
}

// Service owns admin-only activation inventory workflows.
type Service struct {
	store Store
	now   func() time.Time
}

// NewService returns an admin service backed by inventory storage.
func NewService(store Store) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("admin store is required")
	}
	return &Service{store: store, now: time.Now}, nil
}

// GenerateActivationCodes creates printable codes and persists only hashes.
func (s *Service) GenerateActivationCodes(ctx context.Context, req GenerateRequest) ([]ActivationCode, error) {
	count := req.Count
	if count == 0 {
		count = 1
	}
	if count < 0 || count > maxGenerateCount {
		return nil, fmt.Errorf("count must be between 1 and %d", maxGenerateCount)
	}
	var batchID sql.NullInt64
	if strings.TrimSpace(req.BatchName) != "" || strings.TrimSpace(req.Note) != "" {
		id, err := s.store.CreateActivationBatch(ctx, strings.TrimSpace(req.BatchName), strings.TrimSpace(req.Note), strings.TrimSpace(req.CreatedBy))
		if err != nil {
			return nil, err
		}
		batchID = sql.NullInt64{Int64: id, Valid: true}
	}
	codes := make([]ActivationCode, 0, count)
	for len(codes) < count {
		code, err := GenerateActivationCode()
		if err != nil {
			return nil, fmt.Errorf("generate activation code: %w", err)
		}
		record, err := s.store.CreateActivationCode(ctx, code, batchID, s.now().UTC())
		if err != nil {
			return nil, err
		}
		record.PlainCode = code
		codes = append(codes, record)
	}
	return codes, nil
}

// ListActivationCodes returns recent inventory with user and New API mapping.
func (s *Service) ListActivationCodes(ctx context.Context, filter ActivationCodeFilter) ([]ActivationCode, error) {
	if filter.Limit <= 0 || filter.Limit > 200 {
		filter.Limit = 50
	}
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	return s.store.ListActivationCodes(ctx, filter)
}

// GetActivationCode returns one inventory row and its current mapping.
func (s *Service) GetActivationCode(ctx context.Context, id int64) (ActivationCode, error) {
	if id <= 0 {
		return ActivationCode{}, fmt.Errorf("activation code id is required")
	}
	return s.store.GetActivationCode(ctx, id)
}

// DisableActivationCode prevents a code from being used again.
func (s *Service) DisableActivationCode(ctx context.Context, id int64, reason string) error {
	if id <= 0 {
		return fmt.Errorf("activation code id is required")
	}
	return s.store.DisableActivationCode(ctx, id, strings.TrimSpace(reason), s.now().UTC())
}

// ReissueActivationCode replaces an unused or disabled code and returns the new plaintext once.
func (s *Service) ReissueActivationCode(ctx context.Context, id int64) (ActivationCode, error) {
	if id <= 0 {
		return ActivationCode{}, fmt.Errorf("activation code id is required")
	}
	code, err := GenerateActivationCode()
	if err != nil {
		return ActivationCode{}, fmt.Errorf("generate activation code: %w", err)
	}
	record, err := s.store.ReissueActivationCode(ctx, id, code, s.now().UTC())
	if err != nil {
		return ActivationCode{}, err
	}
	record.PlainCode = code
	return record, nil
}

// GenerateActivationCode creates a human-readable one-time code for USB card printing.
func GenerateActivationCode() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	return encoded[:4] + "-" + encoded[4:8] + "-" + encoded[8:12] + "-" + encoded[12:16], nil
}

// MemoryStore gives local tests and dev servers a small admin inventory.
type MemoryStore struct {
	mu      sync.Mutex
	nextID  int64
	batches map[int64]string
	codes   map[int64]ActivationCode
}

// NewMemoryStore returns an in-memory admin store for tests only.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		nextID:  1,
		batches: make(map[int64]string),
		codes:   make(map[int64]ActivationCode),
	}
}

// CreateActivationBatch records a local batch label.
func (s *MemoryStore) CreateActivationBatch(_ context.Context, name string, _ string, _ string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextID
	s.nextID++
	s.batches[id] = strings.TrimSpace(name)
	return id, nil
}

// CreateActivationCode inserts a local activation code row.
func (s *MemoryStore) CreateActivationCode(_ context.Context, _ string, batchID sql.NullInt64, at time.Time) (ActivationCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextID
	s.nextID++
	record := ActivationCode{ID: id, Status: "unused", CreatedAt: at}
	if batchID.Valid {
		record.BatchID = &batchID.Int64
		record.BatchName = s.batches[batchID.Int64]
	}
	s.codes[id] = record
	return record, nil
}

// ListActivationCodes returns local activation inventory.
func (s *MemoryStore) ListActivationCodes(_ context.Context, filter ActivationCodeFilter) ([]ActivationCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	records := make([]ActivationCode, 0, len(s.codes))
	for _, record := range s.codes {
		if filter.Status != "" && record.Status != filter.Status {
			continue
		}
		records = append(records, record)
		if len(records) >= filter.Limit {
			break
		}
	}
	return records, nil
}

// GetActivationCode returns a local activation code by id.
func (s *MemoryStore) GetActivationCode(_ context.Context, id int64) (ActivationCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.codes[id]
	if !ok {
		return ActivationCode{}, fmt.Errorf("activation code not found")
	}
	return record, nil
}

// DisableActivationCode marks a local code disabled.
func (s *MemoryStore) DisableActivationCode(_ context.Context, id int64, _ string, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.codes[id]
	if !ok {
		return fmt.Errorf("activation code not found")
	}
	record.Status = "disabled"
	s.codes[id] = record
	return nil
}

// ReissueActivationCode replaces a local unused or disabled code.
func (s *MemoryStore) ReissueActivationCode(_ context.Context, id int64, _ string, at time.Time) (ActivationCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.codes[id]
	if !ok {
		return ActivationCode{}, fmt.Errorf("activation code not found")
	}
	if old.Status == "bound" {
		return ActivationCode{}, fmt.Errorf("bound activation code cannot be reissued")
	}
	old.Status = "reissued"
	s.codes[id] = old
	newID := s.nextID
	s.nextID++
	record := ActivationCode{ID: newID, Status: "unused", CreatedAt: at, BatchID: old.BatchID, BatchName: old.BatchName}
	s.codes[newID] = record
	return record, nil
}
