package activation

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

var activationCodePattern = regexp.MustCompile(`^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2,5}$`)

// DefaultModels describes model ids the desktop client should write into OpenClaw config.
type DefaultModels struct {
	Text  string `json:"text"`
	Image string `json:"image"`
	Video string `json:"video"`
}

// RedeemRequest carries the authenticated user and U disk code for first activation.
type RedeemRequest struct {
	UserID         int64
	Phone          string
	ActivationCode string
	DeviceSummary  string
}

// RedeemResult is the client payload needed to finish local model configuration.
type RedeemResult struct {
	Status        string        `json:"status"`
	PhoneMasked   string        `json:"phoneMasked"`
	NewAPIBaseURL string        `json:"newapiBaseUrl"`
	NewAPIToken   string        `json:"newapiToken"`
	TokenVersion  int           `json:"tokenVersion"`
	DefaultModels DefaultModels `json:"defaultModels"`
}

// Store persists activation-code binding decisions.
type Store interface {
	Redeem(ctx context.Context, code string, userID int64, phone string, at time.Time) error
}

// Config controls the activation redeem slice.
type Config struct {
	AllowAnyCode      bool
	NewAPIBaseURL     string
	PreviewToken      string
	DefaultTextModel  string
	DefaultImageModel string
	DefaultVideoModel string
}

// Service owns activation-code validation and the client-facing activation contract.
type Service struct {
	store Store
	cfg   Config
	now   func() time.Time
}

// NewService creates an activation service with conservative local defaults.
func NewService(store Store, cfg Config) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("activation store is required")
	}
	if strings.TrimSpace(cfg.NewAPIBaseURL) == "" {
		cfg.NewAPIBaseURL = "https://api.gmnlee.com/v1"
	}
	if strings.TrimSpace(cfg.PreviewToken) == "" {
		cfg.PreviewToken = "uclaw-preview-newapi-token"
	}
	if strings.TrimSpace(cfg.DefaultTextModel) == "" {
		cfg.DefaultTextModel = "custom/gpt-5.5"
	}
	if strings.TrimSpace(cfg.DefaultImageModel) == "" {
		cfg.DefaultImageModel = "litellm/gpt-image-2"
	}
	if strings.TrimSpace(cfg.DefaultVideoModel) == "" {
		cfg.DefaultVideoModel = "xai/jimeng-video-3-720p"
	}
	return &Service{store: store, cfg: cfg, now: time.Now}, nil
}

// Redeem validates and binds one activation code, then returns client config.
func (s *Service) Redeem(ctx context.Context, req RedeemRequest) (RedeemResult, error) {
	phone := strings.TrimSpace(req.Phone)
	code := strings.ToUpper(strings.TrimSpace(req.ActivationCode))
	if req.UserID <= 0 {
		return RedeemResult{}, fmt.Errorf("user id is required")
	}
	if phone == "" {
		return RedeemResult{}, fmt.Errorf("phone is required")
	}
	if !activationCodePattern.MatchString(code) {
		return RedeemResult{}, fmt.Errorf("activation code is invalid")
	}
	if err := s.store.Redeem(ctx, code, req.UserID, phone, s.now()); err != nil {
		return RedeemResult{}, err
	}
	return RedeemResult{
		Status:        "activated",
		PhoneMasked:   maskPhone(phone),
		NewAPIBaseURL: strings.TrimRight(s.cfg.NewAPIBaseURL, "/"),
		NewAPIToken:   s.cfg.PreviewToken,
		TokenVersion:  1,
		DefaultModels: DefaultModels{
			Text:  s.cfg.DefaultTextModel,
			Image: s.cfg.DefaultImageModel,
			Video: s.cfg.DefaultVideoModel,
		},
	}, nil
}

// MemoryStore is a local-development activation store before PostgreSQL wiring.
type MemoryStore struct {
	mu           sync.Mutex
	allowAnyCode bool
	bound        map[string]boundCode
}

type boundCode struct {
	UserID  int64
	Phone   string
	BoundAt time.Time
}

// NewMemoryStore returns an in-process activation-code store.
func NewMemoryStore(allowAnyCode bool) *MemoryStore {
	return &MemoryStore{
		allowAnyCode: allowAnyCode,
		bound:        make(map[string]boundCode),
	}
}

// Redeem binds an activation code once.
func (s *MemoryStore) Redeem(_ context.Context, code string, userID int64, phone string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	code = strings.ToUpper(strings.TrimSpace(code))
	if _, exists := s.bound[code]; exists {
		return fmt.Errorf("activation code is already bound")
	}
	if !s.allowAnyCode {
		return fmt.Errorf("activation code store is not configured")
	}
	s.bound[code] = boundCode{UserID: userID, Phone: phone, BoundAt: at}
	return nil
}

// maskPhone returns the same phone display shape as auth without coupling packages.
func maskPhone(phone string) string {
	phone = strings.TrimSpace(phone)
	if len(phone) != 11 {
		return phone
	}
	return phone[:3] + "****" + phone[7:]
}
