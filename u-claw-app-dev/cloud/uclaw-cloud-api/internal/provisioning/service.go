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

// Account describes the stable mapping between a Bavi-box user and a New API user.
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
	UserGroup      string
}

// Service provisions New API user/token/quota for a Bavi-box activation.
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
	cfg.UserGroup = strings.TrimSpace(cfg.UserGroup)
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

	password := DeriveUserPassword(req.UserID, phone, s.cfg.PasswordSecret)
	createErr := s.admin.CreateUser(ctx, newapi.CreateUserRequest{
		Username:    phone,
		Password:    password,
		DisplayName: phone,
		Group:       firstNonEmpty(req.Group, s.cfg.UserGroup),
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
	if createErr != nil && !isDuplicateUsernameError(createErr) {
		return activation.ProvisionResult{}, createErr
	}

	userClient, err := s.userTokenClient(ctx, user.ID, phone, password, req.ForceRotateToken)
	if err != nil {
		return activation.ProvisionResult{}, err
	}
	tokenName := s.tokenName(req.ForceRotateToken)
	var createdToken newapi.CreateTokenResponse
	if err := userClient.CreateToken(ctx, newapi.CreateTokenRequest{
		Name:           tokenName,
		ExpiresAt:      -1,
		UnlimitedQuota: true,
	}, &createdToken); err != nil {
		return activation.ProvisionResult{}, err
	}
	key := createdToken.APIKey()
	if key == "" {
		token, ok, err := userClient.SearchTokenByName(ctx, tokenName)
		if err != nil {
			return activation.ProvisionResult{}, err
		}
		if !ok || token.ID <= 0 {
			return activation.ProvisionResult{}, fmt.Errorf("newapi token was not found after creation")
		}
		key, err = userClient.FetchTokenKey(ctx, token.ID)
		if err != nil {
			return activation.ProvisionResult{}, err
		}
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
	tokenVersion := 1
	if req.ForceRotateToken {
		tokenVersion = int(s.now().Unix())
	}
	return activation.ProvisionResult{NewAPIUserID: user.ID, Token: key, TokenVersion: tokenVersion}, nil
}

// tokenName keeps first activation stable but gives refresh requests a unique
// token name so New API search/fetch cannot return a revoked older key.
func (s *Service) tokenName(forceRotate bool) string {
	if !forceRotate {
		return s.cfg.TokenName
	}
	return fmt.Sprintf("%s-%s", s.cfg.TokenName, s.now().UTC().Format("20060102150405"))
}

// userTokenClient normally uses the user's dashboard token because key reveal
// endpoints require user scope. Refresh can fall back to admin user scope when
// New API rejects another dashboard login due to session limits.
func (s *Service) userTokenClient(ctx context.Context, userID int64, phone string, password string, allowAdminFallback bool) (*newapi.Client, error) {
	login, err := s.admin.Login(ctx, phone, password)
	if err != nil {
		if allowAdminFallback && isSessionLimitError(err) {
			return s.admin.WithAdminUser(userID)
		}
		return nil, err
	}
	return s.admin.WithAccessToken(login.Data.AccessToken, userID)
}

func isSessionLimitError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToUpper(err.Error())
	return strings.Contains(message, "AUTH_SESSION_LIMIT")
}

// isDuplicateUsernameError tolerates New API retries after a prior partial activation created the user.
func isDuplicateUsernameError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "users.username") ||
		strings.Contains(message, "users_username") ||
		strings.Contains(message, "duplicate key")
}

// DeriveUserPassword derives a retry-stable New API dashboard password without storing plaintext.
func DeriveUserPassword(userID int64, phone string, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(fmt.Sprintf("%d:%s", userID, phone)))
	sum := mac.Sum(nil)
	return "Uclaw@" + base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:5])
}

// tokenFingerprint stores an audit-safe digest instead of the raw API key.
func tokenFingerprint(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
