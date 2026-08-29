package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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

func TestFirstStartActivationFlowDoesNotRequireBearerToken(t *testing.T) {
	server := NewServer(config.Config{
		AppEnv:              "development",
		JWTSecret:           "test-secret",
		NewAPIClientBaseURL: "https://api.example.com/v1",
		NewAPIPreviewToken:  "preview-token",
	}, BuildInfo{Version: "test"})

	activateRec := httptest.NewRecorder()
	activateReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/activations",
		bytes.NewBufferString(`{"username":"uclaw-biancheng","activationCode":"ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ","usbFingerprintSummary":"PREVIEW-ONLY","idempotencyKey":"idem-static-1"}`),
	)
	server.ServeHTTP(activateRec, activateReq)

	if activateRec.Code != http.StatusOK {
		t.Fatalf("activate status = %d body = %s", activateRec.Code, activateRec.Body.String())
	}
	var activatePayload struct {
		OK              bool   `json:"ok"`
		ActivationID    string `json:"activationId"`
		Status          string `json:"status"`
		ArtifactStatus  string `json:"artifactStatus"`
		NewAPIToken     string `json:"newapiToken"`
		LicenseArtifact struct {
			Payload struct {
				SchemaVersion string `json:"schemaVersion"`
				ActivationID  string `json:"activationId"`
				Subject       string `json:"subject"`
			} `json:"payload"`
			Signature struct {
				Algorithm string `json:"algorithm"`
				KeyID     string `json:"keyId"`
				Value     string `json:"value"`
			} `json:"signature"`
		} `json:"licenseArtifact"`
	}
	if err := json.Unmarshal(activateRec.Body.Bytes(), &activatePayload); err != nil {
		t.Fatalf("decode activation response: %v", err)
	}
	if !activatePayload.OK || activatePayload.ActivationID == "" || activatePayload.Status != "server_bound" {
		t.Fatalf("unexpected activation payload: %+v", activatePayload)
	}
	if activatePayload.ArtifactStatus != "pending_client_write" || activatePayload.NewAPIToken != "preview-token" {
		t.Fatalf("unexpected activation artifact payload: %+v", activatePayload)
	}
	if activatePayload.LicenseArtifact.Payload.SchemaVersion != "uclaw.license.v1" ||
		activatePayload.LicenseArtifact.Payload.ActivationID != activatePayload.ActivationID ||
		activatePayload.LicenseArtifact.Payload.Subject != "UCLAW-BIANCHENG" ||
		activatePayload.LicenseArtifact.Signature.Algorithm != "Ed25519" ||
		activatePayload.LicenseArtifact.Signature.Value == "" {
		t.Fatalf("unexpected license artifact: %+v", activatePayload.LicenseArtifact)
	}

	commitRec := httptest.NewRecorder()
	commitReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/activations/"+activatePayload.ActivationID+"/commit",
		bytes.NewBufferString(`{"writeStatus":"verified"}`),
	)
	server.ServeHTTP(commitRec, commitReq)

	if commitRec.Code != http.StatusOK {
		t.Fatalf("commit status = %d body = %s", commitRec.Code, commitRec.Body.String())
	}
	var commitPayload struct {
		OK           bool   `json:"ok"`
		ActivationID string `json:"activationId"`
		Status       string `json:"status"`
	}
	if err := json.Unmarshal(commitRec.Body.Bytes(), &commitPayload); err != nil {
		t.Fatalf("decode commit response: %v", err)
	}
	if !commitPayload.OK || commitPayload.ActivationID != activatePayload.ActivationID || commitPayload.Status != "committed" {
		t.Fatalf("unexpected commit payload: %+v", commitPayload)
	}
}

func TestFirstStartActivationAcceptsFixedPhoneCode(t *testing.T) {
	server := NewServer(config.Config{
		AppEnv:              "staging",
		JWTSecret:           "test-secret",
		DevSMSCode:          "123456",
		SMSProvider:         "fixed",
		SMSCodePepper:       "test-pepper",
		NewAPIClientBaseURL: "https://api.example.com/v1",
		NewAPIPreviewToken:  "preview-token",
	}, BuildInfo{Version: "test"})

	activateRec := httptest.NewRecorder()
	activateReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/activations",
		bytes.NewBufferString(`{"phone":"13800138000","smsCode":"123456","activationCode":"ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ","usbFingerprintSummary":"PREVIEW-ONLY","idempotencyKey":"idem-phone-1"}`),
	)
	server.ServeHTTP(activateRec, activateReq)

	if activateRec.Code != http.StatusOK {
		t.Fatalf("activate status = %d body = %s", activateRec.Code, activateRec.Body.String())
	}
	var activatePayload struct {
		OK              bool   `json:"ok"`
		ActivationID    string `json:"activationId"`
		PhoneMasked     string `json:"phoneMasked"`
		AccessToken     string `json:"accessToken"`
		ArtifactStatus  string `json:"artifactStatus"`
		LicenseArtifact struct {
			Payload struct {
				Subject string `json:"subject"`
			} `json:"payload"`
		} `json:"licenseArtifact"`
	}
	if err := json.Unmarshal(activateRec.Body.Bytes(), &activatePayload); err != nil {
		t.Fatalf("decode activation response: %v", err)
	}
	if !activatePayload.OK || activatePayload.PhoneMasked != "138****8000" || activatePayload.AccessToken == "" {
		t.Fatalf("unexpected activation payload: %+v", activatePayload)
	}
	if activatePayload.ArtifactStatus != "pending_client_write" || activatePayload.LicenseArtifact.Payload.Subject != "13800138000" {
		t.Fatalf("unexpected activation artifact payload: %+v", activatePayload)
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

func TestRechargeProvidersRequiresBearerAndReturnsCatalog(t *testing.T) {
	server := NewServer(config.Config{
		AppEnv:     "development",
		JWTSecret:  "test-secret",
		DevSMSCode: "654321",
	}, BuildInfo{Version: "test"})

	unauthorizedRec := httptest.NewRecorder()
	unauthorizedReq := httptest.NewRequest(http.MethodGet, "/v1/recharge/providers", nil)
	server.ServeHTTP(unauthorizedRec, unauthorizedReq)
	if unauthorizedRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want 401", unauthorizedRec.Code)
	}

	accessToken := loginForTest(t, server, "13800138000", "654321")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/recharge/providers", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Providers []struct {
			Code    string `json:"code"`
			Enabled bool   `json:"enabled"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode providers response: %v", err)
	}
	if len(payload.Providers) == 0 {
		t.Fatal("providers is empty")
	}
	if payload.Providers[0].Code != "virtual" || !payload.Providers[0].Enabled {
		t.Fatalf("providers = %+v", payload.Providers)
	}
}

func TestRechargeOrderRejectsUnconfiguredOfficialProvider(t *testing.T) {
	server := NewServer(config.Config{
		AppEnv:     "development",
		JWTSecret:  "test-secret",
		DevSMSCode: "654321",
	}, BuildInfo{Version: "test"})
	accessToken := loginForTest(t, server, "13800138000", "654321")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/recharge/orders",
		bytes.NewBufferString(`{"planCode":"dev_10","provider":"alipay"}`),
	)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payment provider alipay is not configured") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestAdminConsoleRegistersLogsInAndManagesActivationCodes(t *testing.T) {
	server := NewServer(config.Config{
		AppEnv:             "development",
		JWTSecret:          "test-secret",
		AdminToken:         "bootstrap-token",
		AdminEncryptionKey: "admin-encryption-key-at-least-32-bytes",
	}, BuildInfo{Version: "test"})

	pageRec := httptest.NewRecorder()
	pageReq := httptest.NewRequest(http.MethodGet, "/admin", nil)
	server.ServeHTTP(pageRec, pageReq)
	if pageRec.Code != http.StatusOK || !strings.Contains(pageRec.Body.String(), "U-Claw 运营后台") {
		t.Fatalf("admin page status = %d body = %s", pageRec.Code, pageRec.Body.String())
	}

	unauthorizedRec := httptest.NewRecorder()
	unauthorizedReq := httptest.NewRequest(http.MethodGet, "/internal/admin/v1/activation-codes", nil)
	server.ServeHTTP(unauthorizedRec, unauthorizedReq)
	if unauthorizedRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want 401", unauthorizedRec.Code)
	}

	setupRec := httptest.NewRecorder()
	setupReq := httptest.NewRequest(http.MethodGet, "/internal/admin/v1/auth/setup", nil)
	server.ServeHTTP(setupRec, setupReq)
	if setupRec.Code != http.StatusOK || !strings.Contains(setupRec.Body.String(), `"registrationOpen":true`) {
		t.Fatalf("setup status = %d body = %s", setupRec.Code, setupRec.Body.String())
	}

	registerRec := httptest.NewRecorder()
	registerReq := httptest.NewRequest(
		http.MethodPost,
		"/internal/admin/v1/auth/register",
		bytes.NewBufferString(`{"username":"uclawroot","password":"DummyPass123!"}`),
	)
	registerReq.Header.Set("Authorization", "Bearer bootstrap-token")
	server.ServeHTTP(registerRec, registerReq)
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d body = %s", registerRec.Code, registerRec.Body.String())
	}

	loginRec := httptest.NewRecorder()
	loginReq := httptest.NewRequest(
		http.MethodPost,
		"/internal/admin/v1/auth/login",
		bytes.NewBufferString(`{"username":"uclawroot","password":"DummyPass123!"}`),
	)
	server.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", loginRec.Code, loginRec.Body.String())
	}
	var loginPayload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(loginRec.Body.Bytes(), &loginPayload); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if loginPayload.Token == "" {
		t.Fatal("admin session token is empty")
	}

	generateRec := httptest.NewRecorder()
	generateReq := httptest.NewRequest(
		http.MethodPost,
		"/internal/admin/v1/activation-codes/generate",
		bytes.NewBufferString(`{"count":2,"batchName":"验收批次","createdBy":"tester"}`),
	)
	generateReq.Header.Set("Authorization", "Bearer "+loginPayload.Token)
	server.ServeHTTP(generateRec, generateReq)
	if generateRec.Code != http.StatusCreated {
		t.Fatalf("generate status = %d body = %s", generateRec.Code, generateRec.Body.String())
	}
	var generated struct {
		Codes []struct {
			ID      int64  `json:"id"`
			Code    string `json:"code"`
			Status  string `json:"status"`
			Visible bool   `json:"codeVisible"`
		} `json:"codes"`
	}
	if err := json.Unmarshal(generateRec.Body.Bytes(), &generated); err != nil {
		t.Fatalf("decode generate response: %v", err)
	}
	if len(generated.Codes) != 2 || generated.Codes[0].Code == "" || generated.Codes[0].Status != "unused" || !generated.Codes[0].Visible {
		t.Fatalf("generated codes = %+v", generated.Codes)
	}

	disableRec := httptest.NewRecorder()
	disableReq := httptest.NewRequest(
		http.MethodPost,
		"/internal/admin/v1/activation-codes/"+strconv.FormatInt(generated.Codes[0].ID, 10)+"/disable",
		bytes.NewBufferString(`{"reason":"test"}`),
	)
	disableReq.Header.Set("Authorization", "Bearer "+loginPayload.Token)
	server.ServeHTTP(disableRec, disableReq)
	if disableRec.Code != http.StatusOK {
		t.Fatalf("disable status = %d body = %s", disableRec.Code, disableRec.Body.String())
	}

	reissueRec := httptest.NewRecorder()
	reissueReq := httptest.NewRequest(
		http.MethodPost,
		"/internal/admin/v1/activation-codes/"+strconv.FormatInt(generated.Codes[0].ID, 10)+"/reissue",
		bytes.NewBufferString(`{}`),
	)
	reissueReq.Header.Set("Authorization", "Bearer "+loginPayload.Token)
	server.ServeHTTP(reissueRec, reissueReq)
	if reissueRec.Code != http.StatusCreated {
		t.Fatalf("reissue status = %d body = %s", reissueRec.Code, reissueRec.Body.String())
	}

	listRec := httptest.NewRecorder()
	listReq := httptest.NewRequest(http.MethodGet, "/internal/admin/v1/activation-codes?limit=10", nil)
	listReq.Header.Set("Authorization", "Bearer "+loginPayload.Token)
	server.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", listRec.Code, listRec.Body.String())
	}
	if !strings.Contains(listRec.Body.String(), `"status":"reissued"`) || !strings.Contains(listRec.Body.String(), `"codeVisible":true`) {
		t.Fatalf("list body missing expected code details: %s", listRec.Body.String())
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
