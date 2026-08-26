package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestActivationRedeemReturnsClientConfig(t *testing.T) {
	server := NewServer(config.Config{
		AppEnv:              "development",
		JWTSecret:           "test-secret",
		DevSMSCode:          "654321",
		NewAPIClientBaseURL: "https://api.example.com/v1",
		NewAPIPreviewToken:  "preview-token",
	}, BuildInfo{Version: "test"})

	accessToken := loginForTest(t, server, "13800138000", "654321")
	redeemRec := httptest.NewRecorder()
	redeemReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/activation/redeem",
		bytes.NewBufferString(`{"activationCode":"ABCD-EFGH-IJKL-MNOP","deviceSummary":"PREVIEW-ONLY"}`),
	)
	redeemReq.Header.Set("Authorization", "Bearer "+accessToken)
	server.ServeHTTP(redeemRec, redeemReq)

	if redeemRec.Code != http.StatusOK {
		t.Fatalf("redeem status = %d body = %s", redeemRec.Code, redeemRec.Body.String())
	}
	var payload struct {
		Status        string `json:"status"`
		PhoneMasked   string `json:"phoneMasked"`
		NewAPIBaseURL string `json:"newapiBaseUrl"`
		NewAPIToken   string `json:"newapiToken"`
		DefaultModels struct {
			Text  string `json:"text"`
			Image string `json:"image"`
			Video string `json:"video"`
		} `json:"defaultModels"`
	}
	if err := json.Unmarshal(redeemRec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode redeem response: %v", err)
	}
	if payload.Status != "activated" || payload.PhoneMasked != "138****8000" {
		t.Fatalf("unexpected redeem payload: %+v", payload)
	}
	if payload.NewAPIBaseURL != "https://api.example.com/v1" || payload.NewAPIToken != "preview-token" {
		t.Fatalf("unexpected New API config: %+v", payload)
	}
	if payload.DefaultModels.Text != "custom/gpt-5.5" {
		t.Fatalf("text model = %q", payload.DefaultModels.Text)
	}
}

func TestActivationRedeemRequiresBearerToken(t *testing.T) {
	server := NewServer(config.Config{AppEnv: "development", JWTSecret: "test-secret"}, BuildInfo{Version: "test"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/activation/redeem", bytes.NewBufferString(`{"activationCode":"ABCD-EFGH-IJKL"}`))

	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func loginForTest(t *testing.T, server http.Handler, phone string, code string) string {
	t.Helper()
	sendRec := httptest.NewRecorder()
	sendReq := httptest.NewRequest(http.MethodPost, "/v1/auth/sms/send", bytes.NewBufferString(`{"phone":"`+phone+`","purpose":"login"}`))
	server.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusOK {
		t.Fatalf("send status = %d body = %s", sendRec.Code, sendRec.Body.String())
	}

	loginRec := httptest.NewRecorder()
	loginReq := httptest.NewRequest(http.MethodPost, "/v1/auth/sms/login", bytes.NewBufferString(`{"phone":"`+phone+`","purpose":"login","code":"`+code+`"}`))
	server.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", loginRec.Code, loginRec.Body.String())
	}
	var loginPayload struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(loginRec.Body.Bytes(), &loginPayload); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if loginPayload.AccessToken == "" {
		t.Fatal("access token is empty")
	}
	return loginPayload.AccessToken
}
