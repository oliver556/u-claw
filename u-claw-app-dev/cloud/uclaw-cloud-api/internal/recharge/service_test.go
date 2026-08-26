package recharge

import (
	"context"
	"errors"
	"testing"
	"time"

	"uclaw-cloud-api/internal/newapi"
)

type fakeQuotaClient struct {
	calls []newapi.AddQuotaRequest
	err   error
}

// AddQuota records quota calls so tests can assert idempotency.
func (f *fakeQuotaClient) AddQuota(_ context.Context, req newapi.AddQuotaRequest) error {
	f.calls = append(f.calls, req)
	return f.err
}

func TestCreateOrderUsesConfiguredPlan(t *testing.T) {
	store := NewMemoryStore()
	service, err := NewService(store, &fakeQuotaClient{}, Config{AllowVirtualCallback: true})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	result, err := service.CreateOrder(context.Background(), CreateOrderRequest{
		UserID:   7,
		PlanCode: "dev_10",
		Provider: ProviderVirtual,
	})
	if err != nil {
		t.Fatalf("CreateOrder() error = %v", err)
	}

	if result.Order.Status != StatusCreated || result.Order.AmountCents != 1000 || result.Order.Quota != 50000 {
		t.Fatalf("order = %+v", result.Order)
	}
	if result.PayURL == "" || result.VirtualCallbackURL == "" {
		t.Fatalf("result missing virtual payment hints: %+v", result)
	}
}

func TestVirtualCallbackCreditsNewAPIOnce(t *testing.T) {
	store := NewMemoryStore()
	store.SaveAccount(Account{UClawUserID: 7, NewAPIUserID: 42})
	quota := &fakeQuotaClient{}
	service, err := NewService(store, quota, Config{AllowVirtualCallback: true})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	service.now = func() time.Time {
		return time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	}

	created, err := service.CreateOrder(context.Background(), CreateOrderRequest{
		UserID:   7,
		PlanCode: "dev_10",
	})
	if err != nil {
		t.Fatalf("CreateOrder() error = %v", err)
	}

	first, err := service.HandleVirtualCallback(context.Background(), VirtualCallbackRequest{
		OrderNo:         created.Order.OrderNo,
		ProviderEventID: "evt-1",
	})
	if err != nil {
		t.Fatalf("HandleVirtualCallback() first error = %v", err)
	}
	second, err := service.HandleVirtualCallback(context.Background(), VirtualCallbackRequest{
		OrderNo:         created.Order.OrderNo,
		ProviderEventID: "evt-1",
	})
	if err != nil {
		t.Fatalf("HandleVirtualCallback() second error = %v", err)
	}

	if first.Status != StatusCredited || second.Status != StatusCredited {
		t.Fatalf("statuses = %s, %s", first.Status, second.Status)
	}
	if len(quota.calls) != 1 {
		t.Fatalf("AddQuota calls = %d, want 1", len(quota.calls))
	}
	if quota.calls[0].UserID != 42 || quota.calls[0].Quota != 50000 {
		t.Fatalf("AddQuota request = %+v", quota.calls[0])
	}

	orders, err := service.ListOrders(context.Background(), 7, 20)
	if err != nil {
		t.Fatalf("ListOrders() error = %v", err)
	}
	if len(orders) != 1 || orders[0].Status != StatusCredited {
		t.Fatalf("orders = %+v", orders)
	}
}

func TestVirtualCallbackMarksCreditFailure(t *testing.T) {
	store := NewMemoryStore()
	store.SaveAccount(Account{UClawUserID: 7, NewAPIUserID: 42})
	service, err := NewService(store, &fakeQuotaClient{err: errors.New("newapi down")}, Config{AllowVirtualCallback: true})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	created, err := service.CreateOrder(context.Background(), CreateOrderRequest{UserID: 7, PlanCode: "dev_10"})
	if err != nil {
		t.Fatalf("CreateOrder() error = %v", err)
	}

	order, err := service.HandleVirtualCallback(context.Background(), VirtualCallbackRequest{OrderNo: created.Order.OrderNo})
	if err == nil {
		t.Fatal("HandleVirtualCallback() error = nil, want newapi error")
	}
	if order.Status != StatusCreditFailed || order.LastError == "" {
		t.Fatalf("order = %+v", order)
	}
}

func TestVirtualCallbackCanBeDisabled(t *testing.T) {
	service, err := NewService(NewMemoryStore(), &fakeQuotaClient{}, Config{AllowVirtualCallback: false})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	_, err = service.HandleVirtualCallback(context.Background(), VirtualCallbackRequest{OrderNo: "UC1"})
	if err == nil {
		t.Fatal("HandleVirtualCallback() error = nil, want disabled error")
	}
}
