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
	"uclaw-cloud-api/internal/license"
	"uclaw-cloud-api/internal/newapi"
	"uclaw-cloud-api/internal/provisioning"
	"uclaw-cloud-api/internal/recharge"
	"uclaw-cloud-api/internal/usage"
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
	Usage      *usage.Service
	Recharge   *recharge.Service
}

// PersistentStore is the shared PostgreSQL seam for auth and activation slices.
type PersistentStore interface {
	auth.Store
	activation.Store
	provisioning.Store
	recharge.Store
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

type firstStartActivationRequest struct {
	Username              string `json:"username"`
	ActivationCode        string `json:"activationCode"`
	USBFingerprintSummary string `json:"usbFingerprintSummary"`
	IdempotencyKey        string `json:"idempotencyKey"`
}

type activationCommitRequest struct {
	WriteStatus string `json:"writeStatus"`
}

type rechargeOrderRequest struct {
	PlanCode string `json:"planCode"`
	Provider string `json:"provider"`
}

type virtualPaymentNotifyRequest struct {
	OrderNo         string `json:"orderNo"`
	ProviderEventID string `json:"providerEventId"`
}

// NewServer returns the HTTP interface for activation, payment, and health routes.
func NewServer(cfg config.Config, build BuildInfo) http.Handler {
	return NewServerWithOptions(cfg, build, ServerOptions{
		Auth:       buildAuthService(cfg, nil),
		Activation: buildActivationService(cfg, nil),
		Usage:      buildUsageService(cfg),
		Recharge:   buildRechargeService(cfg, nil),
	})
}

// NewServerWithStore returns the HTTP interface backed by persistent storage.
func NewServerWithStore(cfg config.Config, build BuildInfo, store PersistentStore) http.Handler {
	return NewServerWithOptions(cfg, build, ServerOptions{
		Auth:       buildAuthService(cfg, store),
		Activation: buildActivationService(cfg, store),
		Usage:      buildUsageService(cfg),
		Recharge:   buildRechargeService(cfg, store),
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
			"alipay_configured":   cfg.AlipayConfigured(),
			"wechat_configured":   cfg.WeChatPayConfigured(),
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
	mux.HandleFunc("POST /v1/activations", func(w http.ResponseWriter, r *http.Request) {
		if options.Activation == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("activation service is not configured"))
			return
		}
		var req firstStartActivationRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		result, err := options.Activation.ActivateFirstStart(r.Context(), activation.FirstStartRequest{
			Username:              req.Username,
			ActivationCode:        req.ActivationCode,
			USBFingerprintSummary: req.USBFingerprintSummary,
			IdempotencyKey:        req.IdempotencyKey,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("POST /v1/activations/{activationId}/commit", func(w http.ResponseWriter, r *http.Request) {
		if options.Activation == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("activation service is not configured"))
			return
		}
		var req activationCommitRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		result, err := options.Activation.CommitFirstStart(r.Context(), activation.CommitRequest{
			ActivationID: r.PathValue("activationId"),
			WriteStatus:  req.WriteStatus,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("GET /v1/newapi/usage/summary", func(w http.ResponseWriter, r *http.Request) {
		claims, err := verifyBearer(r, options.Auth)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Usage == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("newapi usage service is not configured"))
			return
		}
		userID, err := strconv.ParseInt(claims.Subject, 10, 64)
		if err != nil {
			writeError(w, http.StatusUnauthorized, fmt.Errorf("token subject is invalid"))
			return
		}
		result, err := options.Usage.GetSummary(r.Context(), usage.SummaryRequest{
			UserID: userID,
			Phone:  claims.Phone,
		})
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("GET /v1/recharge/plans", func(w http.ResponseWriter, r *http.Request) {
		if _, err := verifyBearer(r, options.Auth); err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Recharge == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("recharge service is not configured"))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"plans": options.Recharge.ListPlans(r.Context()),
		})
	})
	mux.HandleFunc("GET /v1/recharge/providers", func(w http.ResponseWriter, r *http.Request) {
		if _, err := verifyBearer(r, options.Auth); err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Recharge == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("recharge service is not configured"))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"providers": options.Recharge.ListProviders(r.Context()),
		})
	})
	mux.HandleFunc("POST /v1/recharge/orders", func(w http.ResponseWriter, r *http.Request) {
		claims, err := verifyBearer(r, options.Auth)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Recharge == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("recharge service is not configured"))
			return
		}
		var req rechargeOrderRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		userID, err := strconv.ParseInt(claims.Subject, 10, 64)
		if err != nil {
			writeError(w, http.StatusUnauthorized, fmt.Errorf("token subject is invalid"))
			return
		}
		result, err := options.Recharge.CreateOrder(r.Context(), recharge.CreateOrderRequest{
			UserID:   userID,
			PlanCode: req.PlanCode,
			Provider: req.Provider,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("GET /v1/recharge/orders", func(w http.ResponseWriter, r *http.Request) {
		claims, err := verifyBearer(r, options.Auth)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Recharge == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("recharge service is not configured"))
			return
		}
		userID, err := strconv.ParseInt(claims.Subject, 10, 64)
		if err != nil {
			writeError(w, http.StatusUnauthorized, fmt.Errorf("token subject is invalid"))
			return
		}
		orders, err := options.Recharge.ListOrders(r.Context(), userID, 20)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"orders": orders})
	})
	mux.HandleFunc("GET /v1/recharge/orders/{orderNo}", func(w http.ResponseWriter, r *http.Request) {
		claims, err := verifyBearer(r, options.Auth)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Recharge == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("recharge service is not configured"))
			return
		}
		userID, err := strconv.ParseInt(claims.Subject, 10, 64)
		if err != nil {
			writeError(w, http.StatusUnauthorized, fmt.Errorf("token subject is invalid"))
			return
		}
		order, err := options.Recharge.GetOrder(r.Context(), r.PathValue("orderNo"), userID)
		if err != nil {
			writeError(w, http.StatusNotFound, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"order": order})
	})
	mux.HandleFunc("POST /v1/payments/virtual/notify", func(w http.ResponseWriter, r *http.Request) {
		if options.Recharge == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("recharge service is not configured"))
			return
		}
		var req virtualPaymentNotifyRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		order, err := options.Recharge.HandleVirtualCallback(r.Context(), recharge.VirtualCallbackRequest{
			OrderNo:         req.OrderNo,
			ProviderEventID: req.ProviderEventID,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"order": order})
	})
	return mux
}

// buildAuthService creates auth dependencies, defaulting to memory storage for local smoke tests.
func buildAuthService(cfg config.Config, store auth.Store) *auth.Service {
	if store == nil {
		store = auth.NewMemoryStore()
	}
	secret := cfg.JWTSecret
	if secret == "" {
		secret = developmentJWTSecret
	}
	manager, err := auth.NewTokenManager(secret)
	if err != nil {
		panic(fmt.Sprintf("build token manager: %v", err))
	}
	service, err := auth.NewService(store, manager, auth.ServiceConfig{
		TokenTTL:    cfg.AuthTokenTTL,
		DevSMSCode:  cfg.DevSMSCode,
		CodePepper:  cfg.SMSCodePepper,
		ExposeCodes: !cfg.IsProduction(),
	})
	if err != nil {
		panic(fmt.Sprintf("build auth service: %v", err))
	}
	return service
}

// buildActivationService creates activation dependencies, using memory only outside production.
func buildActivationService(cfg config.Config, store activation.Store) *activation.Service {
	if store == nil {
		store = activation.NewMemoryStore(!cfg.IsProduction())
	}
	var provisioner activation.NewAPIProvisioner
	if persistentStore, ok := store.(provisioning.Store); ok && cfg.NewAPIAdminBaseURL != "" && cfg.NewAPIAdminToken != "" {
		admin, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, &http.Client{Timeout: cfg.NewAPIHTTPTimeout})
		if err != nil {
			panic(fmt.Sprintf("build newapi admin client: %v", err))
		}
		provisioner, err = provisioning.NewService(admin, persistentStore, provisioning.Config{
			ClientBaseURL:  cfg.NewAPIClientBaseURL,
			TokenName:      cfg.NewAPITokenName,
			InitialQuota:   cfg.NewAPIActivationQuota,
			PasswordSecret: cfg.NewAPIUserPasswordSecret,
		})
		if err != nil {
			panic(fmt.Sprintf("build newapi provisioner: %v", err))
		}
	}
	licenseSigner := license.NewDevelopmentSigner()
	if cfg.LicenseSigningSeedHex != "" {
		signer, err := license.NewEd25519SignerFromSeedHex(cfg.LicenseSigningKeyID, cfg.LicenseSigningSeedHex, 0)
		if err != nil {
			panic(fmt.Sprintf("build license signer: %v", err))
		}
		licenseSigner = signer
	}
	service, err := activation.NewService(store, activation.Config{
		AllowAnyCode:  !cfg.IsProduction(),
		NewAPIBaseURL: cfg.NewAPIClientBaseURL,
		PreviewToken:  cfg.NewAPIPreviewToken,
		Provisioner:   provisioner,
		LicenseSigner: licenseSigner,
	})
	if err != nil {
		panic(fmt.Sprintf("build activation service: %v", err))
	}
	return service
}

// buildUsageService creates the New API read-side service when admin access is configured.
func buildUsageService(cfg config.Config) *usage.Service {
	if cfg.NewAPIAdminBaseURL == "" || cfg.NewAPIAdminToken == "" {
		return nil
	}
	admin, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, &http.Client{Timeout: cfg.NewAPIHTTPTimeout})
	if err != nil {
		panic(fmt.Sprintf("build newapi usage client: %v", err))
	}
	service, err := usage.NewService(admin, usage.Config{
		PasswordSecret: cfg.NewAPIUserPasswordSecret,
	})
	if err != nil {
		panic(fmt.Sprintf("build usage service: %v", err))
	}
	return service
}

// buildRechargeService creates the order and virtual-callback service for local payment validation.
func buildRechargeService(cfg config.Config, store recharge.Store) *recharge.Service {
	if store == nil {
		store = recharge.NewMemoryStore()
	}
	var quota recharge.QuotaClient
	if cfg.NewAPIAdminBaseURL != "" && cfg.NewAPIAdminToken != "" {
		admin, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, &http.Client{Timeout: cfg.NewAPIHTTPTimeout})
		if err != nil {
			panic(fmt.Sprintf("build newapi recharge client: %v", err))
		}
		quota = admin
	}
	service, err := recharge.NewService(store, quota, recharge.Config{
		AllowVirtualCallback: !cfg.IsProduction(),
	})
	if err != nil {
		panic(fmt.Sprintf("build recharge service: %v", err))
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
