package config

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Config is the runtime interface for U-Claw Cloud API process configuration.
type Config struct {
	AppEnv                   string
	HTTPAddr                 string
	DatabaseURL              string
	JWTSecret                string
	NewAPIAdminBaseURL       string
	NewAPIAdminToken         string
	NewAPIClientBaseURL      string
	NewAPIPreviewToken       string
	NewAPIHTTPTimeout        time.Duration
	NewAPIActivationQuota    int64
	NewAPITokenName          string
	NewAPIUserPasswordSecret string
	AuthTokenTTL             time.Duration
	DevSMSCode               string
	SMSCodePepper            string
	ActivationCodePepper     string
	LicenseSigningKeyID      string
	LicenseSigningSeedHex    string
	WeChatPayMchID           string
	WeChatPayAppID           string
	WeChatPayAPIV3Key        string
	WeChatPayPrivateKeyPath  string
	WeChatPayCertSerialNo    string
	AlipayAppID              string
	AlipayPrivateKeyPath     string
	AlipayPublicCertPath     string
}

// Getter reads a configuration value from a backing store such as environment variables.
type Getter func(string) string

// Load reads process configuration and applies safe defaults for local development.
func Load(getenv Getter) (Config, error) {
	if getenv == nil {
		return Config{}, errors.New("config getter is nil")
	}

	cfg := Config{
		AppEnv:                   withDefault(getenv("APP_ENV"), "development"),
		HTTPAddr:                 withDefault(getenv("UCLAW_HTTP_ADDR"), ":8080"),
		DatabaseURL:              strings.TrimSpace(getenv("DATABASE_URL")),
		JWTSecret:                strings.TrimSpace(getenv("JWT_SECRET")),
		NewAPIAdminBaseURL:       strings.TrimRight(strings.TrimSpace(getenv("NEWAPI_ADMIN_BASE_URL")), "/"),
		NewAPIAdminToken:         strings.TrimSpace(getenv("NEWAPI_ADMIN_TOKEN")),
		NewAPIClientBaseURL:      strings.TrimRight(withDefault(getenv("NEWAPI_CLIENT_BASE_URL"), "https://api.gmnlee.com/v1"), "/"),
		NewAPIPreviewToken:       withDefault(getenv("NEWAPI_PREVIEW_TOKEN"), "uclaw-preview-newapi-token"),
		NewAPIHTTPTimeout:        10 * time.Second,
		NewAPIActivationQuota:    0,
		NewAPITokenName:          withDefault(getenv("NEWAPI_TOKEN_NAME"), "uclaw-main"),
		NewAPIUserPasswordSecret: withDefault(getenv("NEWAPI_USER_PASSWORD_SECRET"), "uclaw-dev-newapi-user-password-secret"),
		AuthTokenTTL:             24 * time.Hour,
		DevSMSCode:               withDefault(getenv("DEV_SMS_CODE"), "123456"),
		SMSCodePepper:            withDefault(getenv("SMS_CODE_PEPPER"), "uclaw-dev-sms-code-pepper"),
		ActivationCodePepper:     withDefault(getenv("ACTIVATION_CODE_PEPPER"), "uclaw-dev-activation-code-pepper"),
		LicenseSigningKeyID:      strings.TrimSpace(getenv("LICENSE_SIGNING_KEY_ID")),
		LicenseSigningSeedHex:    strings.TrimSpace(getenv("LICENSE_SIGNING_SEED_HEX")),
		WeChatPayMchID:           strings.TrimSpace(getenv("WECHAT_PAY_MCH_ID")),
		WeChatPayAppID:           strings.TrimSpace(getenv("WECHAT_PAY_APP_ID")),
		WeChatPayAPIV3Key:        strings.TrimSpace(getenv("WECHAT_PAY_API_V3_KEY")),
		WeChatPayPrivateKeyPath:  strings.TrimSpace(getenv("WECHAT_PAY_PRIVATE_KEY_PATH")),
		WeChatPayCertSerialNo:    strings.TrimSpace(getenv("WECHAT_PAY_CERT_SERIAL_NO")),
		AlipayAppID:              strings.TrimSpace(getenv("ALIPAY_APP_ID")),
		AlipayPrivateKeyPath:     strings.TrimSpace(getenv("ALIPAY_PRIVATE_KEY_PATH")),
		AlipayPublicCertPath:     strings.TrimSpace(getenv("ALIPAY_PUBLIC_CERT_PATH")),
	}

	if raw := strings.TrimSpace(getenv("NEWAPI_HTTP_TIMEOUT")); raw != "" {
		timeout, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse NEWAPI_HTTP_TIMEOUT: %w", err)
		}
		cfg.NewAPIHTTPTimeout = timeout
	}
	if raw := strings.TrimSpace(getenv("NEWAPI_ACTIVATION_QUOTA")); raw != "" {
		quota, err := parseNonNegativeInt64(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse NEWAPI_ACTIVATION_QUOTA: %w", err)
		}
		cfg.NewAPIActivationQuota = quota
	}
	if raw := strings.TrimSpace(getenv("AUTH_TOKEN_TTL")); raw != "" {
		timeout, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse AUTH_TOKEN_TTL: %w", err)
		}
		cfg.AuthTokenTTL = timeout
	}

	return cfg, nil
}

// ValidateForServe checks fields required before accepting production traffic.
func (cfg Config) ValidateForServe() error {
	var missing []string
	if cfg.DatabaseURL == "" {
		missing = append(missing, "DATABASE_URL")
	}
	if cfg.JWTSecret == "" {
		missing = append(missing, "JWT_SECRET")
	}
	if cfg.NewAPIAdminBaseURL == "" {
		missing = append(missing, "NEWAPI_ADMIN_BASE_URL")
	}
	if cfg.NewAPIAdminToken == "" {
		missing = append(missing, "NEWAPI_ADMIN_TOKEN")
	}
	if cfg.NewAPIUserPasswordSecret == "" {
		missing = append(missing, "NEWAPI_USER_PASSWORD_SECRET")
	}
	if cfg.LicenseSigningKeyID == "" {
		missing = append(missing, "LICENSE_SIGNING_KEY_ID")
	}
	if cfg.LicenseSigningSeedHex == "" {
		missing = append(missing, "LICENSE_SIGNING_SEED_HEX")
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required config: %s", strings.Join(missing, ", "))
	}
	return nil
}

// IsProduction reports whether the process should enforce production-only guardrails.
func (cfg Config) IsProduction() bool {
	return strings.EqualFold(cfg.AppEnv, "production")
}

// WeChatPayConfigured reports whether all fields needed to initialize WeChat Pay are present.
func (cfg Config) WeChatPayConfigured() bool {
	return cfg.WeChatPayMchID != "" &&
		cfg.WeChatPayAppID != "" &&
		cfg.WeChatPayAPIV3Key != "" &&
		cfg.WeChatPayPrivateKeyPath != "" &&
		cfg.WeChatPayCertSerialNo != ""
}

// AlipayConfigured reports whether all fields needed to initialize Alipay are present.
func (cfg Config) AlipayConfigured() bool {
	return cfg.AlipayAppID != "" &&
		cfg.AlipayPrivateKeyPath != "" &&
		cfg.AlipayPublicCertPath != ""
}

// withDefault returns a trimmed value or fallback when value is empty.
func withDefault(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

// parseNonNegativeInt64 parses quota-like config where zero means disabled.
func parseNonNegativeInt64(raw string) (int64, error) {
	var value int64
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("invalid integer %q", raw)
		}
		value = value*10 + int64(ch-'0')
	}
	return value, nil
}
