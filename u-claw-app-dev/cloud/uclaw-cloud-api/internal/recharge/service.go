package recharge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"uclaw-cloud-api/internal/billing"
	"uclaw-cloud-api/internal/newapi"
)

const (
	// ProviderVirtual is the local-development payment provider used before official pay wiring.
	ProviderVirtual = "virtual"
	// ProviderAlipay is the official Alipay payment channel.
	ProviderAlipay = "alipay"
	// ProviderWeChat is the official WeChat Pay payment channel.
	ProviderWeChat = "wechat"

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
	Code                string `json:"code"`
	Name                string `json:"name"`
	AmountCents         int64  `json:"amountCents"`
	CheckoutAmountCents int64  `json:"checkoutAmountCents,omitempty"`
	Quota               int64  `json:"quota"`
	Currency            string `json:"currency"`
}

// ProviderInfo describes one payment provider available to the client UI.
type ProviderInfo struct {
	Code    string `json:"code"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

// Order is the persistent payment order that bridges Bavi-box, payment callbacks, and New API quota.
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

// CheckoutRequest is the provider-neutral payload needed to create a payment session.
type CheckoutRequest struct {
	OrderNo     string
	Provider    string
	Name        string
	AmountCents int64
	Currency    string
}

// CheckoutResult is the provider-neutral checkout data returned to the client.
type CheckoutResult struct {
	PayURL    string `json:"payUrl,omitempty"`
	QRCodeURL string `json:"qrCodeUrl,omitempty"`
}

// CheckoutClient creates provider-specific payment sessions after the order is persisted.
type CheckoutClient interface {
	CreateCheckout(ctx context.Context, req CheckoutRequest) (CheckoutResult, error)
}

// Config controls the recharge slice while official payment providers are still pending.
type Config struct {
	AllowVirtualCallback bool
	OneCentTestEnabled   bool
	Plans                []Plan
	CheckoutClients      map[string]CheckoutClient
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
	QRCodeURL          string `json:"qrCodeUrl,omitempty"`
	VirtualCallbackURL string `json:"virtualCallbackUrl,omitempty"`
}

// VirtualCallbackRequest is the temporary local callback shape before Alipay/WeChat signing lands.
type VirtualCallbackRequest struct {
	OrderNo         string
	ProviderEventID string
}

// PaymentCallbackRequest carries one verified provider payment notification into the recharge state machine.
type PaymentCallbackRequest struct {
	Provider         string
	OrderNo          string
	ProviderEventID  string
	ProviderTradeNo  string
	AmountCents      int64
	Paid             bool
	PaidAt           time.Time
	SignatureValid   bool
	PayloadRedacted  string
	ProviderStatus   string
	ProviderSellerID string
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

// DefaultPlans returns recharge SKUs using the Bavi-box 1 CNY = 6kw compute conversion.
func DefaultPlans() []Plan {
	return []Plan{
		{Code: "dev_10", Name: "充值 10 元", AmountCents: 1000, Quota: billing.NewAPIQuotaFromCNY(10), Currency: "CNY"},
		{Code: "dev_50", Name: "充值 50 元", AmountCents: 5000, Quota: billing.NewAPIQuotaFromCNY(50), Currency: "CNY"},
		{Code: "dev_100", Name: "充值 100 元", AmountCents: 10000, Quota: billing.NewAPIQuotaFromCNY(100), Currency: "CNY"},
	}
}

// ListPlans returns active recharge choices. Real provider metadata can be layered here later.
func (s *Service) ListPlans(_ context.Context) []Plan {
	plans := make([]Plan, len(s.cfg.Plans))
	copy(plans, s.cfg.Plans)
	if s.cfg.OneCentTestEnabled {
		for index := range plans {
			plans[index].CheckoutAmountCents = 1
		}
	}
	return plans
}

// ListProviders returns the payment provider catalog and whether each provider has a checkout adapter.
func (s *Service) ListProviders(_ context.Context) []ProviderInfo {
	return []ProviderInfo{
		{Code: ProviderVirtual, Name: "开发虚拟支付", Enabled: s.cfg.AllowVirtualCallback},
		{Code: ProviderAlipay, Name: "支付宝", Enabled: s.checkoutClient(ProviderAlipay) != nil},
		{Code: ProviderWeChat, Name: "微信支付", Enabled: s.checkoutClient(ProviderWeChat) != nil},
	}
}

// CreateOrder creates a recharge order and delegates checkout creation to the selected provider.
func (s *Service) CreateOrder(ctx context.Context, req CreateOrderRequest) (OrderResult, error) {
	if req.UserID <= 0 {
		return OrderResult{}, fmt.Errorf("user id is required")
	}
	provider := normalizeProvider(req.Provider)
	if provider == "" {
		provider = ProviderVirtual
	}
	if !isSupportedProvider(provider) {
		return OrderResult{}, fmt.Errorf("payment provider is unsupported")
	}
	if provider == ProviderVirtual && !s.cfg.AllowVirtualCallback {
		return OrderResult{}, fmt.Errorf("virtual payment provider is disabled")
	}
	checkout := s.checkoutClient(provider)
	if provider != ProviderVirtual && checkout == nil {
		return OrderResult{}, fmt.Errorf("payment provider %s is not configured", provider)
	}
	plan, ok := s.findPlan(req.PlanCode)
	if !ok {
		return OrderResult{}, fmt.Errorf("recharge plan is invalid")
	}
	amountCents := plan.AmountCents
	if provider != ProviderVirtual && s.cfg.OneCentTestEnabled {
		amountCents = 1
	}
	now := s.now()
	order, err := s.store.CreateOrder(ctx, Order{
		OrderNo:     newOrderNo(now),
		UClawUserID: req.UserID,
		Provider:    provider,
		AmountCents: amountCents,
		Quota:       plan.Quota,
		Status:      StatusCreated,
		CreatedAt:   now,
		UpdatedAt:   now,
	})
	if err != nil {
		return OrderResult{}, err
	}
	result := OrderResult{Order: order}
	if provider == ProviderVirtual {
		result.PayURL = "virtual://uclaw/recharge/" + order.OrderNo
		result.VirtualCallbackURL = "/v1/payments/virtual/notify"
		return result, nil
	}
	checkoutResult, err := checkout.CreateCheckout(ctx, CheckoutRequest{
		OrderNo:     order.OrderNo,
		Provider:    provider,
		Name:        plan.Name,
		AmountCents: amountCents,
		Currency:    plan.Currency,
	})
	if err != nil {
		return OrderResult{}, err
	}
	result.PayURL = checkoutResult.PayURL
	result.QRCodeURL = checkoutResult.QRCodeURL
	return result, nil
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
	return s.CreditPaidOrder(ctx, orderNo)
}

// HandleProviderPayment accepts a verified official-provider callback and credits New API once.
func (s *Service) HandleProviderPayment(ctx context.Context, req PaymentCallbackRequest) (Order, error) {
	provider := normalizeProvider(req.Provider)
	if provider == "" || provider == ProviderVirtual {
		return Order{}, fmt.Errorf("official payment provider is required")
	}
	orderNo := strings.TrimSpace(req.OrderNo)
	if orderNo == "" {
		return Order{}, fmt.Errorf("order no is required")
	}
	if !req.Paid {
		return Order{}, fmt.Errorf("payment status is not paid")
	}
	if !req.SignatureValid {
		return Order{}, fmt.Errorf("payment signature is invalid")
	}
	eventID := strings.TrimSpace(req.ProviderEventID)
	if eventID == "" {
		eventID = provider + "-" + orderNo
	}
	order, err := s.store.GetOrder(ctx, orderNo)
	if err != nil {
		return Order{}, err
	}
	if order.Provider != provider {
		return Order{}, fmt.Errorf("order provider mismatch")
	}
	if req.AmountCents != order.AmountCents {
		return Order{}, fmt.Errorf("payment amount mismatch")
	}
	paidAt := req.PaidAt
	if paidAt.IsZero() {
		paidAt = s.now()
	}
	payload := strings.TrimSpace(req.PayloadRedacted)
	if payload == "" {
		payload = fmt.Sprintf(`{"provider":%q}`, provider)
	}
	if err := s.store.SaveCallback(ctx, Callback{
		OrderID:         order.ID,
		Provider:        provider,
		ProviderEventID: eventID,
		SignatureValid:  true,
		PayloadRedacted: payload,
		ReceivedAt:      s.now(),
	}); err != nil {
		return Order{}, err
	}
	paid, err := s.store.MarkPaid(ctx, orderNo, strings.TrimSpace(req.ProviderTradeNo), paidAt)
	if err != nil {
		return Order{}, err
	}
	if paid.Status == StatusCredited {
		return paid, nil
	}
	return s.CreditPaidOrder(ctx, orderNo)
}

// CreditPaidOrder atomically credits New API quota for a paid recharge order.
func (s *Service) CreditPaidOrder(ctx context.Context, orderNo string) (Order, error) {
	orderNo = strings.TrimSpace(orderNo)
	if orderNo == "" {
		return Order{}, fmt.Errorf("order no is required")
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

// checkoutClient returns a configured checkout adapter for one official provider.
func (s *Service) checkoutClient(provider string) CheckoutClient {
	if s.cfg.CheckoutClients == nil {
		return nil
	}
	return s.cfg.CheckoutClients[normalizeProvider(provider)]
}

// normalizeProvider trims and folds provider aliases used by clients and docs.
func normalizeProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "wechatpay" || provider == "weixin" {
		return ProviderWeChat
	}
	return provider
}

// isSupportedProvider rejects unknown payment channels before any order is created.
func isSupportedProvider(provider string) bool {
	switch provider {
	case ProviderVirtual, ProviderAlipay, ProviderWeChat:
		return true
	default:
		return false
	}
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
