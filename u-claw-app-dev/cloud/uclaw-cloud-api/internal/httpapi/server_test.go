package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"uclaw-cloud-api/internal/config"
	"uclaw-cloud-api/internal/provisioning"
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

func TestUsageSummaryReturnsNewAPICounters(t *testing.T) {
	secret := "test-newapi-password-secret"
	expectedPassword := provisioning.DeriveUserPassword(1, "13800138000", secret)
	newAPIServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			var req map[string]string
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode login request: %v", err)
			}
			if req["username"] != "13800138000" || req["password"] != expectedPassword {
				t.Fatalf("login request = %+v", req)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/self":
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":9,"username":"13800138000","quota":100000,"used_quota":24171,"request_count":3}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/log/self":
			_, _ = w.Write([]byte(`{"success":true,"data":{"page":1,"page_size":50,"total":1,"items":[{"id":1,"created_at":1787762761,"model_name":"gpt-5.5","quota":24171}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer newAPIServer.Close()

	server := NewServer(config.Config{
		AppEnv:                   "development",
		JWTSecret:                "test-secret",
		DevSMSCode:               "654321",
		NewAPIAdminBaseURL:       newAPIServer.URL,
		NewAPIAdminToken:         "admin-token",
		NewAPIUserPasswordSecret: secret,
	}, BuildInfo{Version: "test"})

	accessToken := loginForTest(t, server, "13800138000", "654321")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/newapi/usage/summary", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Status          string `json:"status"`
		AccountBalance  int64  `json:"accountBalance"`
		UsedQuota       int64  `json:"usedQuota"`
		CumulativeUsage int64  `json:"cumulativeUsage"`
		Records         []struct {
			ModelName string `json:"modelName"`
			Quota     int64  `json:"quota"`
		} `json:"records"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode usage response: %v", err)
	}
	if payload.Status != "ok" || payload.AccountBalance != 100000 || payload.UsedQuota != 24171 || payload.CumulativeUsage != 24171 {
		t.Fatalf("payload = %+v", payload)
	}
	if len(payload.Records) != 1 || payload.Records[0].ModelName != "gpt-5.5" {
		t.Fatalf("records = %+v", payload.Records)
	}
}

func TestUsageSummaryRequiresNewAPIConfig(t *testing.T) {
	server := NewServer(config.Config{
		AppEnv:     "development",
		JWTSecret:  "test-secret",
		DevSMSCode: "654321",
	}, BuildInfo{Version: "test"})
	accessToken := loginForTest(t, server, "13800138000", "654321")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/newapi/usage/summary", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body = %s", rec.Code, rec.Body.String())
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
