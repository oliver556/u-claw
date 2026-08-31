package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"sync"
	"time"
)

var phonePattern = regexp.MustCompile(`^1[3-9]\d{9}$`)

// ServiceConfig controls SMS login behavior for local dev and production wiring.
type ServiceConfig struct {
	CodeTTL                    time.Duration
	TokenTTL                   time.Duration
	DevSMSCode                 string
	CodePepper                 string
	ExposeCodes                bool
	UseDevSMSCode              bool
	AllowFixedLoginWithoutSend bool
	Provider                   SMSProvider
}

// User is the verified Bavi-box account returned to API clients.
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

// SMSDelivery is the provider-neutral payload for real SMS adapters.
type SMSDelivery struct {
	Phone   string
	Purpose string
	Code    string
}

// SMSProvider sends verification codes through a concrete vendor.
type SMSProvider interface {
	SendCode(ctx context.Context, delivery SMSDelivery) error
}

// DevelopmentSMSProvider is the local no-op sender used by tests and dev runs.
type DevelopmentSMSProvider struct{}

// SendCode accepts the code without contacting an external SMS vendor.
func (DevelopmentSMSProvider) SendCode(_ context.Context, _ SMSDelivery) error {
	return nil
}

// ReservedSMSProvider keeps the production SMS seam explicit until the vendor SDK is wired.
type ReservedSMSProvider struct {
	Name string
}

// SendCode fails closed so production cannot silently pretend SMS was sent.
func (p ReservedSMSProvider) SendCode(_ context.Context, _ SMSDelivery) error {
	name := strings.TrimSpace(p.Name)
	if name == "" {
		name = "unknown"
	}
	return fmt.Errorf("sms provider %s is reserved but not implemented", name)
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
	if cfg.Provider == nil {
		cfg.Provider = DevelopmentSMSProvider{}
	}
	return &Service{store: store, tokens: tokens, cfg: cfg, now: time.Now}, nil
}

// SendSMS records a login code and returns a provider-neutral status.
func (s *Service) SendSMS(ctx context.Context, phone string, purpose string) (SendSMSResult, error) {
	phone, purpose, err := normalizeSMSInput(phone, purpose)
	if err != nil {
		return SendSMSResult{}, err
	}

	code, err := s.nextSMSCode()
	if err != nil {
		return SendSMSResult{}, err
	}
	record := SMSCode{
		CodeHash:  s.hashCode(phone, purpose, code),
		ExpiresAt: s.now().Add(s.cfg.CodeTTL),
	}
	if err := s.store.SaveSMSCode(ctx, phone, purpose, record); err != nil {
		return SendSMSResult{}, err
	}
	if err := s.cfg.Provider.SendCode(ctx, SMSDelivery{Phone: phone, Purpose: purpose, Code: code}); err != nil {
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
		if !s.canUseFixedCodeWithoutSend(code) {
			return LoginResult{}, err
		}
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

// canUseFixedCodeWithoutSend enables temporary staging login while SMS delivery is unavailable.
func (s *Service) canUseFixedCodeWithoutSend(code string) bool {
	return s.cfg.AllowFixedLoginWithoutSend &&
		s.cfg.UseDevSMSCode &&
		strings.TrimSpace(code) == strings.TrimSpace(s.cfg.DevSMSCode)
}

// VerifyAccessToken validates a Bavi-box access token for authenticated API calls.
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

// nextSMSCode returns a dev fixture code only when explicitly allowed; otherwise
// it uses crypto/rand so production logins are not tied to a static code.
func (s *Service) nextSMSCode() (string, error) {
	if s.cfg.UseDevSMSCode {
		return strings.TrimSpace(s.cfg.DevSMSCode), nil
	}
	value, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", fmt.Errorf("generate sms code: %w", err)
	}
	return fmt.Sprintf("%06d", value.Int64()), nil
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
