package auth

import (
	"context"
	"strings"
	"testing"
	"time"
)

type captureSMSProvider struct {
	delivery SMSDelivery
}

// SendCode captures the delivery so tests can log in without exposing dev codes.
func (p *captureSMSProvider) SendCode(_ context.Context, delivery SMSDelivery) error {
	p.delivery = delivery
	return nil
}

func TestSMSLoginIssuesVerifiableToken(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{
		DevSMSCode:    "654321",
		ExposeCodes:   true,
		UseDevSMSCode: true,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	sendResult, err := service.SendSMS(context.Background(), "13800138000", "login")
	if err != nil {
		t.Fatalf("SendSMS() error = %v", err)
	}
	if sendResult.DevCode != "654321" {
		t.Fatalf("DevCode = %q, want 654321", sendResult.DevCode)
	}

	loginResult, err := service.Login(context.Background(), "13800138000", "login", "654321")
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if loginResult.User.Phone != "138****8000" {
		t.Fatalf("masked phone = %q", loginResult.User.Phone)
	}

	claims, err := manager.VerifyAccessToken(loginResult.AccessToken)
	if err != nil {
		t.Fatalf("VerifyAccessToken() error = %v", err)
	}
	if claims.Phone != "13800138000" || claims.Subject != "1" {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestSMSLoginRejectsConsumedCode(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{DevSMSCode: "123456", UseDevSMSCode: true})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	if _, err := service.SendSMS(context.Background(), "13800138000", "login"); err != nil {
		t.Fatalf("SendSMS() error = %v", err)
	}
	if _, err := service.Login(context.Background(), "13800138000", "login", "123456"); err != nil {
		t.Fatalf("first Login() error = %v", err)
	}
	if _, err := service.Login(context.Background(), "13800138000", "login", "123456"); err == nil {
		t.Fatal("second Login() error = nil, want consumed code error")
	}
}

func TestSMSProviderReceivesGeneratedCodeWithoutExposingIt(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	provider := &captureSMSProvider{}
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{
		Provider:    provider,
		CodePepper:  "test-pepper",
		ExposeCodes: false,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	sendResult, err := service.SendSMS(context.Background(), "13800138000", "login")
	if err != nil {
		t.Fatalf("SendSMS() error = %v", err)
	}
	if sendResult.DevCode != "" {
		t.Fatalf("DevCode = %q, want hidden", sendResult.DevCode)
	}
	if provider.delivery.Phone != "13800138000" || len(provider.delivery.Code) != 6 {
		t.Fatalf("provider delivery = %+v", provider.delivery)
	}
	if _, err := service.Login(context.Background(), "13800138000", "login", provider.delivery.Code); err != nil {
		t.Fatalf("Login() with provider code error = %v", err)
	}
}

func TestReservedSMSProviderFailsClosed(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{
		Provider: ReservedSMSProvider{Name: "aliyun"},
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	_, err = service.SendSMS(context.Background(), "13800138000", "login")
	if err == nil || !strings.Contains(err.Error(), "reserved but not implemented") {
		t.Fatalf("SendSMS() error = %v, want reserved provider failure", err)
	}
}

func TestTokenManagerRejectsExpiredToken(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	manager.now = func() time.Time { return now }

	token, err := manager.IssueAccessToken(1, "13800138000", time.Second)
	if err != nil {
		t.Fatalf("IssueAccessToken() error = %v", err)
	}

	manager.now = func() time.Time { return now.Add(2 * time.Second) }
	if _, err := manager.VerifyAccessToken(token); err == nil {
		t.Fatal("VerifyAccessToken() error = nil, want expired")
	}
}
