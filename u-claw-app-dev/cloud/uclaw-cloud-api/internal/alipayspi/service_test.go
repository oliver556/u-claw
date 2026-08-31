package alipayspi

import (
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
		Response string `json:"response"`
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
		Response string `json:"response"`
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
		Response string `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["qr_code_id"] != "https://qr.isv.com/test/1" {
		t.Fatalf("response = %+v", response)
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
		Response string `json:"response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	response := decodeResponseString(t, payload.Response)
	if response["code"] != "40004" {
		t.Fatalf("response = %+v", response)
	}
}

func decodeResponseString(t *testing.T, raw string) map[string]any {
	t.Helper()
	var response map[string]any
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatalf("decode response string: %v raw = %s", err, raw)
	}
	return response
}
