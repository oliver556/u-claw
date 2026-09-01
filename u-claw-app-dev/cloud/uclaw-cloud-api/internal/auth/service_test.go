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

func TestFixedSMSLoginCanSkipSendForStaging(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{
		DevSMSCode:                 "123456",
		UseDevSMSCode:              true,
		AllowFixedLoginWithoutSend: true,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	loginResult, err := service.Login(context.Background(), "13800138000", "login", "123456")
	if err != nil {
		t.Fatalf("Login() with fixed code error = %v", err)
	}
	if loginResult.User.Phone != "138****8000" || loginResult.AccessToken == "" {
		t.Fatalf("login result = %+v", loginResult)
	}
}

func TestRefreshAccessTokenRenewsExpiredSignedToken(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	now := time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)
	manager.now = func() time.Time { return now }
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{
		TokenTTL:             time.Hour,
		TokenRefreshGraceTTL: 30 * 24 * time.Hour,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	expired, err := manager.IssueAccessToken(9, "13800138000", time.Second)
	if err != nil {
		t.Fatalf("IssueAccessToken() error = %v", err)
	}

	now = now.Add(2 * time.Second)
	refreshed, err := service.RefreshAccessToken(expired)
	if err != nil {
		t.Fatalf("RefreshAccessToken() error = %v", err)
	}
	if refreshed.AccessToken == "" || refreshed.User.ID != 9 || refreshed.User.Phone != "138****8000" {
		t.Fatalf("refresh result = %+v", refreshed)
	}
	claims, err := manager.VerifyAccessToken(refreshed.AccessToken)
	if err != nil {
		t.Fatalf("VerifyAccessToken(refreshed) error = %v", err)
	}
	if claims.Subject != "9" || claims.Phone != "13800138000" {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestRefreshAccessTokenRejectsExpiredRefreshWindow(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	now := time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)
	manager.now = func() time.Time { return now }
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{
		TokenTTL:             time.Hour,
		TokenRefreshGraceTTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	expired, err := manager.IssueAccessToken(9, "13800138000", time.Second)
	if err != nil {
		t.Fatalf("IssueAccessToken() error = %v", err)
	}

	now = now.Add(2 * time.Minute)
	if _, err := service.RefreshAccessToken(expired); err == nil {
		t.Fatal("RefreshAccessToken() error = nil, want expired refresh window")
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
