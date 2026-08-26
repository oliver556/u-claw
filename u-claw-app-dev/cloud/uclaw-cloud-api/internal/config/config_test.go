package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadAppliesDefaultsAndTrimsNewAPIBaseURL(t *testing.T) {
	values := map[string]string{
		"NEWAPI_ADMIN_BASE_URL":        " https://newapi.example.com/ ",
		"NEWAPI_CLIENT_BASE_URL":       " https://api.example.com/v1/ ",
		"NEWAPI_PREVIEW_TOKEN":         "preview-token",
		"NEWAPI_HTTP_TIMEOUT":          "3s",
		"NEWAPI_ACTIVATION_QUOTA":      "100000",
		"NEWAPI_TOKEN_NAME":            "uclaw-desktop",
		"NEWAPI_USER_PASSWORD_SECRET":  "password-secret",
		"AUTH_TOKEN_TTL":               "2h",
		"SMS_PROVIDER":                 "aliyun",
		"DEV_SMS_CODE":                 "654321",
		"SMS_CODE_PEPPER":              "sms-pepper",
		"ALIYUN_SMS_ACCESS_KEY_ID":     "aliyun-id",
		"ALIYUN_SMS_ACCESS_KEY_SECRET": "aliyun-secret",
		"ALIYUN_SMS_SIGN_NAME":         "U-Claw",
		"ALIYUN_SMS_TEMPLATE_CODE":     "SMS_123",
		"ACTIVATION_CODE_PEPPER":       "activation-pepper",
		"LICENSE_SIGNING_KEY_ID":       " license-key-1 ",
		"LICENSE_SIGNING_SEED_HEX":     strings.Repeat("11", 32),
		"WECHAT_PAY_MCH_ID":            " mch-1 ",
		"WECHAT_PAY_APP_ID":            " app-1 ",
		"WECHAT_PAY_API_V3_KEY":        " v3-key ",
		"WECHAT_PAY_PRIVATE_KEY_PATH":  " /secrets/wechat.pem ",
		"WECHAT_PAY_CERT_SERIAL_NO":    " serial-1 ",
		"ALIPAY_APP_ID":                " alipay-1 ",
		"ALIPAY_PRIVATE_KEY_PATH":      " /secrets/alipay.pem ",
		"ALIPAY_PUBLIC_CERT_PATH":      " /secrets/alipay-public.crt ",
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
	if cfg.SMSProvider != "aliyun" {
		t.Fatalf("SMSProvider = %q, want aliyun", cfg.SMSProvider)
	}
	if cfg.SMSCodePepper != "sms-pepper" {
		t.Fatalf("SMSCodePepper = %q", cfg.SMSCodePepper)
	}
	if cfg.AliyunSMSAccessKeyID != "aliyun-id" || cfg.AliyunSMSTemplateCode != "SMS_123" {
		t.Fatalf("aliyun sms config not loaded: %+v", cfg)
	}
	if cfg.ActivationCodePepper != "activation-pepper" {
		t.Fatalf("ActivationCodePepper = %q", cfg.ActivationCodePepper)
	}
	if cfg.LicenseSigningKeyID != "license-key-1" || cfg.LicenseSigningSeedHex != strings.Repeat("11", 32) {
		t.Fatalf("license signing config not loaded: %+v", cfg)
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
	for _, name := range []string{"DATABASE_URL", "JWT_SECRET", "NEWAPI_ADMIN_BASE_URL", "NEWAPI_ADMIN_TOKEN", "NEWAPI_USER_PASSWORD_SECRET", "SMS_PROVIDER", "LICENSE_SIGNING_KEY_ID", "LICENSE_SIGNING_SEED_HEX"} {
		if !strings.Contains(message, name) {
			t.Fatalf("ValidateForServe() error %q missing %s", message, name)
		}
	}
}

func TestValidateForServeRejectsDevelopmentSMSProvider(t *testing.T) {
	cfg := completeProductionConfig()
	cfg.SMSProvider = "development"

	err := cfg.ValidateForServe()
	if err == nil || !strings.Contains(err.Error(), "SMS_PROVIDER(non-development)") {
		t.Fatalf("ValidateForServe() error = %v, want development sms provider rejection", err)
	}
}

func TestValidateForServeRequiresAliyunSMSFields(t *testing.T) {
	cfg := completeProductionConfig()
	cfg.AliyunSMSAccessKeySecret = ""
	cfg.AliyunSMSTemplateCode = ""

	err := cfg.ValidateForServe()
	if err == nil {
		t.Fatal("ValidateForServe() error = nil, want aliyun sms field error")
	}
	for _, name := range []string{"ALIYUN_SMS_ACCESS_KEY_SECRET", "ALIYUN_SMS_TEMPLATE_CODE"} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("ValidateForServe() error %q missing %s", err.Error(), name)
		}
	}
}

// completeProductionConfig returns a minimal production-like config without real secrets.
func completeProductionConfig() Config {
	return Config{
		AppEnv:                   "production",
		DatabaseURL:              "postgres://user:pass@127.0.0.1:5432/uclaw",
		JWTSecret:                "jwt-secret-at-least-32-bytes",
		NewAPIAdminBaseURL:       "https://newapi.example.com",
		NewAPIAdminToken:         "newapi-admin-token",
		NewAPIUserPasswordSecret: "password-secret-at-least-32-bytes",
		SMSProvider:              "aliyun",
		AliyunSMSAccessKeyID:     "aliyun-id",
		AliyunSMSAccessKeySecret: "aliyun-secret",
		AliyunSMSSignName:        "U-Claw",
		AliyunSMSTemplateCode:    "SMS_123",
		LicenseSigningKeyID:      "license-key",
		LicenseSigningSeedHex:    strings.Repeat("11", 32),
	}
}
