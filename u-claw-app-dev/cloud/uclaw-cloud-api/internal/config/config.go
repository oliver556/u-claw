package config

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Config is the runtime interface for U-Claw Cloud API process configuration.
type Config struct {
	AppEnv             string
	HTTPAddr           string
	DatabaseURL        string
	JWTSecret          string
	NewAPIAdminBaseURL string
	NewAPIAdminToken   string
	NewAPIHTTPTimeout  time.Duration
}

// Getter reads a configuration value from a backing store such as environment variables.
type Getter func(string) string

// Load reads process configuration and applies safe defaults for local development.
func Load(getenv Getter) (Config, error) {
	if getenv == nil {
		return Config{}, errors.New("config getter is nil")
	}

	cfg := Config{
		AppEnv:             withDefault(getenv("APP_ENV"), "development"),
		HTTPAddr:           withDefault(getenv("UCLAW_HTTP_ADDR"), ":8080"),
		DatabaseURL:        strings.TrimSpace(getenv("DATABASE_URL")),
		JWTSecret:          strings.TrimSpace(getenv("JWT_SECRET")),
		NewAPIAdminBaseURL: strings.TrimRight(strings.TrimSpace(getenv("NEWAPI_ADMIN_BASE_URL")), "/"),
		NewAPIAdminToken:   strings.TrimSpace(getenv("NEWAPI_ADMIN_TOKEN")),
		NewAPIHTTPTimeout:  10 * time.Second,
	}

	if raw := strings.TrimSpace(getenv("NEWAPI_HTTP_TIMEOUT")); raw != "" {
		timeout, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse NEWAPI_HTTP_TIMEOUT: %w", err)
		}
		cfg.NewAPIHTTPTimeout = timeout
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
	if len(missing) > 0 {
		return fmt.Errorf("missing required config: %s", strings.Join(missing, ", "))
	}
	return nil
}

// IsProduction reports whether the process should enforce production-only guardrails.
func (cfg Config) IsProduction() bool {
	return strings.EqualFold(cfg.AppEnv, "production")
}

// withDefault returns a trimmed value or fallback when value is empty.
func withDefault(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}
