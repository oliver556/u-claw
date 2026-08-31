package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"uclaw-cloud-api/internal/activation"
	"uclaw-cloud-api/internal/admin"
	"uclaw-cloud-api/internal/alipayspi"
	"uclaw-cloud-api/internal/auth"
	"uclaw-cloud-api/internal/config"
	"uclaw-cloud-api/internal/license"
	"uclaw-cloud-api/internal/modelcatalog"
	"uclaw-cloud-api/internal/newapi"
	alipaypay "uclaw-cloud-api/internal/payment/alipay"
	"uclaw-cloud-api/internal/provisioning"
	"uclaw-cloud-api/internal/recharge"
	smsprovider "uclaw-cloud-api/internal/sms"
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
	Admin      *admin.Service
	Usage      *usage.Service
	Catalog    *modelcatalog.Service
	Recharge   *recharge.Service
	AlipayPay  *alipaypay.Client
	AlipaySPI  *alipayspi.Service
}

// PersistentStore is the shared PostgreSQL seam for auth and activation slices.
type PersistentStore interface {
	auth.Store
	activation.Store
	admin.Store
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
	Phone                 string `json:"phone"`
	SMSCode               string `json:"smsCode"`
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

type adminGenerateActivationCodesRequest struct {
	Count     int    `json:"count"`
	BatchName string `json:"batchName"`
	Note      string `json:"note"`
	CreatedBy string `json:"createdBy"`
}

type adminDisableActivationCodeRequest struct {
	Reason string `json:"reason"`
}

type adminAuthRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// NewServer returns the HTTP interface for activation, payment, and health routes.
func NewServer(cfg config.Config, build BuildInfo) http.Handler {
	alipayPay := buildAlipayPaymentService(cfg)
	return NewServerWithOptions(cfg, build, ServerOptions{
		Auth:       buildAuthService(cfg, nil),
		Activation: buildActivationService(cfg, nil),
		Admin:      buildAdminService(cfg, nil),
		Usage:      buildUsageService(cfg),
		Catalog:    buildModelCatalogService(cfg),
		Recharge:   buildRechargeService(cfg, nil, alipayPay),
		AlipayPay:  alipayPay,
		AlipaySPI:  buildAlipaySPIService(cfg),
	})
}

// NewServerWithStore returns the HTTP interface backed by persistent storage.
func NewServerWithStore(cfg config.Config, build BuildInfo, store PersistentStore) http.Handler {
	alipayPay := buildAlipayPaymentService(cfg)
	return NewServerWithOptions(cfg, build, ServerOptions{
		Auth:       buildAuthService(cfg, store),
		Activation: buildActivationService(cfg, store),
		Admin:      buildAdminService(cfg, store),
		Usage:      buildUsageService(cfg),
		Catalog:    buildModelCatalogService(cfg),
		Recharge:   buildRechargeService(cfg, store, alipayPay),
		AlipayPay:  alipayPay,
		AlipaySPI:  buildAlipaySPIService(cfg),
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
			"status":                    "ok",
			"database_configured":       cfg.DatabaseURL != "",
			"newapi_configured":         cfg.NewAPIAdminBaseURL != "" && cfg.NewAPIAdminToken != "",
			"newapi_catalog_configured": options.Catalog != nil,
			"alipay_configured":         cfg.AlipayConfigured(),
			"wechat_configured":         cfg.WeChatPayConfigured(),
		})
	})
	mux.HandleFunc("GET /v1/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, build)
	})
	mux.HandleFunc("GET /admin", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(adminConsoleHTML))
	})
	mux.HandleFunc("GET /internal/admin/v1/auth/setup", func(w http.ResponseWriter, r *http.Request) {
		if options.Admin == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("admin service is not configured"))
			return
		}
		status, err := options.Admin.SetupStatus(r.Context())
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, status)
	})
	mux.HandleFunc("POST /internal/admin/v1/auth/register", func(w http.ResponseWriter, r *http.Request) {
		if options.Admin == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("admin service is not configured"))
			return
		}
		if err := verifyAdminBootstrap(r, cfg); err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		var req adminAuthRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		result, err := options.Admin.Register(r.Context(), req.Username, req.Password)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusCreated, result)
	})
	mux.HandleFunc("POST /internal/admin/v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if options.Admin == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("admin service is not configured"))
			return
		}
		var req adminAuthRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		result, err := options.Admin.Login(r.Context(), req.Username, req.Password)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("GET /internal/admin/v1/activation-codes", func(w http.ResponseWriter, r *http.Request) {
		if err := verifyAdmin(r, cfg, options.Admin); err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Admin == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("admin service is not configured"))
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		codes, err := options.Admin.ListActivationCodes(r.Context(), admin.ActivationCodeFilter{
			Status: r.URL.Query().Get("status"),
			Limit:  limit,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"codes": codes})
	})
	mux.HandleFunc("POST /internal/admin/v1/activation-codes/generate", func(w http.ResponseWriter, r *http.Request) {
		if err := verifyAdmin(r, cfg, options.Admin); err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Admin == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("admin service is not configured"))
			return
		}
		var req adminGenerateActivationCodesRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		codes, err := options.Admin.GenerateActivationCodes(r.Context(), admin.GenerateRequest{
			Count:     req.Count,
			BatchName: req.BatchName,
			Note:      req.Note,
			CreatedBy: req.CreatedBy,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"codes": codes})
	})
	mux.HandleFunc("GET /internal/admin/v1/activation-codes/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := verifyAdmin(r, cfg, options.Admin); err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Admin == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("admin service is not configured"))
			return
		}
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, fmt.Errorf("activation code id is invalid"))
			return
		}
		code, err := options.Admin.GetActivationCode(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusNotFound, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"code": code})
	})
	mux.HandleFunc("POST /internal/admin/v1/activation-codes/{id}/disable", func(w http.ResponseWriter, r *http.Request) {
		if err := verifyAdmin(r, cfg, options.Admin); err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Admin == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("admin service is not configured"))
			return
		}
		var req adminDisableActivationCodeRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, fmt.Errorf("activation code id is invalid"))
			return
		}
		if err := options.Admin.DisableActivationCode(r.Context(), id, req.Reason); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("POST /internal/admin/v1/activation-codes/{id}/reissue", func(w http.ResponseWriter, r *http.Request) {
		if err := verifyAdmin(r, cfg, options.Admin); err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Admin == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("admin service is not configured"))
			return
		}
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, fmt.Errorf("activation code id is invalid"))
			return
		}
		code, err := options.Admin.ReissueActivationCode(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"code": code})
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
		var userID int64
		var accessToken string
		if strings.TrimSpace(req.Phone) != "" || strings.TrimSpace(req.SMSCode) != "" {
			login, err := options.Auth.Login(r.Context(), req.Phone, "login", req.SMSCode)
			if err != nil {
				writeError(w, http.StatusUnauthorized, err)
				return
			}
			userID = login.User.ID
			accessToken = login.AccessToken
		}
		result, err := options.Activation.ActivateFirstStart(r.Context(), activation.FirstStartRequest{
			Username:              req.Username,
			Phone:                 req.Phone,
			UserID:                userID,
			ActivationCode:        req.ActivationCode,
			USBFingerprintSummary: req.USBFingerprintSummary,
			IdempotencyKey:        req.IdempotencyKey,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		result.AccessToken = accessToken
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
	mux.HandleFunc("GET /v1/newapi/models/catalog", func(w http.ResponseWriter, r *http.Request) {
		claims, err := verifyBearer(r, options.Auth)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err)
			return
		}
		if options.Catalog == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("newapi model catalog service is not configured"))
			return
		}
		userID, err := strconv.ParseInt(claims.Subject, 10, 64)
		if err != nil {
			writeError(w, http.StatusUnauthorized, fmt.Errorf("token subject is invalid"))
			return
		}
		result, err := options.Catalog.GetCatalog(r.Context(), modelcatalog.Request{
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
	mux.HandleFunc("POST /v1/payments/alipay/notify", func(w http.ResponseWriter, r *http.Request) {
		if options.Recharge == nil || options.AlipayPay == nil {
			writePlain(w, http.StatusOK, "failure")
			return
		}
		if err := r.ParseForm(); err != nil {
			writePlain(w, http.StatusOK, "failure")
			return
		}
		notify, err := options.AlipayPay.ParseAndVerifyNotify(r.PostForm)
		if err != nil {
			writePlain(w, http.StatusOK, "failure")
			return
		}
		if cfg.AlipaySellerID != "" && notify.ProviderSellerID != "" && notify.ProviderSellerID != cfg.AlipaySellerID {
			writePlain(w, http.StatusOK, "failure")
			return
		}
		if _, err := options.Recharge.HandleProviderPayment(r.Context(), notify); err != nil {
			writePlain(w, http.StatusOK, "failure")
			return
		}
		writePlain(w, http.StatusOK, "success")
	})
	mux.HandleFunc("/v1/payments/alipay/spi", func(w http.ResponseWriter, r *http.Request) {
		if options.AlipaySPI == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("alipay spi service is not configured"))
			return
		}
		options.AlipaySPI.ServeHTTP(w, r)
	})
	mux.HandleFunc("/v1/payments/alipay/spi/merchantinfo/query", func(w http.ResponseWriter, r *http.Request) {
		if options.AlipaySPI == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("alipay spi service is not configured"))
			return
		}
		options.AlipaySPI.ServeHTTP(w, r)
	})
	mux.HandleFunc("/isv/spi/service", func(w http.ResponseWriter, r *http.Request) {
		if options.AlipaySPI == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("alipay spi service is not configured"))
			return
		}
		options.AlipaySPI.ServeHTTP(w, r)
	})
	mux.HandleFunc("/isv/spi/service/", func(w http.ResponseWriter, r *http.Request) {
		if options.AlipaySPI == nil {
			writeError(w, http.StatusServiceUnavailable, fmt.Errorf("alipay spi service is not configured"))
			return
		}
		options.AlipaySPI.ServeHTTP(w, r)
	})
	return mux
}

// buildAlipaySPIService creates Alipay-originated SPI endpoints for aggregate-pay onboarding.
func buildAlipaySPIService(cfg config.Config) *alipayspi.Service {
	privateKeyPath := cfg.AlipaySPIPrivateKeyPath
	if privateKeyPath == "" {
		privateKeyPath = cfg.AlipayPrivateKeyPath
	}
	return alipayspi.NewService(alipayspi.Config{
		MerchantID:     cfg.AlipaySPIMerchantID,
		MerchantName:   cfg.AlipaySPIMerchantName,
		MerchantShort:  cfg.AlipaySPIMerchantShort,
		ServicePhone:   cfg.AlipaySPIServicePhone,
		ServiceAddress: cfg.AlipaySPIServiceAddress,
		PrivateKeyPath: privateKeyPath,
		AESKey:         cfg.AlipaySPIAESKey,
	})
}

// buildAlipayPaymentService creates the official scan-code payment client when keys are configured.
func buildAlipayPaymentService(cfg config.Config) *alipaypay.Client {
	if !cfg.AlipayConfigured() {
		return nil
	}
	return alipaypay.NewClient(alipaypay.Config{
		AppID:          cfg.AlipayAppID,
		GatewayURL:     cfg.AlipayGatewayURL,
		NotifyURL:      cfg.AlipayNotifyURL,
		SignType:       cfg.AlipaySignType,
		SellerID:       cfg.AlipaySellerID,
		PrivateKeyPath: cfg.AlipayPrivateKeyPath,
		PublicKeyPath:  cfg.AlipayPublicKeyPath,
		PublicCertPath: cfg.AlipayPublicCertPath,
		HTTPClient:     &http.Client{Timeout: cfg.AlipayHTTPTimeout},
	})
}

// buildAdminService creates the protected operational admin service.
func buildAdminService(cfg config.Config, store admin.Store) *admin.Service {
	if store == nil {
		store = admin.NewMemoryStore()
	}
	service, err := admin.NewService(store, admin.Config{EncryptionKey: cfg.AdminEncryptionKey})
	if err != nil {
		panic(fmt.Sprintf("build admin service: %v", err))
	}
	return service
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
		TokenTTL:                   cfg.AuthTokenTTL,
		DevSMSCode:                 cfg.DevSMSCode,
		CodePepper:                 cfg.SMSCodePepper,
		ExposeCodes:                !cfg.IsProduction() || strings.EqualFold(cfg.SMSProvider, "fixed"),
		UseDevSMSCode:              !cfg.IsProduction() || strings.EqualFold(cfg.SMSProvider, "fixed"),
		AllowFixedLoginWithoutSend: strings.EqualFold(cfg.SMSProvider, "fixed"),
		Provider:                   buildSMSProvider(cfg),
	})
	if err != nil {
		panic(fmt.Sprintf("build auth service: %v", err))
	}
	return service
}

// buildSMSProvider isolates vendor wiring from login and activation logic.
func buildSMSProvider(cfg config.Config) auth.SMSProvider {
	if strings.EqualFold(cfg.SMSProvider, "aliyun") {
		provider, err := smsprovider.NewAliyunProvider(smsprovider.AliyunProviderConfig{
			AccessKeyID:       cfg.AliyunSMSAccessKeyID,
			AccessKeySecret:   cfg.AliyunSMSAccessKeySecret,
			SignName:          cfg.AliyunSMSSignName,
			TemplateCode:      cfg.AliyunSMSTemplateCode,
			Endpoint:          cfg.AliyunSMSEndpoint,
			TemplateParamName: cfg.AliyunSMSTemplateParam,
			Timeout:           cfg.AliyunSMSHTTPTimeout,
		})
		if err != nil {
			panic(fmt.Sprintf("build aliyun sms provider: %v", err))
		}
		return provider
	}
	if strings.EqualFold(cfg.SMSProvider, "fixed") {
		return auth.DevelopmentSMSProvider{}
	}
	return auth.DevelopmentSMSProvider{}
}

// buildActivationService creates activation dependencies, using memory only outside production.
func buildActivationService(cfg config.Config, store activation.Store) *activation.Service {
	if store == nil {
		store = activation.NewMemoryStore(!cfg.IsProduction())
	}
	var provisioner activation.NewAPIProvisioner
	if persistentStore, ok := store.(provisioning.Store); ok && cfg.NewAPIAdminBaseURL != "" && cfg.NewAPIAdminToken != "" {
		admin, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, &http.Client{Timeout: cfg.NewAPIHTTPTimeout}, newapi.WithAdminCredentials(cfg.NewAPIAdminUsername, cfg.NewAPIAdminPassword))
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
	var updateCredentialIssuer activation.UpdateCredentialIssuer
	if strings.TrimSpace(cfg.UpdateCredentialFile) != "" {
		issuer, err := activation.NewUpdateCredentialFileIssuer(cfg.UpdateCredentialFile)
		if err != nil {
			panic(fmt.Sprintf("build update credential issuer: %v", err))
		}
		updateCredentialIssuer = issuer
	}
	service, err := activation.NewService(store, activation.Config{
		AllowAnyCode:           !cfg.IsProduction(),
		NewAPIBaseURL:          cfg.NewAPIClientBaseURL,
		PreviewToken:           cfg.NewAPIPreviewToken,
		Provisioner:            provisioner,
		LicenseSigner:          licenseSigner,
		UpdateCredentialIssuer: updateCredentialIssuer,
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
	admin, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, &http.Client{Timeout: cfg.NewAPIHTTPTimeout}, newapi.WithAdminCredentials(cfg.NewAPIAdminUsername, cfg.NewAPIAdminPassword))
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

// buildModelCatalogService creates the New API model catalog read-side when admin access is configured.
func buildModelCatalogService(cfg config.Config) *modelcatalog.Service {
	if cfg.NewAPIAdminBaseURL == "" || cfg.NewAPIAdminToken == "" || cfg.NewAPIClientBaseURL == "" {
		return nil
	}
	admin, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, &http.Client{Timeout: cfg.NewAPIHTTPTimeout}, newapi.WithAdminCredentials(cfg.NewAPIAdminUsername, cfg.NewAPIAdminPassword))
	if err != nil {
		panic(fmt.Sprintf("build newapi model catalog client: %v", err))
	}
	service, err := modelcatalog.NewService(admin, modelcatalog.Config{
		PasswordSecret: cfg.NewAPIUserPasswordSecret,
		ClientBaseURL:  cfg.NewAPIClientBaseURL,
	})
	if err != nil {
		panic(fmt.Sprintf("build model catalog service: %v", err))
	}
	return service
}

// buildRechargeService creates recharge orders and wires official checkout adapters.
func buildRechargeService(cfg config.Config, store recharge.Store, alipayPay *alipaypay.Client) *recharge.Service {
	if store == nil {
		store = recharge.NewMemoryStore()
	}
	var quota recharge.QuotaClient
	if cfg.NewAPIAdminBaseURL != "" && cfg.NewAPIAdminToken != "" {
		admin, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, &http.Client{Timeout: cfg.NewAPIHTTPTimeout}, newapi.WithAdminCredentials(cfg.NewAPIAdminUsername, cfg.NewAPIAdminPassword))
		if err != nil {
			panic(fmt.Sprintf("build newapi recharge client: %v", err))
		}
		quota = admin
	}
	checkoutClients := map[string]recharge.CheckoutClient{}
	if alipayPay != nil {
		checkoutClients[recharge.ProviderAlipay] = alipayPay
	}
	service, err := recharge.NewService(store, quota, recharge.Config{
		AllowVirtualCallback: !cfg.IsProduction(),
		CheckoutClients:      checkoutClients,
	})
	if err != nil {
		panic(fmt.Sprintf("build recharge service: %v", err))
	}
	return service
}

// verifyAdmin validates either a session bearer token or the legacy emergency token.
func verifyAdmin(r *http.Request, cfg config.Config, service *admin.Service) error {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return fmt.Errorf("authorization bearer token is required")
	}
	actual := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	expected := strings.TrimSpace(cfg.AdminToken)
	if expected != "" && subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1 {
		return nil
	}
	if service == nil {
		return fmt.Errorf("admin service is not configured")
	}
	if _, err := service.VerifySession(r.Context(), actual); err != nil {
		return err
	}
	return nil
}

// verifyAdminBootstrap requires the legacy admin token before creating the first session when configured.
func verifyAdminBootstrap(r *http.Request, cfg config.Config) error {
	expected := strings.TrimSpace(cfg.AdminToken)
	if expected == "" {
		return nil
	}
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return fmt.Errorf("admin bootstrap token is required")
	}
	actual := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	if subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) != 1 {
		return fmt.Errorf("admin bootstrap token is invalid")
	}
	return nil
}

// verifyBearer extracts and validates the Bavi-box access token.
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

// writePlain writes provider webhook acknowledgements that require exact text bodies.
func writePlain(w http.ResponseWriter, status int, payload string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(payload))
}

// writeError serializes API errors without leaking internals such as tokens.
func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": err.Error(),
		},
	})
}
