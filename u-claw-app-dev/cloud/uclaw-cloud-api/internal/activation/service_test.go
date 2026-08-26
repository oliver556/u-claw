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

func TestActivateFirstStartReturnsServerBoundEnvelope(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{
		NewAPIBaseURL: "https://api.example.com/v1/",
		PreviewToken:  "preview-token",
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Username:              "uclaw-biancheng",
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-static-1",
	})
	if err != nil {
		t.Fatalf("activate first start: %v", err)
	}

	if result.Status != "server_bound" {
		t.Fatalf("status = %q, want server_bound", result.Status)
	}
	if result.ActivationID == "" {
		t.Fatal("activation id is empty")
	}
	if result.UsernameMasked != "UCLAW-BIANCHENG" {
		t.Fatalf("username masked = %q", result.UsernameMasked)
	}
	if result.ArtifactStatus != "pending_client_write" {
		t.Fatalf("artifact status = %q", result.ArtifactStatus)
	}
	if result.NewAPIToken != "preview-token" {
		t.Fatalf("token = %q", result.NewAPIToken)
	}
}

func TestActivateFirstStartIsIdempotentForSameRequest(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	req := FirstStartRequest{
		Username:              "UCLAW-BIANCHENG",
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-static-1",
	}

	first, err := service.ActivateFirstStart(context.Background(), req)
	if err != nil {
		t.Fatalf("first activate: %v", err)
	}
	second, err := service.ActivateFirstStart(context.Background(), req)
	if err != nil {
		t.Fatalf("second activate: %v", err)
	}

	if first.ActivationID != second.ActivationID {
		t.Fatalf("activation ids differ: %q vs %q", first.ActivationID, second.ActivationID)
	}
}

func TestCommitFirstStartMarksClientWriteComplete(t *testing.T) {
	service, err := NewService(NewMemoryStore(true), Config{})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	activated, err := service.ActivateFirstStart(context.Background(), FirstStartRequest{
		Username:              "UCLAW-BIANCHENG",
		ActivationCode:        "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ",
		USBFingerprintSummary: "PREVIEW-ONLY",
		IdempotencyKey:        "idem-static-1",
	})
	if err != nil {
		t.Fatalf("activate: %v", err)
	}

	committed, err := service.CommitFirstStart(context.Background(), CommitRequest{
		ActivationID: activated.ActivationID,
		WriteStatus:  "verified",
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}

	if committed.Status != "committed" {
		t.Fatalf("status = %q, want committed", committed.Status)
	}
	if committed.ActivationID != activated.ActivationID {
		t.Fatalf("activation id = %q, want %q", committed.ActivationID, activated.ActivationID)
	}
}
