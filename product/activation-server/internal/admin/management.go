package admin

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"time"

	"u-claw-activation-server/internal/security"
)

var ErrSecretReplayUnavailable = errors.New("secret replay unavailable")

type SecretBinding = security.SecretBinding
type SecretEncrypter interface {
	Encrypt(context.Context, security.SecretBinding, []byte) ([]byte, error)
}

type MappingInput struct {
	InventoryID, NewAPIUserID, NewAPIUsername, BaseURL, DefaultModel string
	AllowedModels                                                    []string
	RequestsPerMinute, ConcurrentRequests                            int
	APIKey, APIKeyEnvelope, APIKeyFingerprint                        []byte
	KeyVersion                                                       string
	Operation                                                        Operation
}
type MappingSummary struct {
	InventoryID        string   `json:"inventoryId"`
	NewAPIUserID       string   `json:"newApiUserId"`
	NewAPIUsername     string   `json:"newApiUsername"`
	BaseURLHost        string   `json:"baseUrlHost"`
	DefaultModel       string   `json:"defaultModel"`
	AllowedModels      []string `json:"allowedModels"`
	RequestsPerMinute  int      `json:"requestsPerMinute"`
	ConcurrentRequests int      `json:"concurrentRequests"`
	KeyVersion         string   `json:"keyVersion"`
	Status             string   `json:"status"`
	UpdatedAt          string   `json:"updatedAt,omitempty"`
}

type DeviceTokenAction string

const (
	DeviceTokenDisable DeviceTokenAction = "disable"
	DeviceTokenEnable  DeviceTokenAction = "enable"
	DeviceTokenRevoke  DeviceTokenAction = "revoke"
	DeviceTokenReissue DeviceTokenAction = "reissue"
)

type DeviceTokenMutation struct {
	Action                   DeviceTokenAction
	LicenseID, ConfirmTarget string
	Operation                Operation
	ReplacementTokenID       string
	ReplacementDigest        []byte
	DeviceToken              string
}
type DeviceTokenResult struct {
	DeviceTokenID string `json:"deviceTokenId"`
	InventoryID   string `json:"inventoryId"`
	DeviceID      string `json:"deviceId"`
	LicenseID     string `json:"licenseId"`
	Status        string `json:"status"`
	DeviceToken   string `json:"-"`
	Replayed      bool   `json:"-"`
}
type DeviceTokenReissuePlan struct {
	Mutation DeviceTokenMutation
	Secret   DeviceTokenResult
}

func (s *Service) SetMapping(ctx context.Context, input MappingInput) (MappingSummary, error) {
	if s.secretEnvelope == nil || !validMapping(input) {
		return MappingSummary{}, ErrInvalidInput
	}
	input.KeyVersion = s.keyVersion
	workingKey := append([]byte(nil), input.APIKey...)
	fingerprint := sha256.Sum256(workingKey)
	input.APIKeyFingerprint = append([]byte(nil), fingerprint[:]...)
	envelope, err := s.secretEnvelope.Encrypt(ctx, security.SecretBinding{Purpose: "new-api-key", SubjectID: input.InventoryID, KeyVersion: input.KeyVersion}, workingKey)
	clear(workingKey)
	if err != nil {
		return MappingSummary{}, ErrUnavailable
	}
	input.APIKeyEnvelope = envelope
	input.APIKey = nil
	return s.repository.SetMapping(ctx, input)
}
func (s *Service) ShowMapping(ctx context.Context, inventoryID string) (MappingSummary, error) {
	if !uuidPattern.MatchString(inventoryID) {
		return MappingSummary{}, ErrInvalidInput
	}
	return s.repository.ShowMapping(ctx, inventoryID)
}
func (s *Service) MutateDeviceToken(ctx context.Context, mutation DeviceTokenMutation) (DeviceTokenResult, error) {
	if !uuidPattern.MatchString(mutation.LicenseID) || mutation.ConfirmTarget != TargetDigest(mutation.LicenseID) || validateOperation(mutation.Operation, true) != nil || !validDeviceTokenAction(mutation.Action) {
		return DeviceTokenResult{}, ErrInvalidInput
	}
	if mutation.Action == DeviceTokenReissue {
		return DeviceTokenResult{}, ErrInvalidInput
	}
	return s.repository.MutateDeviceToken(ctx, mutation)
}
func (s *Service) PrepareDeviceTokenReissue(ctx context.Context, mutation DeviceTokenMutation) (DeviceTokenReissuePlan, error) {
	if mutation.Action != DeviceTokenReissue || !uuidPattern.MatchString(mutation.LicenseID) || mutation.ConfirmTarget != TargetDigest(mutation.LicenseID) || validateOperation(mutation.Operation, true) != nil {
		return DeviceTokenReissuePlan{}, ErrInvalidInput
	}
	entropy := s.derive(mutation.Operation.IdempotencyKey, "device-token-reissue", 0, 48)
	raw := entropy[:32]
	token := "uclaw_dt_" + base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, s.pepper)
	mac.Write([]byte(token))
	mutation.ReplacementDigest = mac.Sum(nil)
	id, err := randomUUID(bytes.NewReader(entropy[32:]))
	if err != nil {
		return DeviceTokenReissuePlan{}, ErrUnavailable
	}
	mutation.ReplacementTokenID = id
	target, err := s.repository.PrepareDeviceTokenTarget(ctx, mutation.LicenseID)
	if err != nil {
		return DeviceTokenReissuePlan{}, err
	}
	return DeviceTokenReissuePlan{Mutation: mutation, Secret: DeviceTokenResult{DeviceTokenID: id, InventoryID: target.InventoryID, DeviceID: target.DeviceID, LicenseID: mutation.LicenseID, DeviceToken: token}}, nil
}
func (s *Service) ExecuteDeviceTokenReissue(ctx context.Context, plan DeviceTokenReissuePlan, beforeCommit func() error) (DeviceTokenResult, error) {
	if beforeCommit == nil {
		return DeviceTokenResult{}, ErrInvalidInput
	}
	result, err := s.repository.ReissueDeviceToken(ctx, plan.Mutation, beforeCommit)
	if err == nil && result.Replayed {
		return DeviceTokenResult{}, ErrSecretReplayUnavailable
	}
	if err == nil {
		result.DeviceToken = plan.Secret.DeviceToken
	}
	return result, err
}
func validDeviceTokenAction(a DeviceTokenAction) bool {
	return a == DeviceTokenDisable || a == DeviceTokenEnable || a == DeviceTokenRevoke || a == DeviceTokenReissue
}
func validMapping(v MappingInput) bool {
	if !uuidPattern.MatchString(v.InventoryID) || !identifierPattern.MatchString(v.NewAPIUserID) || !identifierPattern.MatchString(v.NewAPIUsername) || len(v.APIKey) == 0 || len(v.APIKey) > 16<<10 || v.RequestsPerMinute < 1 || v.RequestsPerMinute > 6000 || v.ConcurrentRequests < 1 || v.ConcurrentRequests > 100 || validateOperation(v.Operation, true) != nil {
		return false
	}
	u, err := url.Parse(v.BaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Contains(v.BaseURL, "@") {
		return false
	}
	seen := map[string]bool{}
	found := false
	if len(v.AllowedModels) == 0 {
		return false
	}
	for _, m := range v.AllowedModels {
		if strings.TrimSpace(m) != m || m == "" || seen[m] {
			return false
		}
		seen[m] = true
		if m == v.DefaultModel {
			found = true
		}
	}
	return found
}

var _ = time.RFC3339
