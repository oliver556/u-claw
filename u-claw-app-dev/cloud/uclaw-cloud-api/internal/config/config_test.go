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
