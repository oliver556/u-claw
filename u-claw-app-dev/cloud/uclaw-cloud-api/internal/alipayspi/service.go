package alipayspi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// MethodAggPayMerchantInfoQuery is the first Alipay aggregate-pay SPI required by the console.
	MethodAggPayMerchantInfoQuery = "spi.alipay.pay.aggpay.merchantinfo.query"
)

// Config contains the non-secret merchant facts returned to Alipay SPI checks.
type Config struct {
	MerchantID     string
	MerchantName   string
	MerchantShort  string
	ServicePhone   string
	ServiceAddress string
}

// Service handles Alipay-originated SPI calls for aggregate payment onboarding.
type Service struct {
	cfg Config
	now func() time.Time
}

// NewService builds the SPI handler with safe Bavi-box defaults for console connectivity tests.
func NewService(cfg Config) *Service {
	cfg.MerchantID = withDefault(cfg.MerchantID, "bavi-box")
	cfg.MerchantName = withDefault(cfg.MerchantName, "Bavi-box")
	cfg.MerchantShort = withDefault(cfg.MerchantShort, cfg.MerchantName)
	cfg.ServicePhone = withDefault(cfg.ServicePhone, "4000000000")
	cfg.ServiceAddress = withDefault(cfg.ServiceAddress, "online")
	return &Service{cfg: cfg, now: time.Now}
}

// ServeHTTP accepts both Alipay form posts and JSON posts used by local smoke tests.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		writeSPIError(w, http.StatusMethodNotAllowed, "40004", "Invalid Method")
		return
	}
	req, err := parseRequest(r)
	if err != nil {
		writeSPIError(w, http.StatusBadRequest, "40002", err.Error())
		return
	}
	if req.Method == "" {
		req.Method = MethodAggPayMerchantInfoQuery
	}
	switch req.Method {
	case MethodAggPayMerchantInfoQuery:
		writeSPIResponse(w, s.merchantInfoResponse(req))
	default:
		writeSPIError(w, http.StatusBadRequest, "40004", "Unsupported SPI method")
	}
}

type request struct {
	Method     string
	BizContent map[string]any
	Raw        map[string]string
}

// parseRequest normalizes Alipay's form-encoded gateway payload and direct JSON test payloads.
func parseRequest(r *http.Request) (request, error) {
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.Contains(contentType, "application/json") {
		return parseJSONRequest(r.Body)
	}
	if err := r.ParseForm(); err != nil {
		return request{}, fmt.Errorf("parse form: %w", err)
	}
	raw := map[string]string{}
	for key, values := range r.Form {
		if len(values) > 0 {
			raw[key] = values[0]
		}
	}
	biz := map[string]any{}
	if rawBiz := strings.TrimSpace(raw["biz_content"]); rawBiz != "" {
		if err := json.Unmarshal([]byte(rawBiz), &biz); err != nil {
			return request{}, fmt.Errorf("parse biz_content: %w", err)
		}
	}
	return request{
		Method:     strings.TrimSpace(raw["method"]),
		BizContent: biz,
		Raw:        raw,
	}, nil
}

// parseJSONRequest keeps tests and Alipay debug tools usable without form encoding.
func parseJSONRequest(body io.Reader) (request, error) {
	var payload map[string]any
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(&payload); err != nil {
		return request{}, fmt.Errorf("parse json: %w", err)
	}
	req := request{BizContent: map[string]any{}, Raw: map[string]string{}}
	if method, ok := payload["method"].(string); ok {
		req.Method = strings.TrimSpace(method)
	}
	if biz, ok := payload["biz_content"].(map[string]any); ok {
		req.BizContent = biz
	}
	if biz, ok := payload["bizContent"].(map[string]any); ok {
		req.BizContent = biz
	}
	if len(req.BizContent) == 0 {
		for key, value := range payload {
			if key != "method" && key != "biz_content" && key != "bizContent" {
				req.BizContent[key] = value
			}
		}
	}
	return req, nil
}

// merchantInfoResponse returns enough stable merchant facts for Alipay aggregate-pay onboarding probes.
func (s *Service) merchantInfoResponse(req request) map[string]any {
	outTradeNo := firstString(req.BizContent, "out_trade_no", "outTradeNo", "merchant_order_no", "merchantOrderNo")
	qrCodeID := firstString(req.BizContent, "qr_code_id", "qrCodeId")
	return map[string]any{
		"code":                  "10000",
		"msg":                   "Success",
		"merchant_id":           s.cfg.MerchantID,
		"merchant_name":         s.cfg.MerchantName,
		"merchant_short_name":   s.cfg.MerchantShort,
		"service_phone":         s.cfg.ServicePhone,
		"service_address":       s.cfg.ServiceAddress,
		"out_trade_no":          outTradeNo,
		"qr_code_id":            qrCodeID,
		"query_time":            s.now().UTC().Format(time.RFC3339),
		"support_aggregate_pay": true,
	}
}

// writeSPIResponse follows Alipay SPI's string response envelope; signing can be added after keys are mounted.
func writeSPIResponse(w http.ResponseWriter, response map[string]any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	responseJSON, err := json.Marshal(response)
	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"response": `{"code":"40004","msg":"Business Failed","sub_code":"ENCODE_RESPONSE_FAILED"}`,
		})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"response": string(responseJSON)})
}

// writeSPIError uses Alipay-style code/msg inside the SPI response envelope.
func writeSPIError(w http.ResponseWriter, httpStatus int, code string, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(httpStatus)
	responseJSON, _ := json.Marshal(map[string]any{
		"code": code,
		"msg":  msg,
	})
	_ = json.NewEncoder(w).Encode(map[string]any{
		"response": string(responseJSON),
	})
}

func withDefault(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func firstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
