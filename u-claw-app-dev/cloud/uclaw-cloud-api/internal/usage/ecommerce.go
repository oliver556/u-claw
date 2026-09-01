package usage

import (
	"context"
	"fmt"
	"strings"
	"time"

	"uclaw-cloud-api/internal/newapi"
)

const defaultEcommerceImageQuota = int64(50000)

// EcommerceUsageStore persists ecommerce image billing events so the model page
// can show image usage even when New API's image relay does not write consume logs.
type EcommerceUsageStore interface {
	ClaimEcommerceImageUsage(ctx context.Context, event EcommerceImageUsageEvent) (EcommerceImageUsageEvent, bool, error)
	MarkEcommerceImageUsageSettled(ctx context.Context, requestID string) (EcommerceImageUsageEvent, error)
	ReleaseEcommerceImageUsageClaim(ctx context.Context, requestID string) error
	ListEcommerceImageUsage(ctx context.Context, userID int64, limit int) ([]EcommerceImageUsageEvent, error)
}

// QuotaClient is the New API admin operation needed for direct ecommerce image billing.
type QuotaClient interface {
	SubtractQuota(ctx context.Context, req newapi.AddQuotaRequest) error
}

// EcommerceImageUsageRequest is posted by a trusted desktop after images have
// been generated successfully.
type EcommerceImageUsageRequest struct {
	UserID        int64    `json:"-"`
	Phone         string   `json:"-"`
	RequestID     string   `json:"requestId"`
	Model         string   `json:"model"`
	TokenName     string   `json:"tokenName"`
	Platform      string   `json:"platform"`
	OutputTypes   []string `json:"outputTypes"`
	ImageCount    int      `json:"imageCount"`
	QuotaPerImage int64    `json:"quotaPerImage,omitempty"`
}

// EcommerceImageUsageEvent is a durable, idempotent image billing record.
type EcommerceImageUsageEvent struct {
	ID           int64
	UserID       int64
	NewAPIUserID int64
	Phone        string
	RequestID    string
	Model        string
	TokenName    string
	Platform     string
	OutputTypes  []string
	ImageCount   int
	Quota        int64
	Status       string
	CreatedAt    time.Time
}

// EcommerceImageUsageResult is returned to the desktop after billing is settled.
type EcommerceImageUsageResult struct {
	Status     string `json:"status"`
	RequestID  string `json:"requestId"`
	Model      string `json:"model"`
	TokenName  string `json:"tokenName"`
	ImageCount int    `json:"imageCount"`
	Quota      int64  `json:"quota"`
	Duplicate  bool   `json:"duplicate"`
}

// RecordEcommerceImageUsage debits New API quota exactly once for one direct
// ecommerce image generation request.
func (s *Service) RecordEcommerceImageUsage(ctx context.Context, req EcommerceImageUsageRequest) (EcommerceImageUsageResult, error) {
	if s.store == nil {
		return EcommerceImageUsageResult{}, fmt.Errorf("ecommerce usage store is not configured")
	}
	if s.quota == nil {
		return EcommerceImageUsageResult{}, fmt.Errorf("newapi quota client is not configured")
	}
	req = normalizeEcommerceImageUsageRequest(req)
	if req.UserID <= 0 {
		return EcommerceImageUsageResult{}, fmt.Errorf("uclaw user id is required")
	}
	if req.Phone == "" {
		return EcommerceImageUsageResult{}, fmt.Errorf("phone is required")
	}
	if req.RequestID == "" {
		return EcommerceImageUsageResult{}, fmt.Errorf("requestId is required")
	}
	if req.Model == "" {
		return EcommerceImageUsageResult{}, fmt.Errorf("model is required")
	}
	if req.ImageCount <= 0 {
		return EcommerceImageUsageResult{}, fmt.Errorf("imageCount must be positive")
	}

	account, ok, err := s.admin.SearchUserByUsername(ctx, req.Phone)
	if err != nil {
		return EcommerceImageUsageResult{}, err
	}
	if !ok || account.ID <= 0 {
		return EcommerceImageUsageResult{}, fmt.Errorf("newapi user id is not available")
	}

	quota := req.QuotaPerImage * int64(req.ImageCount)
	event, claimed, err := s.store.ClaimEcommerceImageUsage(ctx, EcommerceImageUsageEvent{
		UserID:       req.UserID,
		NewAPIUserID: account.ID,
		Phone:        req.Phone,
		RequestID:    req.RequestID,
		Model:        req.Model,
		TokenName:    req.TokenName,
		Platform:     req.Platform,
		OutputTypes:  req.OutputTypes,
		ImageCount:   req.ImageCount,
		Quota:        quota,
		Status:       "pending",
		CreatedAt:    s.now(),
	})
	if err != nil {
		return EcommerceImageUsageResult{}, err
	}
	if !claimed && event.Status != "settled" {
		return EcommerceImageUsageResult{}, fmt.Errorf("ecommerce image usage is pending settlement")
	}
	if claimed {
		if err := s.quota.SubtractQuota(ctx, newapi.AddQuotaRequest{UserID: account.ID, Quota: quota}); err != nil {
			_ = s.store.ReleaseEcommerceImageUsageClaim(ctx, req.RequestID)
			return EcommerceImageUsageResult{}, err
		}
		event, err = s.store.MarkEcommerceImageUsageSettled(ctx, req.RequestID)
		if err != nil {
			return EcommerceImageUsageResult{}, err
		}
	}

	return EcommerceImageUsageResult{
		Status:     "ok",
		RequestID:  event.RequestID,
		Model:      event.Model,
		TokenName:  event.TokenName,
		ImageCount: event.ImageCount,
		Quota:      event.Quota,
		Duplicate:  !claimed,
	}, nil
}

func normalizeEcommerceImageUsageRequest(req EcommerceImageUsageRequest) EcommerceImageUsageRequest {
	req.Phone = strings.TrimSpace(req.Phone)
	req.RequestID = strings.TrimSpace(req.RequestID)
	req.Model = normalizeModelName(req.Model)
	req.TokenName = strings.TrimSpace(req.TokenName)
	if req.TokenName == "" {
		req.TokenName = "uclaw-main"
	}
	req.Platform = strings.TrimSpace(req.Platform)
	if req.QuotaPerImage <= 0 {
		req.QuotaPerImage = defaultEcommerceImageQuota
	}
	req.OutputTypes = normalizeOutputTypes(req.OutputTypes)
	return req
}

func normalizeOutputTypes(values []string) []string {
	output := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		output = append(output, trimmed)
	}
	return output
}

func normalizeModelName(value string) string {
	trimmed := strings.TrimSpace(value)
	if slash := strings.Index(trimmed, "/"); slash > 0 && slash < len(trimmed)-1 {
		return strings.TrimSpace(trimmed[slash+1:])
	}
	return trimmed
}
