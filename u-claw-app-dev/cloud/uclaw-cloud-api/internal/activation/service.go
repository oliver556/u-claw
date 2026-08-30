package activation

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"uclaw-cloud-api/internal/license"
)

var activationCodePattern = regexp.MustCompile(`^(?:[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2,5}|[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}-[A-Z0-9]{6})$`)
var usernamePattern = regexp.MustCompile(`^UCLAW-[A-Z0-9]{6,32}$`)
var phonePattern = regexp.MustCompile(`^1[3-9]\d{9}$`)

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

// FirstStartRequest carries the activation-only phone/code request, with legacy username compatibility.
type FirstStartRequest struct {
	Username              string
	Phone                 string
	UserID                int64
	ActivationCode        string
	USBFingerprintSummary string
	IdempotencyKey        string
}

// FirstStartResult is the public activation envelope consumed by Electron activation-only mode.
type FirstStartResult struct {
	OK                    bool              `json:"ok"`
	ActivationID          string            `json:"activationId"`
	Status                string            `json:"status"`
	Stage                 string            `json:"stage"`
	UsernameMasked        string            `json:"usernameMasked"`
	PhoneMasked           string            `json:"phoneMasked,omitempty"`
	AccessToken           string            `json:"accessToken,omitempty"`
	USBFingerprintSummary string            `json:"usbFingerprintSummary"`
	ArtifactStatus        string            `json:"artifactStatus"`
	Message               string            `json:"message"`
	NewAPIBaseURL         string            `json:"newapiBaseUrl"`
	NewAPIToken           string            `json:"newapiToken"`
	TokenVersion          int               `json:"tokenVersion"`
	DefaultModels         DefaultModels     `json:"defaultModels"`
	LicenseArtifact       license.Artifact  `json:"licenseArtifact"`
	UpdateCredential      *UpdateCredential `json:"updateCredential,omitempty"`
}

// UpdateCredential is the one-time hard-update credential returned to the trusted Electron main process.
type UpdateCredential struct {
	SchemaVersion  string   `json:"schemaVersion"`
	UpdateCheckURL string   `json:"updateCheckUrl"`
	DeviceID       string   `json:"deviceId"`
	DeviceToken    string   `json:"deviceToken"`
	PlatformKeys   []string `json:"platformKeys,omitempty"`
	IssuedAt       string   `json:"issuedAt"`
}

// UpdateCredentialRequest binds hard-update token issuance to the accepted activation.
type UpdateCredentialRequest struct {
	ActivationID          string
	UserID                int64
	Principal             string
	ActivationCode        string
	USBFingerprintSummary string
	IssuedAt              time.Time
}

// CommitRequest records the client write-helper result for a server-bound activation.
type CommitRequest struct {
	ActivationID string
	WriteStatus  string
}

// CommitResult reports whether the activation reached the committed checkpoint.
type CommitResult struct {
	OK           bool   `json:"ok"`
	ActivationID string `json:"activationId"`
	Status       string `json:"status"`
	Stage        string `json:"stage"`
	Message      string `json:"message"`
}

// ProvisionRequest identifies the Bavi-box user that needs a New API account.
type ProvisionRequest struct {
	UserID int64
	Phone  string
}

// ProvisionResult carries the New API client credential returned to Bavi-box desktop.
type ProvisionResult struct {
	NewAPIUserID int64
	Token        string
	TokenVersion int
}

// NewAPIProvisioner creates or restores the user's New API account and token.
type NewAPIProvisioner interface {
	ProvisionNewAPI(ctx context.Context, req ProvisionRequest) (ProvisionResult, error)
}

// Store persists activation-code binding decisions.
type Store interface {
	Redeem(ctx context.Context, code string, userID int64, phone string, at time.Time) error
}

// FirstStartStore persists activation-only account/code binding after phone or legacy username validation.
type FirstStartStore interface {
	BindFirstStart(ctx context.Context, code string, username string, at time.Time) (int64, error)
}

// FirstStartAttempt captures the server-side checkpoint for activation-only startup.
type FirstStartAttempt struct {
	ActivationID          string
	UsernameNormalized    string
	USBFingerprintSummary string
	Stage                 string
	ArtifactStatus        string
}

// FirstStartAttemptStore persists activation-only write-helper checkpoints.
type FirstStartAttemptStore interface {
	RecordFirstStartAttempt(ctx context.Context, attempt FirstStartAttempt, at time.Time) error
	CommitFirstStartAttempt(ctx context.Context, activationID string, writeStatus string, at time.Time) error
}

// LicenseSigner signs server-issued license artifacts for client write helpers.
type LicenseSigner interface {
	Sign(req license.Request) (license.Artifact, error)
}

// UpdateCredentialIssuer returns a device token for startup hard-update checks.
type UpdateCredentialIssuer interface {
	IssueUpdateCredential(ctx context.Context, req UpdateCredentialRequest) (UpdateCredential, error)
}

// ErrUpdateCredentialNotAvailable lets constrained issuers skip unrelated activation requests.
var ErrUpdateCredentialNotAvailable = errors.New("update credential is not available for this activation")

// Config controls the activation redeem slice.
type Config struct {
	AllowAnyCode           bool
	NewAPIBaseURL          string
	PreviewToken           string
	DefaultTextModel       string
	DefaultImageModel      string
	DefaultVideoModel      string
	Provisioner            NewAPIProvisioner
	LicenseSigner          LicenseSigner
	UpdateCredentialIssuer UpdateCredentialIssuer
}

// Service owns activation-code validation and the client-facing activation contract.
type Service struct {
	store   Store
	cfg     Config
	now     func() time.Time
	mu      sync.Mutex
	commits map[string]string
}

// NewService creates an activation service with conservative local defaults.
func NewService(store Store, cfg Config) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("activation store is required")
	}
	if strings.TrimSpace(cfg.NewAPIBaseURL) == "" {
		cfg.NewAPIBaseURL = "https://api.yiyong.me/v1"
	}
	if strings.TrimSpace(cfg.PreviewToken) == "" {
		cfg.PreviewToken = "uclaw-preview-newapi-token"
	}
	if strings.TrimSpace(cfg.DefaultTextModel) == "" {
		cfg.DefaultTextModel = "newapi/gpt-5.5"
	}
	if strings.TrimSpace(cfg.DefaultImageModel) == "" {
		cfg.DefaultImageModel = "newapi/gpt-image-2"
	}
	if cfg.LicenseSigner == nil {
		cfg.LicenseSigner = license.NewDevelopmentSigner()
	}
	return &Service{store: store, cfg: cfg, now: time.Now, commits: make(map[string]string)}, nil
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
	token := s.cfg.PreviewToken
	tokenVersion := 1
	if s.cfg.Provisioner != nil {
		result, err := s.cfg.Provisioner.ProvisionNewAPI(ctx, ProvisionRequest{UserID: req.UserID, Phone: phone})
		if err != nil {
			return RedeemResult{}, err
		}
		token = result.Token
		tokenVersion = result.TokenVersion
	}
	return RedeemResult{
		Status:        "activated",
		PhoneMasked:   maskPhone(phone),
		NewAPIBaseURL: strings.TrimRight(s.cfg.NewAPIBaseURL, "/"),
		NewAPIToken:   token,
		TokenVersion:  tokenVersion,
		DefaultModels: DefaultModels{
			Text:  s.cfg.DefaultTextModel,
			Image: s.cfg.DefaultImageModel,
			Video: s.cfg.DefaultVideoModel,
		},
	}, nil
}

// ActivateFirstStart validates phone/code activation from the restricted startup UI.
func (s *Service) ActivateFirstStart(ctx context.Context, req FirstStartRequest) (FirstStartResult, error) {
	username := strings.ToUpper(strings.TrimSpace(req.Username))
	phone := strings.TrimSpace(req.Phone)
	code := strings.ToUpper(strings.TrimSpace(req.ActivationCode))
	usbSummary := strings.TrimSpace(req.USBFingerprintSummary)
	if usbSummary == "" {
		usbSummary = "UNAVAILABLE"
	}
	principal := username
	userID := syntheticUserID(username)
	if phone != "" {
		if !phonePattern.MatchString(phone) {
			return FirstStartResult{}, fmt.Errorf("phone is invalid")
		}
		principal = phone
		if req.UserID > 0 {
			userID = req.UserID
		} else {
			userID = syntheticUserID(phone)
		}
	} else if !usernamePattern.MatchString(username) {
		return FirstStartResult{}, fmt.Errorf("activation username is invalid")
	}
	if !activationCodePattern.MatchString(code) {
		return FirstStartResult{}, fmt.Errorf("activation code is invalid")
	}
	at := s.now()
	if firstStartStore, ok := s.store.(FirstStartStore); ok {
		boundUserID, err := firstStartStore.BindFirstStart(ctx, code, principal, at)
		if err != nil {
			return FirstStartResult{}, err
		}
		if req.UserID <= 0 {
			userID = boundUserID
		}
	} else {
		if err := s.store.Redeem(ctx, code, userID, principal, at); err != nil {
			return FirstStartResult{}, err
		}
	}
	result, err := s.provisionResult(ctx, userID, principal)
	if err != nil {
		return FirstStartResult{}, err
	}
	activationID := activationIDFor(principal, code, usbSummary, req.IdempotencyKey)
	licenseArtifact, err := s.cfg.LicenseSigner.Sign(license.Request{
		ActivationID:          activationID,
		Subject:               principal,
		USBFingerprintSummary: usbSummary,
		NewAPIBaseURL:         result.NewAPIBaseURL,
		TokenVersion:          result.TokenVersion,
		DefaultModels: license.DefaultModels{
			Text:  result.DefaultModels.Text,
			Image: result.DefaultModels.Image,
			Video: result.DefaultModels.Video,
		},
		IssuedAt: at,
	})
	if err != nil {
		return FirstStartResult{}, err
	}
	var updateCredential *UpdateCredential
	if s.cfg.UpdateCredentialIssuer != nil {
		credential, err := s.cfg.UpdateCredentialIssuer.IssueUpdateCredential(ctx, UpdateCredentialRequest{
			ActivationID:          activationID,
			UserID:                userID,
			Principal:             principal,
			ActivationCode:        code,
			USBFingerprintSummary: usbSummary,
			IssuedAt:              at,
		})
		if err != nil && !errors.Is(err, ErrUpdateCredentialNotAvailable) {
			return FirstStartResult{}, err
		}
		if err == nil {
			updateCredential = &credential
		}
	}
	if attemptStore, ok := s.store.(FirstStartAttemptStore); ok {
		if err := attemptStore.RecordFirstStartAttempt(ctx, FirstStartAttempt{
			ActivationID:          activationID,
			UsernameNormalized:    principal,
			USBFingerprintSummary: usbSummary,
			Stage:                 "server_bound",
			ArtifactStatus:        "pending_client_write",
		}, at); err != nil {
			return FirstStartResult{}, err
		}
	}
	s.mu.Lock()
	s.commits[activationID] = "server_bound"
	s.mu.Unlock()
	return FirstStartResult{
		OK:                    true,
		ActivationID:          activationID,
		Status:                "server_bound",
		Stage:                 "server_bound",
		UsernameMasked:        maskFirstStartPrincipal(principal),
		PhoneMasked:           maskPhone(phone),
		USBFingerprintSummary: usbSummary,
		ArtifactStatus:        "pending_client_write",
		Message:               "Activation accepted; client write helper has not committed authorization files yet.",
		NewAPIBaseURL:         result.NewAPIBaseURL,
		NewAPIToken:           result.NewAPIToken,
		TokenVersion:          result.TokenVersion,
		DefaultModels:         result.DefaultModels,
		LicenseArtifact:       licenseArtifact,
		UpdateCredential:      updateCredential,
	}, nil
}

// CommitFirstStart records that the desktop write helper verified local authorization files.
func (s *Service) CommitFirstStart(ctx context.Context, req CommitRequest) (CommitResult, error) {
	activationID := strings.TrimSpace(req.ActivationID)
	writeStatus := strings.TrimSpace(req.WriteStatus)
	if activationID == "" {
		return CommitResult{}, fmt.Errorf("activation id is required")
	}
	if writeStatus != "verified" {
		return CommitResult{}, fmt.Errorf("write status must be verified")
	}
	if attemptStore, ok := s.store.(FirstStartAttemptStore); ok {
		if err := attemptStore.CommitFirstStartAttempt(ctx, activationID, writeStatus, s.now()); err != nil {
			return CommitResult{}, err
		}
		return firstStartCommittedResult(activationID), nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.commits[activationID]; !ok {
		return CommitResult{}, fmt.Errorf("activation id is unknown")
	}
	s.commits[activationID] = "committed"
	return firstStartCommittedResult(activationID), nil
}

// firstStartCommittedResult keeps persistent and in-memory commit responses identical.
func firstStartCommittedResult(activationID string) CommitResult {
	return CommitResult{
		OK:           true,
		ActivationID: activationID,
		Status:       "committed",
		Stage:        "committed",
		Message:      "Client write helper reported verified authorization files.",
	}
}

// provisionResult creates or restores New API credentials for an activated principal.
func (s *Service) provisionResult(ctx context.Context, userID int64, phone string) (RedeemResult, error) {
	token := s.cfg.PreviewToken
	tokenVersion := 1
	if s.cfg.Provisioner != nil {
		result, err := s.cfg.Provisioner.ProvisionNewAPI(ctx, ProvisionRequest{UserID: userID, Phone: phone})
		if err != nil {
			return RedeemResult{}, err
		}
		token = result.Token
		tokenVersion = result.TokenVersion
	}
	return RedeemResult{
		Status:        "activated",
		PhoneMasked:   maskPhone(phone),
		NewAPIBaseURL: strings.TrimRight(s.cfg.NewAPIBaseURL, "/"),
		NewAPIToken:   token,
		TokenVersion:  tokenVersion,
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
	if existing, exists := s.bound[code]; exists {
		if existing.UserID == userID && existing.Phone == phone {
			return nil
		}
		return fmt.Errorf("activation code is already bound")
	}
	if !s.allowAnyCode {
		return fmt.Errorf("activation code store is not configured")
	}
	s.bound[code] = boundCode{UserID: userID, Phone: phone, BoundAt: at}
	return nil
}

// BindFirstStart binds a startup activation code to a normalized account once.
func (s *MemoryStore) BindFirstStart(ctx context.Context, code string, username string, at time.Time) (int64, error) {
	userID := syntheticUserID(username)
	if err := s.Redeem(ctx, code, userID, username, at); err != nil {
		return 0, err
	}
	return userID, nil
}

// maskPhone returns the same phone display shape as auth without coupling packages.
func maskPhone(phone string) string {
	phone = strings.TrimSpace(phone)
	if len(phone) != 11 {
		return phone
	}
	return phone[:3] + "****" + phone[7:]
}

// maskFirstStartPrincipal displays either a phone account or legacy username without exposing extra data.
func maskFirstStartPrincipal(principal string) string {
	if phonePattern.MatchString(strings.TrimSpace(principal)) {
		return maskPhone(principal)
	}
	return strings.ToUpper(strings.TrimSpace(principal))
}

// syntheticUserID creates a stable positive id for first-start accounts before account tables exist.
func syntheticUserID(username string) int64 {
	sum := sha256.Sum256([]byte(strings.ToUpper(strings.TrimSpace(username))))
	return int64(binary.BigEndian.Uint64(sum[:8]) & ((1 << 62) - 1))
}

// activationIDFor derives a stable idempotent id without exposing the activation code.
func activationIDFor(username string, code string, usbSummary string, idempotencyKey string) string {
	parts := strings.Join([]string{
		strings.ToUpper(strings.TrimSpace(username)),
		strings.ToUpper(strings.TrimSpace(code)),
		strings.TrimSpace(usbSummary),
		strings.TrimSpace(idempotencyKey),
	}, "\x00")
	sum := sha256.Sum256([]byte(parts))
	return "act_" + hex.EncodeToString(sum[:])[:24]
}
