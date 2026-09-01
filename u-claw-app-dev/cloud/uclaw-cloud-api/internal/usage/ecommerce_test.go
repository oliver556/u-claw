package usage

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"uclaw-cloud-api/internal/newapi"
)

type fakeQuotaClient struct {
	fail  bool
	calls []newapi.AddQuotaRequest
}

func (c *fakeQuotaClient) SubtractQuota(_ context.Context, req newapi.AddQuotaRequest) error {
	c.calls = append(c.calls, req)
	if c.fail {
		return fmt.Errorf("quota failed")
	}
	return nil
}

func TestRecordEcommerceImageUsageDebitsOnceAndListsSettledRecord(t *testing.T) {
	adminServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/api/user/search" {
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"username":"13800138000"}]}}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer adminServer.Close()
	admin, err := newapi.NewClient(adminServer.URL, "admin-token", adminServer.Client())
	if err != nil {
		t.Fatalf("newapi client: %v", err)
	}
	store := NewMemoryStore()
	quota := &fakeQuotaClient{}
	service, err := NewService(admin, Config{PasswordSecret: "test"}, store)
	if err != nil {
		t.Fatalf("usage service: %v", err)
	}
	service.quota = quota
	service.now = func() time.Time { return time.Unix(1787762761, 0) }

	req := EcommerceImageUsageRequest{
		UserID:        1,
		Phone:         "13800138000",
		RequestID:     "ecom-run-1",
		Model:         "newapi/gpt-image-2",
		TokenName:     "uclaw-main",
		OutputTypes:   []string{"main_image"},
		ImageCount:    2,
		QuotaPerImage: 50000,
	}
	first, err := service.RecordEcommerceImageUsage(context.Background(), req)
	if err != nil {
		t.Fatalf("RecordEcommerceImageUsage first: %v", err)
	}
	second, err := service.RecordEcommerceImageUsage(context.Background(), req)
	if err != nil {
		t.Fatalf("RecordEcommerceImageUsage duplicate: %v", err)
	}
	if first.Quota != 100000 || first.Duplicate || !second.Duplicate {
		t.Fatalf("results first=%+v second=%+v", first, second)
	}
	if len(quota.calls) != 1 || quota.calls[0].UserID != 9 || quota.calls[0].Quota != 100000 {
		t.Fatalf("quota calls = %+v", quota.calls)
	}
	events, err := store.ListEcommerceImageUsage(context.Background(), 1, 10)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != 1 || events[0].Status != "settled" || events[0].Model != "gpt-image-2" {
		t.Fatalf("events = %+v", events)
	}
}

func TestRecordEcommerceImageUsageReleasesPendingClaimOnDebitFailure(t *testing.T) {
	adminServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"username":"13800138000"}]}}`))
	}))
	defer adminServer.Close()
	admin, err := newapi.NewClient(adminServer.URL, "admin-token", adminServer.Client())
	if err != nil {
		t.Fatalf("newapi client: %v", err)
	}
	store := NewMemoryStore()
	quota := &fakeQuotaClient{fail: true}
	service, err := NewService(admin, Config{PasswordSecret: "test"}, store)
	if err != nil {
		t.Fatalf("usage service: %v", err)
	}
	service.quota = quota

	_, err = service.RecordEcommerceImageUsage(context.Background(), EcommerceImageUsageRequest{
		UserID:        1,
		Phone:         "13800138000",
		RequestID:     "ecom-run-fail",
		Model:         "gpt-image-2",
		ImageCount:    1,
		QuotaPerImage: 50000,
	})
	if err == nil {
		t.Fatal("RecordEcommerceImageUsage error = nil, want quota failure")
	}
	events, listErr := store.ListEcommerceImageUsage(context.Background(), 1, 10)
	if listErr != nil {
		t.Fatalf("list events: %v", listErr)
	}
	if len(events) != 0 {
		t.Fatalf("events = %+v, want none after failed debit", events)
	}
}
