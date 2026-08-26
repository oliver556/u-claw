package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"uclaw-cloud-api/internal/activation"
	"uclaw-cloud-api/internal/auth"
	"uclaw-cloud-api/internal/config"
)

const developmentJWTSecret = "uclaw-development-only-secret-change-before-production"

// BuildInfo describes the running build exposed through health endpoints.
type BuildInfo struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	BuiltAt string `json:"built_at"`
}

// ServerOptions carries service dependencies that tests and production wiring can replace.
type ServerOptions struct {
	Auth       *auth.Service
	Activation *activation.Service
}

type sendSMSRequest struct {
	Phone   string `json:"phone"`
	Purpose string `json:"purpose"`
}

type smsLoginRequest struct {
	Phone   string `json:"phone"`
	Purpose string `json:"purpose"`
	Code    string `json:"code"`
}

type activationRedeemRequest struct {
	ActivationCode string `json:"activationCode"`
	DeviceSummary  string `json:"deviceSummary"`
}

// NewServer returns the HTTP interface for activation, payment, and health routes.
func NewServer(cfg config.Config, build BuildInfo) http.Handler {
	return NewServerWithOptions(cfg, build, ServerOptions{
		Auth:       buildDefaultAuthService(cfg),
		Activation: buildDefaultActivationService(cfg),
	})
}

// NewServerWithOptions returns the HTTP interface with explicit dependencies for tests.
func NewServerWithOptions(cfg config.Config, build BuildInfo, options ServerOptions) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"env":    cfg.AppEnv,
			"time":   time.Now().UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		// Phase 0 has no live database handle yet; readiness exposes config shape only.
		writeJSON(w, http.StatusOK, map[string]any{
			"status":              "ok",
			"database_configured": cfg.DatabaseURL != "",
			"newapi_configured":   cfg.NewAPIAdminBaseURL != "" && cfg.NewAPIAdminToken != "",
		})
	})
	mux.HandleFunc("GET /v1/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, build)
	})
	mux.HandleFunc("POST /v1/auth/sms/send", func(w http.ResponseWriter, r *http.Request) {
		var req sendSMSRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		result, err := options.Auth.SendSMS(r.Context(), req.Phone, req.Purpose)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("POST /v1/auth/sms/login", func(w http.ResponseWriter, r *http.Request) {
		var req smsLoginRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		result, err := options.Auth.Login(r.Context(), req.Phone, req.Purpose, req.Code)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("POST /v1/activation/redeem", func(w http.ResponseWriter, r *http.Request) {
		claims, err := verifyBearer(r, options.Auth)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		var req activationRedeemRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		userID, err := strconv.ParseInt(claims.Subject, 10, 64)
		if err != nil {
			writeError(w, http.StatusUnauthorized, fmt.Errorf("token subject is invalid"))
			return
		}
		result, err := options.Activation.Redeem(r.Context(), activation.RedeemRequest{
			UserID:         userID,
			Phone:          claims.Phone,
			ActivationCode: req.ActivationCode,
			DeviceSummary:  req.DeviceSummary,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	return mux
}

// buildDefaultAuthService creates local auth dependencies until PostgreSQL and Aliyun SMS are wired.
func buildDefaultAuthService(cfg config.Config) *auth.Service {
	secret := cfg.JWTSecret
	if secret == "" {
		secret = developmentJWTSecret
	}
	manager, err := auth.NewTokenManager(secret)
	if err != nil {
		panic(fmt.Sprintf("build token manager: %v", err))
	}
	service, err := auth.NewService(auth.NewMemoryStore(), manager, auth.ServiceConfig{
		TokenTTL:    cfg.AuthTokenTTL,
		DevSMSCode:  cfg.DevSMSCode,
		ExposeCodes: !cfg.IsProduction(),
	})
	if err != nil {
		panic(fmt.Sprintf("build auth service: %v", err))
	}
	return service
}

// buildDefaultActivationService creates the activation redeem dependency for local dev.
func buildDefaultActivationService(cfg config.Config) *activation.Service {
	service, err := activation.NewService(activation.NewMemoryStore(!cfg.IsProduction()), activation.Config{
		AllowAnyCode:  !cfg.IsProduction(),
		NewAPIBaseURL: cfg.NewAPIClientBaseURL,
		PreviewToken:  cfg.NewAPIPreviewToken,
	})
	if err != nil {
		panic(fmt.Sprintf("build activation service: %v", err))
	}
	return service
}

// verifyBearer extracts and validates the U-Claw access token.
func verifyBearer(r *http.Request, service *auth.Service) (auth.TokenClaims, error) {
	if service == nil {
		return auth.TokenClaims{}, fmt.Errorf("auth service is not configured")
	}
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return auth.TokenClaims{}, fmt.Errorf("authorization bearer token is required")
	}
	return service.VerifyAccessToken(strings.TrimSpace(strings.TrimPrefix(header, prefix)))
}

// decodeJSON reads a JSON request body and rejects malformed or absent objects.
func decodeJSON(r *http.Request, out any) error {
	if r.Body == nil {
		return fmt.Errorf("request body is required")
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return fmt.Errorf("decode request json: %w", err)
	}
	return nil
}

// writeJSON writes a small JSON response used by health and readiness endpoints.
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// writeError serializes API errors without leaking internals such as tokens.
func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": err.Error(),
		},
	})
}
