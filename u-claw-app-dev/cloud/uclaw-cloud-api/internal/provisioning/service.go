package provisioning

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"uclaw-cloud-api/internal/activation"
	"uclaw-cloud-api/internal/newapi"
)

// Store persists the New API account mapping without storing raw API keys.
type Store interface {
	SaveNewAPIAccount(ctx context.Context, account Account) error
}

// Account describes the stable mapping between a U-Claw user and a New API user.
type Account struct {
	UClawUserID      int64
	NewAPIBaseURL    string
	NewAPIUserID     int64
	NewAPIUsername   string
	TokenFingerprint string
	TokenRotatedAt   time.Time
}

// Config controls New API provisioning side effects during activation.
type Config struct {
	ClientBaseURL  string
	TokenName      string
	InitialQuota   int64
	PasswordSecret string
}

// Service provisions New API user/token/quota for a U-Claw activation.
type Service struct {
	admin *newapi.Client
	store Store
	cfg   Config
	now   func() time.Time
}

// NewService creates a New API provisioner used by activation redeem.
func NewService(admin *newapi.Client, store Store, cfg Config) (*Service, error) {
	if admin == nil {
		return nil, fmt.Errorf("newapi admin client is required")
	}
	if store == nil {
		return nil, fmt.Errorf("newapi account store is required")
	}
	cfg.ClientBaseURL = strings.TrimRight(strings.TrimSpace(cfg.ClientBaseURL), "/")
	if cfg.ClientBaseURL == "" {
		return nil, fmt.Errorf("newapi client base url is required")
	}
	if strings.TrimSpace(cfg.TokenName) == "" {
		cfg.TokenName = "uclaw-main"
	}
	if strings.TrimSpace(cfg.PasswordSecret) == "" {
		return nil, fmt.Errorf("newapi user password secret is required")
	}
	return &Service{admin: admin, store: store, cfg: cfg, now: time.Now}, nil
}

// ProvisionNewAPI creates a same-phone New API user, API token, initial quota, and local mapping.
func (s *Service) ProvisionNewAPI(ctx context.Context, req activation.ProvisionRequest) (activation.ProvisionResult, error) {
	phone := strings.TrimSpace(req.Phone)
	if req.UserID <= 0 {
		return activation.ProvisionResult{}, fmt.Errorf("uclaw user id is required")
	}
	if phone == "" {
		return activation.ProvisionResult{}, fmt.Errorf("phone is required")
	}

	password := s.passwordFor(req.UserID, phone)
	createErr := s.admin.CreateUser(ctx, newapi.CreateUserRequest{
		Username:    phone,
		Password:    password,
		DisplayName: phone,
	})
	user, ok, err := s.admin.SearchUserByUsername(ctx, phone)
	if err != nil {
		return activation.ProvisionResult{}, err
	}
	if !ok || user.ID <= 0 {
		if createErr != nil {
			return activation.ProvisionResult{}, createErr
		}
		return activation.ProvisionResult{}, fmt.Errorf("newapi user was not found after creation")
	}
	if createErr != nil && !strings.Contains(createErr.Error(), "users.username") {
		return activation.ProvisionResult{}, createErr
	}

	login, err := s.admin.Login(ctx, phone, password)
	if err != nil {
		return activation.ProvisionResult{}, err
	}
	userClient, err := s.admin.WithAccessToken(login.Data.AccessToken)
	if err != nil {
		return activation.ProvisionResult{}, err
	}
	if err := userClient.CreateToken(ctx, newapi.CreateTokenRequest{Name: s.cfg.TokenName}, nil); err != nil {
		return activation.ProvisionResult{}, err
	}
	token, ok, err := userClient.SearchTokenByName(ctx, s.cfg.TokenName)
	if err != nil {
		return activation.ProvisionResult{}, err
	}
	if !ok || token.ID <= 0 {
		return activation.ProvisionResult{}, fmt.Errorf("newapi token was not found after creation")
	}
	key, err := userClient.FetchTokenKey(ctx, token.ID)
	if err != nil {
		return activation.ProvisionResult{}, err
	}

	if s.cfg.InitialQuota > 0 {
		if err := s.admin.AddQuota(ctx, newapi.AddQuotaRequest{UserID: user.ID, Quota: s.cfg.InitialQuota}); err != nil {
			return activation.ProvisionResult{}, err
		}
	}
	if err := s.store.SaveNewAPIAccount(ctx, Account{
		UClawUserID:      req.UserID,
		NewAPIBaseURL:    s.cfg.ClientBaseURL,
		NewAPIUserID:     user.ID,
		NewAPIUsername:   phone,
		TokenFingerprint: tokenFingerprint(key),
		TokenRotatedAt:   s.now(),
	}); err != nil {
		return activation.ProvisionResult{}, err
	}
	return activation.ProvisionResult{NewAPIUserID: user.ID, Token: key, TokenVersion: 1}, nil
}

// passwordFor derives a retry-stable New API dashboard password without storing plaintext.
func (s *Service) passwordFor(userID int64, phone string) string {
	mac := hmac.New(sha256.New, []byte(s.cfg.PasswordSecret))
	_, _ = mac.Write([]byte(fmt.Sprintf("%d:%s", userID, phone)))
	sum := mac.Sum(nil)
	return "Uclaw@" + base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:5])
}

// tokenFingerprint stores an audit-safe digest instead of the raw API key.
func tokenFingerprint(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}
