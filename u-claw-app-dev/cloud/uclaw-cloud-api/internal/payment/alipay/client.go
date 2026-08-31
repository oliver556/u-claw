package alipay

import (
	"context"
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
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"uclaw-cloud-api/internal/recharge"
)

const (
	defaultGatewayURL = "https://openapi.alipay.com/gateway.do"
	defaultSignType   = "RSA2"
)

// Config contains Alipay OpenAPI credentials and runtime endpoints.
type Config struct {
	AppID              string
	GatewayURL         string
	NotifyURL          string
	SignType           string
	SellerID           string
	PrivateKeyPath     string
	PublicKeyPath      string
	PublicCertPath     string
	PrivateKey         *rsa.PrivateKey
	PublicKey          *rsa.PublicKey
	HTTPClient         *http.Client
	SkipResponseVerify bool
}

// Client implements recharge.CheckoutClient for Alipay scan-code payments.
type Client struct {
	cfg        Config
	privateKey *rsa.PrivateKey
	publicKey  *rsa.PublicKey
	httpClient *http.Client
	now        func() time.Time
}

// NewClient builds an Alipay client and loads keys when file paths are configured.
func NewClient(cfg Config) *Client {
	gateway := strings.TrimSpace(cfg.GatewayURL)
	if gateway == "" {
		gateway = defaultGatewayURL
	}
	signType := strings.TrimSpace(cfg.SignType)
	if signType == "" {
		signType = defaultSignType
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	client := &Client{
		cfg: Config{
			AppID:              strings.TrimSpace(cfg.AppID),
			GatewayURL:         gateway,
			NotifyURL:          strings.TrimSpace(cfg.NotifyURL),
			SignType:           signType,
			SellerID:           strings.TrimSpace(cfg.SellerID),
			PrivateKeyPath:     strings.TrimSpace(cfg.PrivateKeyPath),
			PublicKeyPath:      strings.TrimSpace(cfg.PublicKeyPath),
			PublicCertPath:     strings.TrimSpace(cfg.PublicCertPath),
			SkipResponseVerify: cfg.SkipResponseVerify,
		},
		privateKey: cfg.PrivateKey,
		publicKey:  cfg.PublicKey,
		httpClient: httpClient,
		now:        time.Now,
	}
	return client
}

// LoadKeys reads configured key files so deployment secrets stay outside Git.
func (c *Client) LoadKeys() error {
	if c.privateKey == nil && c.cfg.PrivateKeyPath != "" {
		key, err := loadPrivateKey(c.cfg.PrivateKeyPath)
		if err != nil {
			return err
		}
		c.privateKey = key
	}
	if c.publicKey == nil && c.cfg.PublicKeyPath != "" {
		key, err := loadPublicKey(c.cfg.PublicKeyPath)
		if err != nil {
			return err
		}
		c.publicKey = key
	}
	if c.publicKey == nil && c.cfg.PublicCertPath != "" {
		key, err := loadPublicKeyFromCert(c.cfg.PublicCertPath)
		if err != nil {
			return err
		}
		c.publicKey = key
	}
	return nil
}

// CreateCheckout creates an Alipay precreate order and returns the QR code payload URL.
func (c *Client) CreateCheckout(ctx context.Context, req recharge.CheckoutRequest) (recharge.CheckoutResult, error) {
	if err := c.LoadKeys(); err != nil {
		return recharge.CheckoutResult{}, err
	}
	if c.cfg.AppID == "" {
		return recharge.CheckoutResult{}, fmt.Errorf("alipay app id is required")
	}
	if c.privateKey == nil {
		return recharge.CheckoutResult{}, fmt.Errorf("alipay private key is required")
	}
	if strings.TrimSpace(req.OrderNo) == "" {
		return recharge.CheckoutResult{}, fmt.Errorf("alipay order no is required")
	}
	bizContent, err := json.Marshal(map[string]string{
		"out_trade_no":    req.OrderNo,
		"total_amount":    formatAmountCents(req.AmountCents),
		"subject":         nonEmpty(req.Name, "Bavi-box 充值"),
		"timeout_express": "5m",
	})
	if err != nil {
		return recharge.CheckoutResult{}, fmt.Errorf("marshal alipay biz_content: %w", err)
	}
	params := c.baseParams("alipay.trade.precreate")
	params["biz_content"] = string(bizContent)
	sign, err := SignForm(params, c.privateKey)
	if err != nil {
		return recharge.CheckoutResult{}, err
	}
	params["sign"] = sign

	form := make(url.Values, len(params))
	for key, value := range params {
		form.Set(key, value)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.GatewayURL, strings.NewReader(form.Encode()))
	if err != nil {
		return recharge.CheckoutResult{}, fmt.Errorf("build alipay request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
	httpReq.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return recharge.CheckoutResult{}, fmt.Errorf("send alipay precreate: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return recharge.CheckoutResult{}, fmt.Errorf("read alipay precreate response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return recharge.CheckoutResult{}, fmt.Errorf("alipay precreate returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload precreateEnvelope
	if err := json.Unmarshal(body, &payload); err != nil {
		return recharge.CheckoutResult{}, fmt.Errorf("decode alipay precreate response: %w", err)
	}
	if payload.Response.Code != "10000" {
		return recharge.CheckoutResult{}, fmt.Errorf("alipay precreate failed: %s %s", payload.Response.Code, payload.Response.SubMsg)
	}
	if payload.Response.QRCode == "" {
		return recharge.CheckoutResult{}, fmt.Errorf("alipay precreate response missing qr_code")
	}
	if !c.cfg.SkipResponseVerify && c.publicKey != nil && payload.Sign != "" {
		signContent, err := extractRawJSONField(body, "alipay_trade_precreate_response")
		if err != nil {
			return recharge.CheckoutResult{}, fmt.Errorf("extract alipay precreate response for verify: %w", err)
		}
		if err := c.verify([]byte(signContent), payload.Sign); err != nil {
			return recharge.CheckoutResult{}, fmt.Errorf("verify alipay precreate response: %w", err)
		}
	}
	return recharge.CheckoutResult{QRCodeURL: payload.Response.QRCode}, nil
}

// ParseAndVerifyNotify validates one Alipay async notify form and returns normalized payment facts.
func (c *Client) ParseAndVerifyNotify(form url.Values) (recharge.PaymentCallbackRequest, error) {
	if err := c.LoadKeys(); err != nil {
		return recharge.PaymentCallbackRequest{}, err
	}
	if c.publicKey == nil {
		return recharge.PaymentCallbackRequest{}, fmt.Errorf("alipay public key is required")
	}
	if appID := strings.TrimSpace(form.Get("app_id")); c.cfg.AppID != "" && appID != c.cfg.AppID {
		return recharge.PaymentCallbackRequest{}, fmt.Errorf("alipay app_id mismatch")
	}
	if err := c.verify([]byte(canonicalSignContent(valuesToMap(form))), form.Get("sign")); err != nil {
		return recharge.PaymentCallbackRequest{}, err
	}
	amountCents, err := parseAmountCents(form.Get("total_amount"))
	if err != nil {
		return recharge.PaymentCallbackRequest{}, err
	}
	status := strings.TrimSpace(form.Get("trade_status"))
	paid := status == "TRADE_SUCCESS" || status == "TRADE_FINISHED"
	paidAt := parseAlipayTime(form.Get("gmt_payment"))
	if paidAt.IsZero() {
		paidAt = time.Now()
	}
	return recharge.PaymentCallbackRequest{
		Provider:         recharge.ProviderAlipay,
		OrderNo:          strings.TrimSpace(form.Get("out_trade_no")),
		ProviderEventID:  firstNonEmpty(form.Get("trade_no"), form.Get("notify_id")),
		ProviderTradeNo:  strings.TrimSpace(form.Get("trade_no")),
		AmountCents:      amountCents,
		Paid:             paid,
		PaidAt:           paidAt,
		SignatureValid:   true,
		PayloadRedacted:  redactNotifyPayload(form),
		ProviderStatus:   status,
		ProviderSellerID: strings.TrimSpace(form.Get("seller_id")),
	}, nil
}

// SignForm signs OpenAPI or notify form values using RSA2.
func SignForm(params map[string]string, key *rsa.PrivateKey) (string, error) {
	if key == nil {
		return "", fmt.Errorf("alipay private key is required")
	}
	sum := sha256.Sum256([]byte(canonicalSignContent(params)))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("sign alipay request: %w", err)
	}
	return base64.StdEncoding.EncodeToString(signature), nil
}

// baseParams creates common Alipay OpenAPI request fields.
func (c *Client) baseParams(method string) map[string]string {
	params := map[string]string{
		"app_id":    c.cfg.AppID,
		"method":    method,
		"format":    "JSON",
		"charset":   "utf-8",
		"sign_type": c.cfg.SignType,
		"timestamp": c.now().Format("2006-01-02 15:04:05"),
		"version":   "1.0",
	}
	if c.cfg.NotifyURL != "" {
		params["notify_url"] = c.cfg.NotifyURL
	}
	return params
}

// verify checks one RSA2 signature against the configured Alipay public key.
func (c *Client) verify(content []byte, signature string) error {
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return fmt.Errorf("alipay signature is empty")
	}
	decoded, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return fmt.Errorf("decode alipay signature: %w", err)
	}
	sum := sha256.Sum256(content)
	if err := rsa.VerifyPKCS1v15(c.publicKey, crypto.SHA256, sum[:], decoded); err != nil {
		return fmt.Errorf("verify alipay signature: %w", err)
	}
	return nil
}

// canonicalSignContent formats sorted key-value pairs for Alipay RSA2 signing.
func canonicalSignContent(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for key, value := range params {
		if key == "sign" || key == "sign_type" || strings.TrimSpace(value) == "" {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+params[key])
	}
	return strings.Join(parts, "&")
}

// valuesToMap converts single-value form data into signing input.
func valuesToMap(values url.Values) map[string]string {
	out := make(map[string]string, len(values))
	for key, value := range values {
		if len(value) > 0 {
			out[key] = value[0]
		}
	}
	return out
}

// extractRawJSONField returns the exact JSON value used by Alipay response signing.
func extractRawJSONField(body []byte, field string) (string, error) {
	needle, err := json.Marshal(field)
	if err != nil {
		return "", err
	}
	index := strings.Index(string(body), string(needle))
	if index < 0 {
		return "", fmt.Errorf("field %s not found", field)
	}
	cursor := index + len(needle)
	for cursor < len(body) && (body[cursor] == ' ' || body[cursor] == '\n' || body[cursor] == '\r' || body[cursor] == '\t') {
		cursor++
	}
	if cursor >= len(body) || body[cursor] != ':' {
		return "", fmt.Errorf("field %s missing separator", field)
	}
	cursor++
	for cursor < len(body) && (body[cursor] == ' ' || body[cursor] == '\n' || body[cursor] == '\r' || body[cursor] == '\t') {
		cursor++
	}
	if cursor >= len(body) || body[cursor] != '{' {
		return "", fmt.Errorf("field %s is not an object", field)
	}
	start := cursor
	depth := 0
	inString := false
	escaped := false
	for cursor < len(body) {
		ch := body[cursor]
		if inString {
			if escaped {
				escaped = false
			} else if ch == '\\' {
				escaped = true
			} else if ch == '"' {
				inString = false
			}
			cursor++
			continue
		}
		switch ch {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return string(body[start : cursor+1]), nil
			}
		}
		cursor++
	}
	return "", fmt.Errorf("field %s object is incomplete", field)
}

// parseAmountCents parses Alipay decimal CNY strings into integer cents.
func parseAmountCents(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, fmt.Errorf("alipay total_amount is required")
	}
	whole, frac, ok := strings.Cut(raw, ".")
	if !ok {
		frac = ""
	}
	if whole == "" {
		whole = "0"
	}
	if len(frac) > 2 {
		return 0, fmt.Errorf("alipay total_amount has more than two decimal places")
	}
	for len(frac) < 2 {
		frac += "0"
	}
	var cents int64
	for _, ch := range whole + frac {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("invalid alipay total_amount %q", raw)
		}
		cents = cents*10 + int64(ch-'0')
	}
	return cents, nil
}

// formatAmountCents renders integer cents as Alipay decimal CNY text.
func formatAmountCents(cents int64) string {
	if cents < 0 {
		cents = 0
	}
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}

// parseAlipayTime parses Alipay local-time timestamps.
func parseAlipayTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	parsed, err := time.ParseInLocation("2006-01-02 15:04:05", raw, time.Local)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

// redactNotifyPayload keeps audit-safe notify facts without storing user identifiers unnecessarily.
func redactNotifyPayload(form url.Values) string {
	allowed := map[string]string{}
	for _, key := range []string{"app_id", "out_trade_no", "trade_no", "total_amount", "trade_status", "seller_id", "notify_id", "gmt_payment"} {
		if value := strings.TrimSpace(form.Get(key)); value != "" {
			allowed[key] = value
		}
	}
	data, err := json.Marshal(allowed)
	if err != nil {
		return `{}`
	}
	return string(data)
}

// loadPrivateKey accepts PEM files and Alipay Key Tool raw Base64 key exports.
func loadPrivateKey(path string) (*rsa.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read alipay private key: %w", err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		decoded, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(string(data)), ""))
		if err != nil {
			return nil, fmt.Errorf("decode raw alipay private key: %w", err)
		}
		data = decoded
	} else {
		data = block.Bytes
	}
	parsed, err := x509.ParsePKCS8PrivateKey(data)
	if err != nil {
		if key, pkcs1Err := x509.ParsePKCS1PrivateKey(data); pkcs1Err == nil {
			return key, nil
		}
		return nil, fmt.Errorf("parse alipay private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("alipay private key is not rsa")
	}
	return key, nil
}

// loadPublicKey accepts PEM files and Alipay Key Tool raw Base64 public key exports.
func loadPublicKey(path string) (*rsa.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read alipay public key: %w", err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		decoded, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(string(data)), ""))
		if err != nil {
			return nil, fmt.Errorf("decode raw alipay public key: %w", err)
		}
		data = decoded
	} else {
		data = block.Bytes
	}
	parsed, err := x509.ParsePKIXPublicKey(data)
	if err != nil {
		return nil, fmt.Errorf("parse alipay public key: %w", err)
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("alipay public key is not rsa")
	}
	return key, nil
}

// loadPublicKeyFromCert reads an Alipay public certificate and extracts its RSA public key.
func loadPublicKeyFromCert(path string) (*rsa.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read alipay public cert: %w", err)
	}
	block, _ := pem.Decode(data)
	if block != nil {
		data = block.Bytes
	}
	cert, err := x509.ParseCertificate(data)
	if err != nil {
		return nil, fmt.Errorf("parse alipay public cert: %w", err)
	}
	key, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("alipay public cert key is not rsa")
	}
	return key, nil
}

// nonEmpty returns fallback when value is blank.
func nonEmpty(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

// firstNonEmpty returns the first non-blank value.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

type precreateEnvelope struct {
	Response precreateResponse `json:"alipay_trade_precreate_response"`
	Sign     string            `json:"sign"`
}

type precreateResponse struct {
	Code       string `json:"code"`
	Msg        string `json:"msg"`
	SubCode    string `json:"sub_code,omitempty"`
	SubMsg     string `json:"sub_msg,omitempty"`
	OutTradeNo string `json:"out_trade_no"`
	QRCode     string `json:"qr_code"`
}
