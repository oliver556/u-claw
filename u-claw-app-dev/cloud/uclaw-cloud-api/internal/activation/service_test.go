package activation

import (
	"context"
	"testing"
)

func TestRedeemReturnsClientConfig(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{
		NewAPIBaseURL: "https://api.example.com/v1/",
		PreviewToken:  "preview-token",
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.Redeem(context.Background(), RedeemRequest{
		UserID:         7,
		Phone:          "13800138000",
		ActivationCode: "ABCD-EFGH-IJKL-MNOP",
	})
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}

	if result.Status != "activated" {
		t.Fatalf("status = %q", result.Status)
	}
	if result.PhoneMasked != "138****8000" {
		t.Fatalf("phone = %q", result.PhoneMasked)
	}
	if result.NewAPIBaseURL != "https://api.example.com/v1" {
		t.Fatalf("base url = %q", result.NewAPIBaseURL)
	}
	if result.NewAPIToken != "preview-token" {
		t.Fatal("missing preview token")
	}
	if result.DefaultModels.Text != "custom/gpt-5.5" {
		t.Fatalf("text model = %q", result.DefaultModels.Text)
	}
}

func TestRedeemAllowsSameUserRetry(t *testing.T) {
	store := NewMemoryStore(true)
	service, err := NewService(store, Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	req := RedeemRequest{UserID: 1, Phone: "13800138000", ActivationCode: "ABCD-EFGH-IJKL"}
	if _, err := service.Redeem(context.Background(), req); err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	if _, err := service.Redeem(context.Background(), req); err != nil {
		t.Fatalf("second redeem same user: %v", err)
	}
}

func TestRedeemRejectsDuplicateCodeForDifferentUser(t *testing.T) {
	store := NewMemoryStore(true)
	service, err := NewService(store, Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	if _, err := service.Redeem(context.Background(), RedeemRequest{UserID: 1, Phone: "13800138000", ActivationCode: "ABCD-EFGH-IJKL"}); err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	if _, err := service.Redeem(context.Background(), RedeemRequest{UserID: 2, Phone: "13900139000", ActivationCode: "ABCD-EFGH-IJKL"}); err == nil {
		t.Fatal("second redeem different user succeeded, want duplicate error")
	}
}

func TestRedeemRejectsUnconfiguredStore(t *testing.T) {
	service, err := NewService(NewMemoryStore(false), Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	if _, err := service.Redeem(context.Background(), RedeemRequest{
		UserID:         1,
		Phone:          "13800138000",
		ActivationCode: "ABCD-EFGH-IJKL",
	}); err == nil {
		t.Fatal("redeem succeeded without configured activation store")
	}
}
