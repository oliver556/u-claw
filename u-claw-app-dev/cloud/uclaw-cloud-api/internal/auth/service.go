package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

var phonePattern = regexp.MustCompile(`^1[3-9]\d{9}$`)

// ServiceConfig controls SMS login behavior for local dev and production wiring.
type ServiceConfig struct {
	CodeTTL     time.Duration
	TokenTTL    time.Duration
	DevSMSCode  string
	CodePepper  string
	ExposeCodes bool
}

// User is the verified U-Claw account returned to API clients.
type User struct {
	ID    int64  `json:"id"`
	Phone string `json:"phone"`
}

// SMSCode stores the latest login code for one phone and purpose.
type SMSCode struct {
	CodeHash  string
	ExpiresAt time.Time
	Consumed  bool
}

// Store is the persistence seam for phone login; PostgreSQL implementation can replace MemoryStore.
type Store interface {
	SaveSMSCode(ctx context.Context, phone string, purpose string, code SMSCode) error
	ConsumeSMSCode(ctx context.Context, phone string, purpose string, codeHash string, now time.Time) error
	UpsertUser(ctx context.Context, phone string, verifiedAt time.Time) (User, error)
}

// Service owns phone/SMS login rules used before activation and recharge.
type Service struct {
	store  Store
	tokens *TokenManager
	cfg    ServiceConfig
	now    func() time.Time
}

// LoginResult is returned by POST /v1/auth/sms/login.
type LoginResult struct {
	AccessToken string `json:"accessToken"`
	User        User   `json:"user"`
}

// SendSMSResult is returned by POST /v1/auth/sms/send; DevCode is only exposed outside production.
type SendSMSResult struct {
	Status  string `json:"status"`
	DevCode string `json:"devCode,omitempty"`
}

// NewService creates the phone auth service with conservative TTL defaults.
func NewService(store Store, tokens *TokenManager, cfg ServiceConfig) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("auth store is required")
	}
	if tokens == nil {
		return nil, fmt.Errorf("token manager is required")
	}
	if cfg.CodeTTL <= 0 {
		cfg.CodeTTL = 5 * time.Minute
	}
	if cfg.TokenTTL <= 0 {
		cfg.TokenTTL = 24 * time.Hour
	}
	if strings.TrimSpace(cfg.DevSMSCode) == "" {
		cfg.DevSMSCode = "123456"
	}
	if strings.TrimSpace(cfg.CodePepper) == "" {
		cfg.CodePepper = "uclaw-dev-code-pepper"
	}
	return &Service{store: store, tokens: tokens, cfg: cfg, now: time.Now}, nil
}

// SendSMS records a login code and returns a provider-neutral status.
func (s *Service) SendSMS(ctx context.Context, phone string, purpose string) (SendSMSResult, error) {
	phone, purpose, err := normalizeSMSInput(phone, purpose)
	if err != nil {
		return SendSMSResult{}, err
	}

	code := s.cfg.DevSMSCode
	record := SMSCode{
		CodeHash:  s.hashCode(phone, purpose, code),
		ExpiresAt: s.now().Add(s.cfg.CodeTTL),
	}
	if err := s.store.SaveSMSCode(ctx, phone, purpose, record); err != nil {
		return SendSMSResult{}, err
	}

	result := SendSMSResult{Status: "sent"}
	if s.cfg.ExposeCodes {
		result.DevCode = code
	}
	return result, nil
}

// Login consumes a valid SMS code and returns a signed access token.
func (s *Service) Login(ctx context.Context, phone string, purpose string, code string) (LoginResult, error) {
	phone, purpose, err := normalizeSMSInput(phone, purpose)
	if err != nil {
		return LoginResult{}, err
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return LoginResult{}, fmt.Errorf("code is required")
	}

	if err := s.store.ConsumeSMSCode(ctx, phone, purpose, s.hashCode(phone, purpose, code), s.now()); err != nil {
		return LoginResult{}, err
	}
	user, err := s.store.UpsertUser(ctx, phone, s.now())
	if err != nil {
		return LoginResult{}, err
	}
	token, err := s.tokens.IssueAccessToken(user.ID, phone, s.cfg.TokenTTL)
	if err != nil {
		return LoginResult{}, err
	}
	return LoginResult{AccessToken: token, User: User{ID: user.ID, Phone: MaskPhone(phone)}}, nil
}

// VerifyAccessToken validates a U-Claw access token for authenticated API calls.
func (s *Service) VerifyAccessToken(token string) (TokenClaims, error) {
	return s.tokens.VerifyAccessToken(token)
}

// MaskPhone hides the middle digits before returning phone numbers to clients.
func MaskPhone(phone string) string {
	phone = strings.TrimSpace(phone)
	if len(phone) != 11 {
		return phone
	}
	return phone[:3] + "****" + phone[7:]
}

// hashCode hashes SMS codes before storage so logs and stores do not carry plaintext codes.
func (s *Service) hashCode(phone string, purpose string, code string) string {
	sum := sha256.Sum256([]byte(phone + ":" + purpose + ":" + strings.TrimSpace(code) + ":" + s.cfg.CodePepper))
	return hex.EncodeToString(sum[:])
}

// normalizeSMSInput enforces the current China mainland phone-login boundary.
func normalizeSMSInput(phone string, purpose string) (string, string, error) {
	phone = strings.TrimSpace(phone)
	purpose = strings.TrimSpace(purpose)
	if !phonePattern.MatchString(phone) {
		return "", "", fmt.Errorf("phone is invalid")
	}
	if purpose == "" {
		purpose = "login"
	}
	if purpose != "login" {
		return "", "", fmt.Errorf("purpose is unsupported")
	}
	return phone, purpose, nil
}

// MemoryStore is a development/test store for phone login before PostgreSQL wiring is added.
type MemoryStore struct {
	mu       sync.Mutex
	nextID   int64
	codes    map[string]SMSCode
	users    map[string]User
	verified map[string]time.Time
}

// NewMemoryStore returns an in-process auth store for local smoke tests.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		nextID:   1,
		codes:    make(map[string]SMSCode),
		users:    make(map[string]User),
		verified: make(map[string]time.Time),
	}
}

// SaveSMSCode saves or replaces a phone-purpose SMS code.
func (s *MemoryStore) SaveSMSCode(_ context.Context, phone string, purpose string, code SMSCode) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.codes[phone+"|"+purpose] = code
	return nil
}

// ConsumeSMSCode validates and consumes a phone-purpose SMS code once.
func (s *MemoryStore) ConsumeSMSCode(_ context.Context, phone string, purpose string, codeHash string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := phone + "|" + purpose
	code, ok := s.codes[key]
	if !ok || code.Consumed || code.CodeHash != codeHash {
		return fmt.Errorf("sms code is invalid")
	}
	if !now.Before(code.ExpiresAt) {
		return fmt.Errorf("sms code is expired")
	}
	code.Consumed = true
	s.codes[key] = code
	return nil
}

// UpsertUser creates or updates a verified phone user.
func (s *MemoryStore) UpsertUser(_ context.Context, phone string, verifiedAt time.Time) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if user, ok := s.users[phone]; ok {
		s.verified[phone] = verifiedAt
		return user, nil
	}
	user := User{ID: s.nextID, Phone: phone}
	s.nextID++
	s.users[phone] = user
	s.verified[phone] = verifiedAt
	return user, nil
}
