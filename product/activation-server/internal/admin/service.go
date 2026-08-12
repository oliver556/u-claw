package admin

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"u-claw-activation-server/internal/inventory"
)

var (
	ErrInvalidInput    = errors.New("admin input invalid")
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)
	idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	sha256Pattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type Operation struct {
	OperatorID     string
	RequestID      string
	IdempotencyKey string
	Reason         string
}

type InventoryRecord struct {
	InventoryID          string
	Username             string
	UsernameDisplay      string
	ActivationCode       string
	ActivationCodeDigest []byte
	NewAPIUserID         string
	NewAPIUsername       string
	PolicyDigest         []byte
	EntitlementRevision  int64
}

type InventorySummary struct {
	InventoryID       string  `json:"inventoryId"`
	Username          string  `json:"username"`
	Status            string  `json:"status"`
	NewAPISetupStatus string  `json:"newApiSetupStatus"`
	DeviceID          *string `json:"deviceId"`
	LicenseID         *string `json:"licenseId"`
	ActivationCode    string  `json:"-"`
}

type InventoryLocator struct{ InventoryID, Username, DeviceID string }
type AuditQuery struct {
	Limit  int
	Before string
}
type AuditEvent struct {
	EventID        string  `json:"eventId"`
	ActorID        string  `json:"actorId"`
	Action         string  `json:"action"`
	Outcome        string  `json:"outcome"`
	InventoryID    *string `json:"inventoryId"`
	DeviceID       *string `json:"deviceId"`
	LicenseID      *string `json:"licenseId"`
	RequestID      string  `json:"requestId"`
	Reason         *string `json:"reason"`
	IdempotencyKey *string `json:"idempotencyKey"`
	CreatedAt      string  `json:"createdAt"`
}
type OperatorRegistry map[string][sha256.Size]byte

func (registry OperatorRegistry) Authenticate(secret string) (string, bool) {
	digest := sha256.Sum256([]byte(secret))
	matched := ""
	for operatorID, expected := range registry {
		if subtle.ConstantTimeCompare(digest[:], expected[:]) == 1 {
			matched = operatorID
		}
	}
	return matched, matched != ""
}

type GenerateInput struct {
	Count     int
	Operation Operation
}
type GeneratePlan struct {
	Input   GenerateInput
	Records []InventoryRecord
	Secrets []InventorySummary
}
type ReissuePlan struct {
	Mutation Mutation
	Secret   MutationResult
}
type ReissueTarget struct {
	Username string
	Revision int64
}
type ImportRecord struct{ Username, ActivationCode, NewAPIUserID, NewAPIUsername, PolicyDigest string }
type ImportInput struct {
	Records   []ImportRecord
	Operation Operation
}

type Action string

const (
	ActionDisable Action = "disable"
	ActionEnable  Action = "enable"
	ActionRevoke  Action = "revoke"
	ActionReissue Action = "reissue"
)

type Mutation struct {
	Action        Action
	LicenseID     string
	ConfirmTarget string
	Operation     Operation
	Replacement   *InventoryRecord
}
type MutationResult struct {
	LicenseID                 string  `json:"licenseId"`
	Status                    string  `json:"status"`
	Revision                  int64   `json:"revision"`
	ReplacementInventoryID    *string `json:"replacementInventoryId"`
	ReplacementActivationCode string  `json:"-"`
	ReplacementUsername       string  `json:"-"`
}

type Repository interface {
	CreateInventory(context.Context, []InventoryRecord, Operation) ([]InventorySummary, error)
	ShowInventory(context.Context, InventoryLocator) (InventorySummary, error)
	Mutate(context.Context, Mutation) (MutationResult, error)
	MarkConfigured(context.Context, InventoryLocator, Operation) (InventorySummary, error)
	PrepareReissueTarget(context.Context, Mutation) (ReissueTarget, error)
	Audit(context.Context, AuditQuery) ([]AuditEvent, error)
}

type ServiceOptions struct {
	Repository Repository
	Pepper     []byte
	Random     io.Reader
}
type Service struct {
	repository Repository
	pepper     []byte
	random     io.Reader
}

func NewService(options ServiceOptions) (*Service, error) {
	if options.Repository == nil || len(options.Pepper) < 32 {
		return nil, errors.New("admin service configuration invalid")
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	return &Service{repository: options.Repository, pepper: append([]byte(nil), options.Pepper...), random: options.Random}, nil
}

func (service *Service) Generate(ctx context.Context, input GenerateInput) ([]InventorySummary, error) {
	plan, err := service.PrepareGenerate(input)
	if err != nil {
		return nil, err
	}
	return service.ExecuteGenerate(ctx, plan)
}

func (service *Service) PrepareGenerate(input GenerateInput) (GeneratePlan, error) {
	if input.Count < 1 || input.Count > 10000 || validateOperation(input.Operation, true) != nil {
		return GeneratePlan{}, ErrInvalidInput
	}
	records := make([]InventoryRecord, input.Count)
	for index := range records {
		entropy := service.derive(input.Operation.IdempotencyKey, "generate", index, 64)
		code, err := inventory.GenerateActivationCode(bytes.NewReader(entropy))
		if err != nil {
			return GeneratePlan{}, err
		}
		id, err := randomUUID(bytes.NewReader(entropy[17:]))
		if err != nil {
			return GeneratePlan{}, err
		}
		usernameBytes := make([]byte, 8)
		if _, err := io.ReadFull(bytes.NewReader(entropy[33:]), usernameBytes); err != nil {
			return GeneratePlan{}, errors.New("inventory entropy unavailable")
		}
		username := "uclaw-" + hex.EncodeToString(usernameBytes)
		digest, err := inventory.ActivationCodeDigest(service.pepper, code)
		if err != nil {
			return GeneratePlan{}, err
		}
		display := strings.ToUpper(username)
		records[index] = InventoryRecord{InventoryID: id, Username: strings.ToUpper(display), UsernameDisplay: display, ActivationCode: code, ActivationCodeDigest: digest}
	}
	secrets := make([]InventorySummary, len(records))
	for i, record := range records {
		secrets[i] = InventorySummary{InventoryID: record.InventoryID, Username: record.UsernameDisplay, ActivationCode: record.ActivationCode}
	}
	return GeneratePlan{Input: input, Records: records, Secrets: secrets}, nil
}

func (service *Service) ExecuteGenerate(ctx context.Context, plan GeneratePlan) ([]InventorySummary, error) {
	result, err := service.repository.CreateInventory(ctx, plan.Records, plan.Input.Operation)
	if err != nil {
		return nil, err
	}
	for index := range result {
		result[index].ActivationCode = plan.Records[index].ActivationCode
	}
	return result, nil
}

func (service *Service) Import(ctx context.Context, input ImportInput) ([]InventorySummary, error) {
	if len(input.Records) == 0 || len(input.Records) > 10000 || validateOperation(input.Operation, true) != nil {
		return nil, ErrInvalidInput
	}
	records := make([]InventoryRecord, len(input.Records))
	for index, item := range input.Records {
		display := strings.TrimSpace(item.Username)
		username := strings.ToUpper(display)
		code, err := inventory.NormalizeActivationCode(item.ActivationCode)
		if err != nil || !identifierPattern.MatchString(username) || !identifierPattern.MatchString(item.NewAPIUserID) || !identifierPattern.MatchString(item.NewAPIUsername) || !sha256Pattern.MatchString(item.PolicyDigest) {
			return nil, ErrInvalidInput
		}
		digest, err := inventory.ActivationCodeDigest(service.pepper, code)
		if err != nil {
			return nil, err
		}
		id, err := randomUUID(bytes.NewReader(service.derive(input.Operation.IdempotencyKey, "import", index, 16)))
		if err != nil {
			return nil, err
		}
		policy, _ := hex.DecodeString(item.PolicyDigest)
		records[index] = InventoryRecord{InventoryID: id, Username: username, UsernameDisplay: display, ActivationCodeDigest: digest, NewAPIUserID: item.NewAPIUserID, NewAPIUsername: item.NewAPIUsername, PolicyDigest: policy}
	}
	return service.repository.CreateInventory(ctx, records, input.Operation)
}

func (service *Service) Show(ctx context.Context, locator InventoryLocator) (InventorySummary, error) {
	if !validLocator(locator) {
		return InventorySummary{}, ErrInvalidInput
	}
	return service.repository.ShowInventory(ctx, locator)
}

func (service *Service) MutateLicense(ctx context.Context, mutation Mutation) (MutationResult, error) {
	if !validAction(mutation.Action) || !identifierPattern.MatchString(mutation.LicenseID) || mutation.ConfirmTarget != TargetDigest(mutation.LicenseID) || validateOperation(mutation.Operation, true) != nil {
		return MutationResult{}, ErrInvalidInput
	}
	if mutation.Action == ActionReissue {
		plan, err := service.PrepareReissue(ctx, mutation)
		if err != nil {
			return MutationResult{}, err
		}
		return service.ExecuteReissue(ctx, plan)
	}
	return service.repository.Mutate(ctx, mutation)
}

func (service *Service) PrepareReissue(ctx context.Context, mutation Mutation) (ReissuePlan, error) {
	if mutation.Action != ActionReissue || !identifierPattern.MatchString(mutation.LicenseID) || mutation.ConfirmTarget != TargetDigest(mutation.LicenseID) || validateOperation(mutation.Operation, true) != nil {
		return ReissuePlan{}, ErrInvalidInput
	}
	entropy := service.derive(mutation.Operation.IdempotencyKey, "reissue", 0, 40)
	code, err := inventory.GenerateActivationCode(bytes.NewReader(entropy))
	if err != nil {
		return ReissuePlan{}, err
	}
	id, err := randomUUID(bytes.NewReader(entropy[17:]))
	if err != nil {
		return ReissuePlan{}, err
	}
	digest, err := inventory.ActivationCodeDigest(service.pepper, code)
	if err != nil {
		return ReissuePlan{}, err
	}
	target, err := service.repository.PrepareReissueTarget(ctx, mutation)
	if err != nil || !identifierPattern.MatchString(target.Username) || target.Revision < 1 {
		if err != nil {
			return ReissuePlan{}, err
		}
		return ReissuePlan{}, ErrInvalidInput
	}
	revision := target.Revision + 1
	suffix := fmt.Sprintf("-r%d", revision)
	username := trimIdentifier(target.Username, len(suffix)) + suffix
	mutation.Replacement = &InventoryRecord{InventoryID: id, Username: strings.ToUpper(username), UsernameDisplay: username, ActivationCode: code, ActivationCodeDigest: digest, EntitlementRevision: revision}
	return ReissuePlan{Mutation: mutation, Secret: MutationResult{ReplacementInventoryID: &id, ReplacementActivationCode: code, ReplacementUsername: username}}, nil
}

func (service *Service) ExecuteReissue(ctx context.Context, plan ReissuePlan) (MutationResult, error) {
	result, err := service.repository.Mutate(ctx, plan.Mutation)
	if err == nil && plan.Mutation.Replacement != nil {
		result.ReplacementActivationCode = plan.Mutation.Replacement.ActivationCode
		result.ReplacementUsername = plan.Mutation.Replacement.UsernameDisplay
	}
	return result, err
}

func (service *Service) Audit(ctx context.Context, query AuditQuery) ([]AuditEvent, error) {
	if query.Limit == 0 {
		query.Limit = 100
	}
	if query.Limit < 1 || query.Limit > 500 || (query.Before != "" && !identifierPattern.MatchString(query.Before)) {
		return nil, ErrInvalidInput
	}
	return service.repository.Audit(ctx, query)
}

func (service *Service) derive(key, purpose string, index, length int) []byte {
	result := make([]byte, 0, length)
	for block := 0; len(result) < length; block++ {
		mac := hmac.New(sha256.New, service.pepper)
		_, _ = fmt.Fprintf(mac, "uclaw-admin-derive-v1\x00%s\x00%s\x00%d\x00%d", key, purpose, index, block)
		result = append(result, mac.Sum(nil)...)
	}
	return result[:length]
}

func (service *Service) MarkConfigured(ctx context.Context, locator InventoryLocator, operation Operation) (InventorySummary, error) {
	if !validLocator(locator) || validateOperation(operation, true) != nil {
		return InventorySummary{}, ErrInvalidInput
	}
	return service.repository.MarkConfigured(ctx, locator, operation)
}

func validateOperation(value Operation, reason bool) error {
	if !identifierPattern.MatchString(value.OperatorID) || !identifierPattern.MatchString(value.RequestID) || !idempotencyPattern.MatchString(value.IdempotencyKey) || (reason && (len(strings.TrimSpace(value.Reason)) < 3 || len(value.Reason) > 512)) {
		return ErrInvalidInput
	}
	return nil
}
func validLocator(value InventoryLocator) bool {
	count := 0
	for _, item := range []string{value.InventoryID, value.Username, value.DeviceID} {
		if item != "" {
			count++
			if !identifierPattern.MatchString(item) {
				return false
			}
		}
	}
	return count == 1
}
func validAction(value Action) bool {
	return value == ActionDisable || value == ActionEnable || value == ActionRevoke || value == ActionReissue
}
func randomUUID(source io.Reader) (string, error) {
	value := make([]byte, 16)
	if _, err := io.ReadFull(source, value); err != nil {
		return "", errors.New("admin entropy unavailable")
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func trimIdentifier(value string, suffix int) string {
	limit := 127 - suffix
	if len(value) > limit {
		return value[:limit]
	}
	return value
}

func TargetDigest(licenseID string) string {
	sum := sha256.Sum256([]byte("license:" + licenseID))
	return hex.EncodeToString(sum[:])
}
