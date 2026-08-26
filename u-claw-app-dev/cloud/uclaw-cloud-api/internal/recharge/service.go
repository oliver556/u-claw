package recharge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"uclaw-cloud-api/internal/newapi"
)

const (
	// ProviderVirtual is the local-development payment provider used before official pay wiring.
	ProviderVirtual = "virtual"

	// StatusCreated means an order exists but no payment callback has been accepted.
	StatusCreated = "created"
	// StatusPaid means payment was accepted but New API quota has not been credited yet.
	StatusPaid = "paid"
	// StatusCrediting is a short-lived lock state that prevents double quota credit.
	StatusCrediting = "crediting"
	// StatusCredited means New API quota has been successfully added.
	StatusCredited = "credited"
	// StatusCreditFailed means payment was accepted but New API crediting failed.
	StatusCreditFailed = "credit_failed"
)

// Plan is a recharge SKU shown to the client before a payment order is created.
type Plan struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	AmountCents int64  `json:"amountCents"`
	Quota       int64  `json:"quota"`
	Currency    string `json:"currency"`
}

// Order is the persistent payment order that bridges U-Claw, payment callbacks, and New API quota.
type Order struct {
	ID              int64      `json:"-"`
	OrderNo         string     `json:"orderNo"`
	UClawUserID     int64      `json:"-"`
	Provider        string     `json:"provider"`
	AmountCents     int64      `json:"amountCents"`
	Quota           int64      `json:"quota"`
	Status          string     `json:"status"`
	ProviderTradeNo string     `json:"providerTradeNo,omitempty"`
	PaidAt          *time.Time `json:"paidAt,omitempty"`
	CreditedAt      *time.Time `json:"creditedAt,omitempty"`
	LastError       string     `json:"lastError,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

// Callback records the payment provider event accepted for an order.
type Callback struct {
	OrderID         int64
	Provider        string
	ProviderEventID string
	SignatureValid  bool
	PayloadRedacted string
	ReceivedAt      time.Time
}

// Account identifies the New API user that should receive quota.
type Account struct {
	UClawUserID  int64
	NewAPIUserID int64
}

// Store is the persistence seam for order state and New API account lookup.
type Store interface {
	CreateOrder(ctx context.Context, order Order) (Order, error)
	ListOrdersForUser(ctx context.Context, userID int64, limit int) ([]Order, error)
	GetOrderForUser(ctx context.Context, orderNo string, userID int64) (Order, error)
	GetOrder(ctx context.Context, orderNo string) (Order, error)
	SaveCallback(ctx context.Context, callback Callback) error
	MarkPaid(ctx context.Context, orderNo string, providerTradeNo string, paidAt time.Time) (Order, error)
	BeginCredit(ctx context.Context, orderNo string) (Order, bool, error)
	MarkCredited(ctx context.Context, orderNo string, creditedAt time.Time) (Order, error)
	MarkCreditFailed(ctx context.Context, orderNo string, lastError string) (Order, error)
	GetNewAPIAccount(ctx context.Context, userID int64) (Account, error)
}

// QuotaClient is the New API admin operation needed after a payment succeeds.
type QuotaClient interface {
	AddQuota(ctx context.Context, req newapi.AddQuotaRequest) error
}

// Config controls the recharge slice while official payment providers are still pending.
type Config struct {
	AllowVirtualCallback bool
	Plans                []Plan
}

// Service owns recharge order creation, callback idempotency, and New API quota crediting.
type Service struct {
	store Store
	quota QuotaClient
	cfg   Config
	now   func() time.Time
}

// CreateOrderRequest carries the authenticated user and selected recharge plan.
type CreateOrderRequest struct {
	UserID   int64
	PlanCode string
	Provider string
}

// OrderResult is returned after creating or querying a recharge order.
type OrderResult struct {
	Order              Order  `json:"order"`
	PayURL             string `json:"payUrl,omitempty"`
	VirtualCallbackURL string `json:"virtualCallbackUrl,omitempty"`
}

// VirtualCallbackRequest is the temporary local callback shape before Alipay/WeChat signing lands.
type VirtualCallbackRequest struct {
	OrderNo         string
	ProviderEventID string
}

// NewService creates the recharge service with a static plan catalog and strict provider defaults.
func NewService(store Store, quota QuotaClient, cfg Config) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("recharge store is required")
	}
	if len(cfg.Plans) == 0 {
		cfg.Plans = DefaultPlans()
	}
	for _, plan := range cfg.Plans {
		if err := validatePlan(plan); err != nil {
			return nil, err
		}
	}
	return &Service{store: store, quota: quota, cfg: cfg, now: time.Now}, nil
}

// DefaultPlans returns development SKUs that make local virtual callbacks easy to validate.
func DefaultPlans() []Plan {
	return []Plan{
		{Code: "dev_10", Name: "虚拟充值 10 元", AmountCents: 1000, Quota: 50000, Currency: "CNY"},
		{Code: "dev_50", Name: "虚拟充值 50 元", AmountCents: 5000, Quota: 300000, Currency: "CNY"},
		{Code: "dev_100", Name: "虚拟充值 100 元", AmountCents: 10000, Quota: 700000, Currency: "CNY"},
	}
}

// ListPlans returns active recharge choices. Real provider metadata can be layered here later.
func (s *Service) ListPlans(_ context.Context) []Plan {
	plans := make([]Plan, len(s.cfg.Plans))
	copy(plans, s.cfg.Plans)
	return plans
}

// CreateOrder creates a virtual recharge order for the authenticated U-Claw user.
func (s *Service) CreateOrder(ctx context.Context, req CreateOrderRequest) (OrderResult, error) {
	if req.UserID <= 0 {
		return OrderResult{}, fmt.Errorf("user id is required")
	}
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		provider = ProviderVirtual
	}
	if provider != ProviderVirtual {
		return OrderResult{}, fmt.Errorf("payment provider is unsupported")
	}
	plan, ok := s.findPlan(req.PlanCode)
	if !ok {
		return OrderResult{}, fmt.Errorf("recharge plan is invalid")
	}
	now := s.now()
	order, err := s.store.CreateOrder(ctx, Order{
		OrderNo:     newOrderNo(now),
		UClawUserID: req.UserID,
		Provider:    provider,
		AmountCents: plan.AmountCents,
		Quota:       plan.Quota,
		Status:      StatusCreated,
		CreatedAt:   now,
		UpdatedAt:   now,
	})
	if err != nil {
		return OrderResult{}, err
	}
	return OrderResult{
		Order:              order,
		PayURL:             "virtual://uclaw/recharge/" + order.OrderNo,
		VirtualCallbackURL: "/v1/payments/virtual/notify",
	}, nil
}

// ListOrders returns recent recharge orders owned by the authenticated user.
func (s *Service) ListOrders(ctx context.Context, userID int64, limit int) ([]Order, error) {
	if userID <= 0 {
		return nil, fmt.Errorf("user id is required")
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	return s.store.ListOrdersForUser(ctx, userID, limit)
}

// GetOrder returns one order owned by the authenticated user.
func (s *Service) GetOrder(ctx context.Context, orderNo string, userID int64) (Order, error) {
	if userID <= 0 {
		return Order{}, fmt.Errorf("user id is required")
	}
	orderNo = strings.TrimSpace(orderNo)
	if orderNo == "" {
		return Order{}, fmt.Errorf("order no is required")
	}
	return s.store.GetOrderForUser(ctx, orderNo, userID)
}

// HandleVirtualCallback accepts a local callback and credits New API quota once.
func (s *Service) HandleVirtualCallback(ctx context.Context, req VirtualCallbackRequest) (Order, error) {
	if !s.cfg.AllowVirtualCallback {
		return Order{}, fmt.Errorf("virtual payment callback is disabled")
	}
	orderNo := strings.TrimSpace(req.OrderNo)
	if orderNo == "" {
		return Order{}, fmt.Errorf("order no is required")
	}
	eventID := strings.TrimSpace(req.ProviderEventID)
	if eventID == "" {
		eventID = "virtual-" + orderNo
	}
	order, err := s.store.GetOrder(ctx, orderNo)
	if err != nil {
		return Order{}, err
	}
	if order.Provider != ProviderVirtual {
		return Order{}, fmt.Errorf("order provider is not virtual")
	}
	now := s.now()
	if err := s.store.SaveCallback(ctx, Callback{
		OrderID:         order.ID,
		Provider:        ProviderVirtual,
		ProviderEventID: eventID,
		SignatureValid:  true,
		PayloadRedacted: `{"provider":"virtual"}`,
		ReceivedAt:      now,
	}); err != nil {
		return Order{}, err
	}
	order, err = s.store.MarkPaid(ctx, orderNo, eventID, now)
	if err != nil {
		return Order{}, err
	}
	if order.Status == StatusCredited {
		return order, nil
	}
	creditOrder, locked, err := s.store.BeginCredit(ctx, orderNo)
	if err != nil {
		return Order{}, err
	}
	if !locked {
		return s.store.GetOrder(ctx, orderNo)
	}
	if s.quota == nil {
		failed, markErr := s.store.MarkCreditFailed(ctx, orderNo, "newapi quota client is not configured")
		if markErr != nil {
			return Order{}, markErr
		}
		return failed, fmt.Errorf("newapi quota client is not configured")
	}
	account, err := s.store.GetNewAPIAccount(ctx, creditOrder.UClawUserID)
	if err != nil {
		failed, markErr := s.store.MarkCreditFailed(ctx, orderNo, err.Error())
		if markErr != nil {
			return Order{}, markErr
		}
		return failed, err
	}
	if account.NewAPIUserID <= 0 {
		failed, markErr := s.store.MarkCreditFailed(ctx, orderNo, "newapi user id is missing")
		if markErr != nil {
			return Order{}, markErr
		}
		return failed, fmt.Errorf("newapi user id is missing")
	}
	if err := s.quota.AddQuota(ctx, newapi.AddQuotaRequest{UserID: account.NewAPIUserID, Quota: creditOrder.Quota}); err != nil {
		failed, markErr := s.store.MarkCreditFailed(ctx, orderNo, err.Error())
		if markErr != nil {
			return Order{}, markErr
		}
		return failed, err
	}
	return s.store.MarkCredited(ctx, orderNo, s.now())
}

// findPlan looks up one configured recharge plan by code.
func (s *Service) findPlan(code string) (Plan, bool) {
	code = strings.TrimSpace(code)
	for _, plan := range s.cfg.Plans {
		if plan.Code == code {
			return plan, true
		}
	}
	return Plan{}, false
}

// validatePlan prevents zero-value SKUs from creating meaningless payment orders.
func validatePlan(plan Plan) error {
	if strings.TrimSpace(plan.Code) == "" {
		return fmt.Errorf("recharge plan code is required")
	}
	if strings.TrimSpace(plan.Name) == "" {
		return fmt.Errorf("recharge plan name is required")
	}
	if plan.AmountCents <= 0 {
		return fmt.Errorf("recharge plan amount must be positive")
	}
	if plan.Quota <= 0 {
		return fmt.Errorf("recharge plan quota must be positive")
	}
	if strings.TrimSpace(plan.Currency) == "" {
		return fmt.Errorf("recharge plan currency is required")
	}
	return nil
}

// newOrderNo builds a sortable order number with random suffix to avoid collisions.
func newOrderNo(now time.Time) string {
	var suffix [4]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "UC" + now.UTC().Format("20060102150405") + "00000000"
	}
	return "UC" + now.UTC().Format("20060102150405") + strings.ToUpper(hex.EncodeToString(suffix[:]))
}
