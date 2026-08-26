package auth

import (
	"context"
	"testing"
	"time"
)

func TestSMSLoginIssuesVerifiableToken(t *testing.T) {
	manager, err := NewTokenManager("test-secret")
	if err != nil {
		t.Fatalf("NewTokenManager() error = %v", err)
	}
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{
		DevSMSCode:  "654321",
		ExposeCodes: true,
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
	service, err := NewService(NewMemoryStore(), manager, ServiceConfig{DevSMSCode: "123456"})
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
