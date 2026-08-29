package usage

import (
	"context"
	"fmt"
	"strings"
	"time"

	"uclaw-cloud-api/internal/billing"
	"uclaw-cloud-api/internal/newapi"
	"uclaw-cloud-api/internal/provisioning"
)

// Config controls how Bavi-box reads user-facing New API balance and usage data.
type Config struct {
	PasswordSecret string
	PageSize       int
}

// Service reads New API as the activated user and returns dashboard-ready usage data.
type Service struct {
	admin *newapi.Client
	cfg   Config
	now   func() time.Time
}

// SummaryRequest identifies the authenticated Bavi-box user whose New API data should be read.
type SummaryRequest struct {
	UserID int64
	Phone  string
}

// Summary is the model page payload for balance, quota usage, and recent records.
type Summary struct {
	Status                string   `json:"status"`
	NewAPIUserID          int64    `json:"newapiUserId"`
	NewAPIUsername        string   `json:"newapiUsername"`
	AccountBalance        int64    `json:"accountBalance"`
	UsedQuota             int64    `json:"usedQuota"`
	AccountBalanceCompute int64    `json:"accountBalanceCompute"`
	UsedCompute           int64    `json:"usedCompute"`
	RequestCount          int64    `json:"requestCount"`
	TodayUsage            int64    `json:"todayUsage"`
	Last7DaysUsage        int64    `json:"last7DaysUsage"`
	CumulativeUsage       int64    `json:"cumulativeUsage"`
	TodayCompute          int64    `json:"todayCompute"`
	Last7DaysCompute      int64    `json:"last7DaysCompute"`
	CumulativeCompute     int64    `json:"cumulativeCompute"`
	NewAPIQuotaPerCNY     int64    `json:"newapiQuotaPerCny"`
	ComputeUnitsPerCNY    int64    `json:"computeUnitsPerCny"`
	RecentRecordText      string   `json:"recentRecordText"`
	Records               []Record `json:"records"`
	RefreshedAt           string   `json:"refreshedAt"`
	Unit                  string   `json:"unit"`
}

// Record is one recent New API usage or account log row normalized for clients.
type Record struct {
	ID               int64  `json:"id"`
	CreatedAt        int64  `json:"createdAt"`
	Type             int    `json:"type"`
	Content          string `json:"content"`
	ModelName        string `json:"modelName"`
	TokenName        string `json:"tokenName"`
	Quota            int64  `json:"quota"`
	Compute          int64  `json:"compute"`
	PromptTokens     int64  `json:"promptTokens"`
	CompletionTokens int64  `json:"completionTokens"`
	UseTime          int64  `json:"useTime"`
	ChannelName      string `json:"channelName"`
	RequestID        string `json:"requestId"`
}

// NewService creates a usage service backed by New API dashboard endpoints.
func NewService(admin *newapi.Client, cfg Config) (*Service, error) {
	if admin == nil {
		return nil, fmt.Errorf("newapi client is required")
	}
	if strings.TrimSpace(cfg.PasswordSecret) == "" {
		return nil, fmt.Errorf("newapi user password secret is required")
	}
	if cfg.PageSize <= 0 {
		cfg.PageSize = 50
	}
	return &Service{admin: admin, cfg: cfg, now: time.Now}, nil
}

// GetSummary logs in as the same-phone New API user and summarizes recent quota data.
func (s *Service) GetSummary(ctx context.Context, req SummaryRequest) (Summary, error) {
	phone := strings.TrimSpace(req.Phone)
	if req.UserID <= 0 {
		return Summary{}, fmt.Errorf("uclaw user id is required")
	}
	if phone == "" {
		return Summary{}, fmt.Errorf("phone is required")
	}

	password := provisioning.DeriveUserPassword(req.UserID, phone, s.cfg.PasswordSecret)
	login, err := s.admin.Login(ctx, phone, password)
	if err != nil {
		return Summary{}, err
	}
	userClient, err := s.admin.WithAccessToken(login.Data.AccessToken)
	if err != nil {
		return Summary{}, err
	}
	self, err := userClient.GetSelf(ctx)
	if err != nil {
		return Summary{}, err
	}
	logs, err := userClient.ListSelfLogs(ctx, 0, s.cfg.PageSize)
	if err != nil {
		return Summary{}, err
	}
	return s.buildSummary(self, logs.Items), nil
}

// buildSummary folds New API self/log responses into stable client fields.
func (s *Service) buildSummary(self newapi.SelfUser, items []newapi.LogItem) Summary {
	now := s.now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	last7Start := now.AddDate(0, 0, -7)

	var todayUsage int64
	var last7DaysUsage int64
	records := make([]Record, 0, len(items))
	for _, item := range items {
		if !isUserFacingUsageLog(item) {
			continue
		}
		createdAt := time.Unix(item.CreatedAt, 0).In(now.Location())
		if !createdAt.Before(dayStart) {
			todayUsage += item.Quota
		}
		if !createdAt.Before(last7Start) {
			last7DaysUsage += item.Quota
		}
		records = append(records, Record{
			ID:               item.ID,
			CreatedAt:        item.CreatedAt,
			Type:             item.Type,
			Content:          item.Content,
			ModelName:        item.ModelName,
			TokenName:        item.TokenName,
			Quota:            item.Quota,
			Compute:          billing.ComputeFromNewAPIQuota(item.Quota),
			PromptTokens:     item.PromptTokens,
			CompletionTokens: item.CompletionTokens,
			UseTime:          item.UseTime,
			ChannelName:      item.ChannelName,
			RequestID:        item.RequestID,
		})
	}

	return Summary{
		Status:                "ok",
		NewAPIUserID:          self.ID,
		NewAPIUsername:        self.Username,
		AccountBalance:        self.Quota,
		UsedQuota:             self.UsedQuota,
		AccountBalanceCompute: billing.ComputeFromNewAPIQuota(self.Quota),
		UsedCompute:           billing.ComputeFromNewAPIQuota(self.UsedQuota),
		RequestCount:          self.RequestCount,
		TodayUsage:            todayUsage,
		Last7DaysUsage:        last7DaysUsage,
		CumulativeUsage:       self.UsedQuota,
		TodayCompute:          billing.ComputeFromNewAPIQuota(todayUsage),
		Last7DaysCompute:      billing.ComputeFromNewAPIQuota(last7DaysUsage),
		CumulativeCompute:     billing.ComputeFromNewAPIQuota(self.UsedQuota),
		NewAPIQuotaPerCNY:     billing.NewAPIQuotaPerCNY,
		ComputeUnitsPerCNY:    billing.ComputeUnitsPerCNY,
		RecentRecordText:      fmt.Sprintf("%d 条最近记录", len(records)),
		Records:               records,
		RefreshedAt:           now.UTC().Format(time.RFC3339),
		Unit:                  "quota",
	}
}

// isUserFacingUsageLog keeps billable model activity and hides New API account noise.
func isUserFacingUsageLog(item newapi.LogItem) bool {
	if isAuthenticationLog(item) {
		return false
	}
	return strings.TrimSpace(item.ModelName) != "" ||
		strings.TrimSpace(item.TokenName) != "" ||
		item.TokenID > 0 ||
		item.Quota != 0 ||
		item.PromptTokens != 0 ||
		item.CompletionTokens != 0 ||
		item.UseTime != 0
}

// isAuthenticationLog detects New API login events leaked through /api/log/self.
func isAuthenticationLog(item newapi.LogItem) bool {
	content := strings.ToLower(strings.TrimSpace(item.Content))
	if content == "" {
		return false
	}
	if !strings.Contains(content, "logged in successfully") && !strings.Contains(content, "login") {
		return false
	}
	return strings.TrimSpace(item.ModelName) == "" &&
		strings.TrimSpace(item.TokenName) == "" &&
		item.TokenID == 0
}
