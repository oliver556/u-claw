package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"uclaw-cloud-api/internal/config"
)

func TestHealthzReturnsOK(t *testing.T) {
	server := NewServer(config.Config{AppEnv: "test"}, BuildInfo{Version: "test"})
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload["status"] != "ok" {
		t.Fatalf("payload status = %v, want ok", payload["status"])
	}
}

func TestSMSLoginFlowReturnsAccessToken(t *testing.T) {
	server := NewServer(config.Config{
		AppEnv:     "development",
		JWTSecret:  "test-secret",
		DevSMSCode: "654321",
	}, BuildInfo{Version: "test"})

	sendRec := httptest.NewRecorder()
	sendReq := httptest.NewRequest(http.MethodPost, "/v1/auth/sms/send", bytes.NewBufferString(`{"phone":"13800138000","purpose":"login"}`))
	server.ServeHTTP(sendRec, sendReq)

	if sendRec.Code != http.StatusOK {
		t.Fatalf("send status = %d body = %s", sendRec.Code, sendRec.Body.String())
	}
	var sendPayload map[string]any
	if err := json.Unmarshal(sendRec.Body.Bytes(), &sendPayload); err != nil {
		t.Fatalf("decode send response: %v", err)
	}
	if sendPayload["devCode"] != "654321" {
		t.Fatalf("devCode = %v, want 654321", sendPayload["devCode"])
	}

	loginRec := httptest.NewRecorder()
	loginReq := httptest.NewRequest(http.MethodPost, "/v1/auth/sms/login", bytes.NewBufferString(`{"phone":"13800138000","purpose":"login","code":"654321"}`))
	server.ServeHTTP(loginRec, loginReq)

	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", loginRec.Code, loginRec.Body.String())
	}
	var loginPayload struct {
		AccessToken string `json:"accessToken"`
		User        struct {
			ID    float64 `json:"id"`
			Phone string  `json:"phone"`
		} `json:"user"`
	}
	if err := json.Unmarshal(loginRec.Body.Bytes(), &loginPayload); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if loginPayload.AccessToken == "" {
		t.Fatal("accessToken is empty")
	}
	if loginPayload.User.Phone != "138****8000" {
		t.Fatalf("masked phone = %q", loginPayload.User.Phone)
	}
}

func TestSMSLoginRejectsInvalidCode(t *testing.T) {
	server := NewServer(config.Config{AppEnv: "development", JWTSecret: "test-secret"}, BuildInfo{Version: "test"})

	sendRec := httptest.NewRecorder()
	sendReq := httptest.NewRequest(http.MethodPost, "/v1/auth/sms/send", bytes.NewBufferString(`{"phone":"13800138000"}`))
	server.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusOK {
		t.Fatalf("send status = %d body = %s", sendRec.Code, sendRec.Body.String())
	}

	loginRec := httptest.NewRecorder()
	loginReq := httptest.NewRequest(http.MethodPost, "/v1/auth/sms/login", bytes.NewBufferString(`{"phone":"13800138000","code":"000000"}`))
	server.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusUnauthorized {
		t.Fatalf("login status = %d, want 401", loginRec.Code)
	}
}

func TestDevAuthPageAvailableOutsideProduction(t *testing.T) {
	server := NewServer(config.Config{AppEnv: "development", JWTSecret: "test-secret"}, BuildInfo{Version: "test"})
	req := httptest.NewRequest(http.MethodGet, "/dev/auth", nil)
	rec := httptest.NewRecorder()

	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if contentType := rec.Header().Get("Content-Type"); !strings.Contains(contentType, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", contentType)
	}
	if !strings.Contains(rec.Body.String(), "U-Claw Auth 验收") {
		t.Fatalf("body missing dev auth title")
	}
}

func TestDevAuthPageDisabledInProduction(t *testing.T) {
	server := NewServer(config.Config{AppEnv: "production", JWTSecret: "test-secret"}, BuildInfo{Version: "test"})
	req := httptest.NewRequest(http.MethodGet, "/dev/auth", nil)
	rec := httptest.NewRecorder()

	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
