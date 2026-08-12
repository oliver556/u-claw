package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"u-claw-activation-server/internal/activation"
	"u-claw-activation-server/internal/lifecycle"
)

type fakePublicService struct {
	activateResult    activation.ActivateResult
	activateErr       error
	commitErr         error
	status            lifecycle.Response
	statusErr         error
	activationContext context.Context
	statusContext     context.Context
	recovered         []byte
	token             lifecycle.DeviceTokenResponse
}

func (service *fakePublicService) Recover(context.Context, lifecycle.RecoverInput) ([]byte, error) {
	return service.recovered, nil
}
func (service *fakePublicService) DeviceToken(context.Context, lifecycle.DeviceTokenInput) (lifecycle.DeviceTokenResponse, error) {
	return service.token, nil
}

func (service *fakePublicService) Activate(context.Context, activation.ActivateInput) (activation.ActivateResult, error) {
	return service.activateResult, service.activateErr
}

func TestPublicHandlerServesRecoveryAndDeviceToken(t *testing.T) {
	service := &fakePublicService{
		recovered: []byte(`{"activationId":"act_fixture_001"}`),
		token:     lifecycle.DeviceTokenResponse{AccessToken: strings.Repeat("t", 32), TokenType: "Bearer", ExpiresAt: "2026-08-13T02:00:00Z"},
	}
	handler := NewPublicHandler(PublicHandlerOptions{Activation: service, Lifecycle: service, RequestIDs: strings.NewReader(strings.Repeat("f", 128))})
	recovery := httptest.NewRequest(http.MethodGet, "/v1/activations/act_fixture_001", nil)
	recovery.Header.Set("Authorization", "Bearer "+strings.Repeat("s", 32))
	recoveryResponse := httptest.NewRecorder()
	handler.ServeHTTP(recoveryResponse, recovery)
	if recoveryResponse.Code != http.StatusOK || recoveryResponse.Body.String() != string(service.recovered)+"\n" {
		t.Fatalf("recovery=%d %s", recoveryResponse.Code, recoveryResponse.Body.String())
	}
	tokenRequest := httptest.NewRequest(http.MethodPost, "/v1/device-tokens", strings.NewReader(`{"deviceId":"dev_fixture_001","licenseId":"lic_fixture_001","idempotencyKey":"token-fixture-001"}`))
	tokenRequest.Header.Set("Authorization", "Bearer "+strings.Repeat("s", 32))
	tokenRequest.Header.Set("Content-Type", "application/json")
	tokenResponse := httptest.NewRecorder()
	handler.ServeHTTP(tokenResponse, tokenRequest)
	if tokenResponse.Code != http.StatusOK || !strings.Contains(tokenResponse.Body.String(), strings.Repeat("t", 32)) {
		t.Fatalf("token=%d %s", tokenResponse.Code, tokenResponse.Body.String())
	}
}

func TestCommitRequiresNoBearerAndReturnsNoMaterial(t *testing.T) {
	service := &fakePublicService{}
	handler := NewPublicHandler(PublicHandlerOptions{Activation:service, Lifecycle:service, RequestIDs:strings.NewReader(strings.Repeat("a",64))})
	request := httptest.NewRequest(http.MethodPost,"/v1/activations/act_fixture_001/commit",strings.NewReader(`{"idempotencyKey":"commit-fixture-001","artifactGeneration":1}`))
	request.Header.Set("Content-Type","application/json")
	response := httptest.NewRecorder(); handler.ServeHTTP(response,request)
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 { t.Fatalf("response=%d %q",response.Code,response.Body.String()) }
}
func (service *fakePublicService) Commit(ctx context.Context, _ activation.CommitInput) error {
	service.activationContext = ctx
	return service.commitErr
}
func (service *fakePublicService) Status(ctx context.Context, _, _ string) (lifecycle.Response, error) {
	service.statusContext = ctx
	return service.status, service.statusErr
}

func TestPublicHandlerUsesStrictBoundedJSONAndNoRedirect(t *testing.T) {
	service := &fakePublicService{activateResult: activation.ActivateResult{Material: []byte(`{"activationId":"act_fixture_001"}`)}}
	handler := NewPublicHandler(PublicHandlerOptions{Activation: service, Lifecycle: service, RequestIDs: strings.NewReader(strings.Repeat("a", 64))})
	valid := `{"username":"UCLAW-00000001","activationCode":"0123456789ABCDEFGHJKMNPQRS","usbFingerprint":{"version":"uclaw-usb-v1","sha256":"` + strings.Repeat("a", 64) + `"},"clientVersion":"1.0.0","idempotencyKey":"activation-001"}`
	for name, body := range map[string]string{
		"unknown":   valid[:len(valid)-1] + `,"extra":true}`,
		"duplicate": strings.Replace(valid, `"username":`, `"username":"UCLAW-OTHER","username":`, 1),
		"trailing":  valid + `{}`,
		"oversized": `{"padding":"` + strings.Repeat("x", (1<<20)+1) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/v1/activations", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest && response.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status=%d", response.Code)
			}
		})
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/activations/", nil))
	if response.Code >= 300 && response.Code < 400 {
		t.Fatalf("unexpected redirect %d", response.Code)
	}
}

func TestPublicHandlerProjectsStableRedactedErrors(t *testing.T) {
	secret := "Authorization: Bearer private-secret"
	service := &fakePublicService{activateErr: errors.Join(activation.ErrActivationServiceUnavailable, errors.New(secret))}
	handler := NewPublicHandler(PublicHandlerOptions{Activation: service, Lifecycle: service, RequestIDs: strings.NewReader(strings.Repeat("b", 64))})
	body := `{"username":"UCLAW-00000001","activationCode":"0123456789ABCDEFGHJKMNPQRS","usbFingerprint":{"version":"uclaw-usb-v1","sha256":"` + strings.Repeat("a", 64) + `"},"clientVersion":"1.0.0","idempotencyKey":"activation-001"}`
	request := httptest.NewRequest(http.MethodPost, "/v1/activations", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), secret) {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	var projected map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &projected); err != nil {
		t.Fatal(err)
	}
	if len(projected) != 6 || projected["code"] != "ACTIVATION_SERVICE_UNAVAILABLE" || projected["requestId"] == "" {
		t.Fatalf("error=%#v", projected)
	}
}

func TestPublicHandlerServesClientPolicy(t *testing.T) {
	handler := NewPublicHandler(PublicHandlerOptions{Activation: &fakePublicService{}, Lifecycle: &fakePublicService{}, RequestIDs: strings.NewReader(strings.Repeat("c", 64))})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/client-policy", nil))
	if response.Code != http.StatusOK || response.Body.String() != "{\"minimumClientVersion\":\"1.0.0\",\"latestClientVersion\":\"1.0.0\",\"upgradeRequired\":false,\"statusRefreshSeconds\":300,\"maximumOfflineGraceSeconds\":86400}\n" {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
}

func TestPublicHandlerFailsClosedForNilServicesAndAddsOperationDeadline(t *testing.T) {
	nilHandler := NewPublicHandler(PublicHandlerOptions{RequestIDs: strings.NewReader(strings.Repeat("d", 64))})
	for method, target := range map[string]string{http.MethodPost: "/v1/activations/act_fixture_001/commit", http.MethodGet: "/v1/licenses/lic_fixture_001/status"} {
		request := httptest.NewRequest(method, target, strings.NewReader(`{"idempotencyKey":"commit-fixture-001","artifactGeneration":1}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+strings.Repeat("s", 32))
		response := httptest.NewRecorder()
		nilHandler.ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s status=%d", target, response.Code)
		}
	}
	service := &fakePublicService{}
	handler := NewPublicHandler(PublicHandlerOptions{Activation: service, Lifecycle: service, RequestIDs: strings.NewReader(strings.Repeat("e", 64))})
	request := httptest.NewRequest(http.MethodGet, "/v1/licenses/lic_fixture_001/status", nil)
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("s", 32))
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if _, ok := service.statusContext.Deadline(); !ok {
		t.Fatal("status operation has no deadline")
	}
}
