package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadAppliesDefaultsAndTrimsNewAPIBaseURL(t *testing.T) {
	values := map[string]string{
		"NEWAPI_ADMIN_BASE_URL":       " https://newapi.example.com/ ",
		"NEWAPI_CLIENT_BASE_URL":      " https://api.example.com/v1/ ",
		"NEWAPI_PREVIEW_TOKEN":        "preview-token",
		"NEWAPI_HTTP_TIMEOUT":         "3s",
		"NEWAPI_ACTIVATION_QUOTA":     "100000",
		"NEWAPI_TOKEN_NAME":           "uclaw-desktop",
		"NEWAPI_USER_PASSWORD_SECRET": "password-secret",
		"AUTH_TOKEN_TTL":              "2h",
		"DEV_SMS_CODE":                "654321",
		"SMS_CODE_PEPPER":             "sms-pepper",
		"ACTIVATION_CODE_PEPPER":      "activation-pepper",
		"WECHAT_PAY_MCH_ID":           " mch-1 ",
		"WECHAT_PAY_APP_ID":           " app-1 ",
		"WECHAT_PAY_API_V3_KEY":       " v3-key ",
		"WECHAT_PAY_PRIVATE_KEY_PATH": " /secrets/wechat.pem ",
		"WECHAT_PAY_CERT_SERIAL_NO":   " serial-1 ",
		"ALIPAY_APP_ID":               " alipay-1 ",
		"ALIPAY_PRIVATE_KEY_PATH":     " /secrets/alipay.pem ",
		"ALIPAY_PUBLIC_CERT_PATH":     " /secrets/alipay-public.crt ",
	}

	cfg, err := Load(func(key string) string {
		return values[key]
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.AppEnv != "development" {
		t.Fatalf("AppEnv = %q, want development", cfg.AppEnv)
	}
	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
	}
	if cfg.NewAPIAdminBaseURL != "https://newapi.example.com" {
		t.Fatalf("NewAPIAdminBaseURL = %q", cfg.NewAPIAdminBaseURL)
	}
	if cfg.NewAPIClientBaseURL != "https://api.example.com/v1" {
		t.Fatalf("NewAPIClientBaseURL = %q", cfg.NewAPIClientBaseURL)
	}
	if cfg.NewAPIPreviewToken != "preview-token" {
		t.Fatalf("NewAPIPreviewToken = %q", cfg.NewAPIPreviewToken)
	}
	if cfg.NewAPIHTTPTimeout != 3*time.Second {
		t.Fatalf("NewAPIHTTPTimeout = %v, want 3s", cfg.NewAPIHTTPTimeout)
	}
	if cfg.NewAPIActivationQuota != 100000 {
		t.Fatalf("NewAPIActivationQuota = %d, want 100000", cfg.NewAPIActivationQuota)
	}
	if cfg.NewAPITokenName != "uclaw-desktop" {
		t.Fatalf("NewAPITokenName = %q", cfg.NewAPITokenName)
	}
	if cfg.NewAPIUserPasswordSecret != "password-secret" {
		t.Fatalf("NewAPIUserPasswordSecret = %q", cfg.NewAPIUserPasswordSecret)
	}
	if cfg.AuthTokenTTL != 2*time.Hour {
		t.Fatalf("AuthTokenTTL = %v, want 2h", cfg.AuthTokenTTL)
	}
	if cfg.DevSMSCode != "654321" {
		t.Fatalf("DevSMSCode = %q, want 654321", cfg.DevSMSCode)
	}
	if cfg.SMSCodePepper != "sms-pepper" {
		t.Fatalf("SMSCodePepper = %q", cfg.SMSCodePepper)
	}
	if cfg.ActivationCodePepper != "activation-pepper" {
		t.Fatalf("ActivationCodePepper = %q", cfg.ActivationCodePepper)
	}
	if !cfg.WeChatPayConfigured() {
		t.Fatalf("WeChatPayConfigured() = false for %+v", cfg)
	}
	if !cfg.AlipayConfigured() {
		t.Fatalf("AlipayConfigured() = false for %+v", cfg)
	}
	if cfg.WeChatPayMchID != "mch-1" || cfg.AlipayAppID != "alipay-1" {
		t.Fatalf("payment config not trimmed: %+v", cfg)
	}
}

func TestValidateForServeReportsMissingFields(t *testing.T) {
	err := (Config{}).ValidateForServe()
	if err == nil {
		t.Fatal("ValidateForServe() error = nil, want missing config error")
	}

	message := err.Error()
	for _, name := range []string{"DATABASE_URL", "JWT_SECRET", "NEWAPI_ADMIN_BASE_URL", "NEWAPI_ADMIN_TOKEN", "NEWAPI_USER_PASSWORD_SECRET"} {
		if !strings.Contains(message, name) {
			t.Fatalf("ValidateForServe() error %q missing %s", message, name)
		}
	}
}
