package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadAppliesDefaultsAndTrimsNewAPIBaseURL(t *testing.T) {
	values := map[string]string{
		"NEWAPI_ADMIN_BASE_URL": " https://newapi.example.com/ ",
		"NEWAPI_HTTP_TIMEOUT":   "3s",
		"AUTH_TOKEN_TTL":        "2h",
		"DEV_SMS_CODE":          "654321",
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
	if cfg.NewAPIHTTPTimeout != 3*time.Second {
		t.Fatalf("NewAPIHTTPTimeout = %v, want 3s", cfg.NewAPIHTTPTimeout)
	}
	if cfg.AuthTokenTTL != 2*time.Hour {
		t.Fatalf("AuthTokenTTL = %v, want 2h", cfg.AuthTokenTTL)
	}
	if cfg.DevSMSCode != "654321" {
		t.Fatalf("DevSMSCode = %q, want 654321", cfg.DevSMSCode)
	}
}

func TestValidateForServeReportsMissingFields(t *testing.T) {
	err := (Config{}).ValidateForServe()
	if err == nil {
		t.Fatal("ValidateForServe() error = nil, want missing config error")
	}

	message := err.Error()
	for _, name := range []string{"DATABASE_URL", "JWT_SECRET", "NEWAPI_ADMIN_BASE_URL", "NEWAPI_ADMIN_TOKEN"} {
		if !strings.Contains(message, name) {
			t.Fatalf("ValidateForServe() error %q missing %s", message, name)
		}
	}
}
