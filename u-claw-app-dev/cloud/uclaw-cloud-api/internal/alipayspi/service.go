package alipayspi

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	// MethodAggPayMerchantInfoQuery is the first Alipay aggregate-pay SPI required by the console.
	MethodAggPayMerchantInfoQuery = "spi.alipay.pay.aggpay.merchantinfo.query"
	// MethodAggrePayMerchantInfoQuery is the method name Alipay currently posts from the online SPI tester.
	MethodAggrePayMerchantInfoQuery = "spi.alipay.pay.aggrepay.merchantinfo.query"
	// MethodStandardAggrePayOrderCreate creates a standardized aggregate-pay bill for Alipay SPI onboarding.
	MethodStandardAggrePayOrderCreate = "spi.alipay.pay.standardaggrepay.order.create"
	// MethodStandardAggPayOrderCreate is kept for console variants that omit "re" in aggregate-pay method names.
	MethodStandardAggPayOrderCreate = "spi.alipay.pay.standardaggpay.order.create"
)

// Config contains the non-secret merchant facts returned to Alipay SPI checks.
type Config struct {
	MerchantID     string
	MerchantName   string
	MerchantShort  string
	ServicePhone   string
	ServiceAddress string
	PrivateKeyPath string
}

// Service handles Alipay-originated SPI calls for aggregate payment onboarding.
type Service struct {
	cfg     Config
	now     func() time.Time
	signer  *rsa.PrivateKey
	signErr error
}

// NewService builds the SPI handler with safe Bavi-box defaults for console connectivity tests.
func NewService(cfg Config) *Service {
	cfg.MerchantID = withDefault(cfg.MerchantID, "bavi-box")
	cfg.MerchantName = withDefault(cfg.MerchantName, "Bavi-box")
	cfg.MerchantShort = withDefault(cfg.MerchantShort, cfg.MerchantName)
	cfg.ServicePhone = withDefault(cfg.ServicePhone, "4000000000")
	cfg.ServiceAddress = withDefault(cfg.ServiceAddress, "online")
	service := &Service{cfg: cfg, now: time.Now}
	if strings.TrimSpace(cfg.PrivateKeyPath) != "" {
		service.signer, service.signErr = loadPrivateKey(cfg.PrivateKeyPath)
	}
	return service
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
	log.Printf("alipay_spi request path=%s http_method=%s content_type=%q spi_method=%q biz_keys=%q sign_enabled=%t sign_error=%t",
		r.URL.Path,
		r.Method,
		r.Header.Get("Content-Type"),
		req.Method,
		strings.Join(sortedKeys(req.BizContent), ","),
		s.signer != nil,
		s.signErr != nil,
	)
	switch req.Method {
	case MethodAggPayMerchantInfoQuery, MethodAggrePayMerchantInfoQuery:
		writeSPIResponse(w, s.merchantInfoResponse(req), s.signer)
	case MethodStandardAggrePayOrderCreate, MethodStandardAggPayOrderCreate:
		writeSPIResponse(w, s.orderCreateResponse(req), s.signer)
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
	if len(biz) == 0 {
		for key, value := range raw {
			if !isSystemField(key) {
				biz[key] = value
			}
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

// orderCreateResponse returns a non-settling aggregate-pay bill for Alipay onboarding probes.
func (s *Service) orderCreateResponse(req request) map[string]any {
	now := s.now().UTC()
	qrCodeID := firstString(req.BizContent, "qr_code_id", "qrCodeId")
	outTradeNo := firstString(req.BizContent, "out_trade_no", "outTradeNo", "out_order_no", "outOrderNo", "merchant_order_no", "merchantOrderNo")
	if outTradeNo == "" {
		outTradeNo = "UCLAW-SPI-" + now.Format("20060102150405")
	}
	totalAmount := firstString(req.BizContent, "total_amount", "totalAmount", "amount", "order_amount", "orderAmount")
	if totalAmount == "" {
		totalAmount = "0.01"
	}
	subject := firstString(req.BizContent, "subject", "order_title", "orderTitle", "goods_name", "goodsName")
	if subject == "" {
		subject = s.cfg.MerchantShort + " 聚合收钱单"
	}
	return map[string]any{
		"code":                  "10000",
		"msg":                   "Success",
		"merchant_id":           s.cfg.MerchantID,
		"merchant_name":         s.cfg.MerchantName,
		"out_trade_no":          outTradeNo,
		"order_no":              outTradeNo,
		"aggregate_order_no":    outTradeNo,
		"qr_code_id":            qrCodeID,
		"subject":               subject,
		"total_amount":          totalAmount,
		"currency":              "CNY",
		"order_status":          "WAIT_BUYER_PAY",
		"trade_status":          "WAIT_BUYER_PAY",
		"create_time":           now.Format("2006-01-02 15:04:05"),
		"expire_time":           now.Add(30 * time.Minute).Format("2006-01-02 15:04:05"),
		"support_aggregate_pay": true,
	}
}

// writeSPIResponse follows Alipay SPI's signed JSON response envelope.
func writeSPIResponse(w http.ResponseWriter, response map[string]any, signer *rsa.PrivateKey) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	responseJSON, err := json.Marshal(response)
	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"response": map[string]any{"code": "40004", "msg": "Business Failed", "sub_code": "ENCODE_RESPONSE_FAILED"},
		})
		return
	}
	envelope := map[string]any{"response": json.RawMessage(responseJSON)}
	if signer != nil {
		if sign, err := signRSA2(responseJSON, signer); err == nil {
			envelope["sign"] = sign
		}
	}
	_ = json.NewEncoder(w).Encode(envelope)
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
		"response": json.RawMessage(responseJSON),
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

// isSystemField excludes Alipay gateway fields from direct form business payload fallback.
func isSystemField(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "method", "charset", "version", "biz_app_id", "invoke_app_id", "utc_timestamp", "sign_type", "sign", "app_id", "auth_token":
		return true
	default:
		return false
	}
}

// loadPrivateKey accepts either PKCS#1 or PKCS#8 PEM files generated by Alipay tooling.
func loadPrivateKey(path string) (*rsa.PrivateKey, error) {
	raw, err := os.ReadFile(strings.TrimSpace(path))
	if err != nil {
		return nil, fmt.Errorf("read alipay private key: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("decode alipay private key pem")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse alipay private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("alipay private key is not rsa")
	}
	return key, nil
}

// signRSA2 produces Alipay-compatible SHA256withRSA signatures for SPI response bodies.
func signRSA2(content []byte, key *rsa.PrivateKey) (string, error) {
	sum := sha256.Sum256(content)
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(signature), nil
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
