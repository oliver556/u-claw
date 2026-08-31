package alipayspi

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMerchantInfoQueryAcceptsFormEncodedAlipayPayload(t *testing.T) {
	service := NewService(Config{
		MerchantID:     "2088123456789012",
		MerchantName:   "Bavi-box",
		MerchantShort:  "Bavi",
		ServicePhone:   "0571-00000000",
		ServiceAddress: "https://license.yiyong.me",
	})
	service.now = func() time.Time { return time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC) }

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/payments/alipay/spi",
		strings.NewReader(`method=spi.alipay.pay.aggpay.merchantinfo.query&biz_content={"out_trade_no":"UC1"}`),
	)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["code"] != "10000" || response["merchant_id"] != "2088123456789012" {
		t.Fatalf("response = %+v", response)
	}
	if response["out_trade_no"] != "UC1" || response["query_time"] != "2026-08-31T10:00:00Z" {
		t.Fatalf("response missing request echo/time: %+v", response)
	}
}

func TestMerchantInfoQueryAcceptsAlipayTesterAggrePayMethodAndDirectFormBusinessFields(t *testing.T) {
	service := NewService(Config{MerchantName: "Bavi-box"})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/isv/spi/service",
		strings.NewReader(`method=spi.alipay.pay.aggrepay.merchantinfo.query&qr_code_id=https%3A%2F%2Fqr.isv.com%2Ftest%2F1&ua=watch`),
	)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["code"] != "10000" || response["qr_code_id"] != "https://qr.isv.com/test/1" {
		t.Fatalf("response = %+v", response)
	}
}

func TestStandardAggrePayMerchantInfoQueryReturnsMerchantEnvelope(t *testing.T) {
	service := NewService(Config{
		MerchantID:     "2088123456789012",
		MerchantName:   "Bavi-box",
		MerchantShort:  "Bavi",
		ServicePhone:   "0571-00000000",
		ServiceAddress: "https://license.yiyong.me",
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/isv/spi/service",
		strings.NewReader(`method=spi.alipay.pay.standardaggrepay.merchantinfo.query&qr_code_id=https%3A%2F%2Fqr.isv.com%2Ftest%2F1&ua=watch`),
	)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["code"] != "10000" || response["merchant_id"] != "2088123456789012" {
		t.Fatalf("response = %+v", response)
	}
	if response["qr_code_id"] != "https://qr.isv.com/test/1" || response["support_aggregate_pay"] != true {
		t.Fatalf("response missing standard merchant facts: %+v", response)
	}
}

func TestMerchantInfoQueryDefaultsToFirstMethodForDedicatedPath(t *testing.T) {
	service := NewService(Config{MerchantName: "Bavi-box"})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments/alipay/spi/merchantinfo/query", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["merchant_name"] != "Bavi-box" || response["code"] != "10000" {
		t.Fatalf("response = %+v", response)
	}
}

func TestMerchantInfoQueryUsesDirectJSONBodyAsBusinessPayload(t *testing.T) {
	service := NewService(Config{MerchantName: "Bavi-box"})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/isv/spi/service",
		strings.NewReader(`{"qr_code_id":"https://qr.isv.com/test/1","ua":"watch"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["qr_code_id"] != "https://qr.isv.com/test/1" {
		t.Fatalf("response = %+v", response)
	}
}

func TestStandardAggrePayOrderCreateReturnsBillEnvelope(t *testing.T) {
	service := NewService(Config{
		MerchantID:    "2088123456789012",
		MerchantName:  "Bavi-box",
		MerchantShort: "Bavi",
	})
	service.now = func() time.Time { return time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC) }

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/isv/spi/service",
		strings.NewReader(`method=spi.alipay.pay.standardaggrepay.order.create&qr_code_id=https%3A%2F%2Fqr.isv.com%2Ftest%2F1&ua=watch`),
	)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["code"] != "10000" || response["out_trade_no"] != "UCLAW-SPI-20260831120000" {
		t.Fatalf("response = %+v", response)
	}
	if response["qr_code_id"] != "https://qr.isv.com/test/1" || response["total_amount"] != "0.01" {
		t.Fatalf("response missing order facts: %+v", response)
	}
	if response["order_status"] != "WAIT_BUYER_PAY" || response["expire_time"] != "2026-08-31 12:30:00" {
		t.Fatalf("response missing status/expiry: %+v", response)
	}
}

func TestAggrePayOrderCreateReturnsBillEnvelope(t *testing.T) {
	service := NewService(Config{
		MerchantID:    "2088123456789012",
		MerchantName:  "Bavi-box",
		MerchantShort: "Bavi",
	})
	service.now = func() time.Time { return time.Date(2026, 8, 31, 12, 5, 0, 0, time.UTC) }

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/isv/spi/service",
		strings.NewReader(`method=spi.alipay.pay.aggrepay.order.create&qr_code_id=https%3A%2F%2Fqr.isv.com%2Ftest%2F1&ua=watch`),
	)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["code"] != "10000" || response["out_trade_no"] != "UCLAW-SPI-20260831120500" {
		t.Fatalf("response = %+v", response)
	}
	if response["qr_code_id"] != "https://qr.isv.com/test/1" || response["trade_status"] != "WAIT_BUYER_PAY" {
		t.Fatalf("response missing aggregate order facts: %+v", response)
	}
}

func TestStandardAggrePayOrderCreateEncryptsResponseWhenAESKeyIsConfigured(t *testing.T) {
	rawAESKey := "MDEyMzQ1Njc4OWFiY2RlZg=="
	service := NewService(Config{
		MerchantName: "Bavi-box",
		AESKey:       rawAESKey,
	})
	service.now = func() time.Time { return time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC) }

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/isv/spi/service",
		strings.NewReader(`method=spi.alipay.pay.standardaggrepay.order.create&qr_code_id=https%3A%2F%2Fqr.isv.com%2Ftest%2F1&ua=watch`),
	)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response    string `json:"response"`
		EncryptType string `json:"encrypt_type"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode encrypted response: %v", err)
	}
	if payload.Response == "" || strings.HasPrefix(payload.Response, "{") || payload.EncryptType != "AES" {
		t.Fatalf("payload is not encrypted: %+v", payload)
	}
	key, err := decodeAESKey(rawAESKey)
	if err != nil {
		t.Fatalf("decode aes key: %v", err)
	}
	plain, err := decryptAESCBCPKCS7(payload.Response, key)
	if err != nil {
		t.Fatalf("decrypt response: %v", err)
	}
	response := decodeResponseString(t, plain)
	if response["code"] != "10000" || response["qr_code_id"] != "https://qr.isv.com/test/1" {
		t.Fatalf("response = %+v", response)
	}
}

func TestMerchantInfoQuerySignsResponseWhenPrivateKeyIsMounted(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}
	service := NewService(Config{MerchantName: "Bavi-box"})
	service.signer = key

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/isv/spi/service",
		strings.NewReader(`{"qr_code_id":"https://qr.isv.com/test/1","ua":"watch"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
		Sign     string          `json:"sign"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Sign == "" {
		t.Fatalf("sign is empty; body = %s", rec.Body.String())
	}
	signature, err := base64.StdEncoding.DecodeString(payload.Sign)
	if err != nil {
		t.Fatalf("decode sign: %v", err)
	}
	sum := sha256.Sum256(payload.Response)
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, sum[:], signature); err != nil {
		t.Fatalf("verify sign: %v", err)
	}
}

func TestMerchantInfoQueryRejectsUnsupportedMethod(t *testing.T) {
	service := NewService(Config{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments/alipay/spi", strings.NewReader(`{"method":"spi.unknown"}`))
	req.Header.Set("Content-Type", "application/json")
	service.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["code"] != "40004" {
		t.Fatalf("response = %+v", response)
	}
}

func decodeResponseString(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var response map[string]any
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode response string: %v raw = %s", err, raw)
	}
	return response
}
