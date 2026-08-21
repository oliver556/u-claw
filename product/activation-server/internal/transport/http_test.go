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
	"u-claw-activation-server/internal/policy"
)

type fakePublicService struct {
	activateResult    activation.ActivateResult
	activateErr       error
	activateInput     activation.ActivateInput
	commitErr         error
	status            lifecycle.Response
	statusErr         error
	activationContext context.Context
	statusContext     context.Context
	recovered         []byte
	clientPolicy      policy.ClientPolicy
	policyErr         error
}

func (service *fakePublicService) Current(context.Context) (policy.ClientPolicy, error) {
	return service.clientPolicy, service.policyErr
}

func (service *fakePublicService) Recover(context.Context, lifecycle.RecoverInput) ([]byte, error) {
	return service.recovered, nil
}
func (service *fakePublicService) Activate(_ context.Context, input activation.ActivateInput) (activation.ActivateResult, error) {
	service.activateInput = input
	return service.activateResult, service.activateErr
}

func TestPublicHandlerServesRecoveryAndRejectsRemovedDeviceTokenRoute(t *testing.T) {
	service := &fakePublicService{
		recovered: []byte(`{"activationId":"act_fixture_001"}`),
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
	if tokenResponse.Code != http.StatusNotFound {
		t.Fatalf("token=%d %s", tokenResponse.Code, tokenResponse.Body.String())
	}
}

func TestCommitRequiresNoBearerAndReturnsNoMaterial(t *testing.T) {
	service := &fakePublicService{}
	handler := NewPublicHandler(PublicHandlerOptions{Activation: service, Lifecycle: service, RequestIDs: strings.NewReader(strings.Repeat("a", 64))})
	request := httptest.NewRequest(http.MethodPost, "/v1/activations/act_fixture_001/commit", strings.NewReader(`{"idempotencyKey":"commit-fixture-001","artifactGeneration":1}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
		t.Fatalf("response=%d %q", response.Code, response.Body.String())
	}
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
	valid := `{"activationCode":"TESTTESTTESTTESTTESTTEST12","usbFingerprint":{"version":"uclaw-usb-v1","sha256":"` + strings.Repeat("a", 64) + `"},"clientVersion":"1.0.0","idempotencyKey":"activation-001"}`
	for name, body := range map[string]string{
		"unknown":          valid[:len(valid)-1] + `,"extra":true}`,
		"unknown username": strings.Replace(valid, `{"activationCode"`, `{"username":"UCLAW-OTHER","activationCode"`, 1),
		"trailing":         valid + `{}`,
		"oversized":        `{"padding":"` + strings.Repeat("x", (1<<20)+1) + `"}`,
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

func TestPublicHandlerForwardsDeviceAliasesAndRejectsMutableEvidenceFields(t *testing.T) {
	service := &fakePublicService{activateResult: activation.ActivateResult{Material: []byte(`{"activationId":"act_fixture_001"}`)}}
	handler := NewPublicHandler(PublicHandlerOptions{Activation: service, Lifecycle: service, RequestIDs: strings.NewReader(strings.Repeat("a", 64))})
	body := activationBodyWithDeviceAliases("")
	request := httptest.NewRequest(http.MethodPost, "/v1/activations", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(service.activateInput.DeviceAliases) != 2 ||
		service.activateInput.DeviceAliases[0].Fingerprint.SHA256 == service.activateInput.DeviceAliases[1].Fingerprint.SHA256 {
		t.Fatalf("aliases=%+v", service.activateInput.DeviceAliases)
	}
	for _, field := range []string{`"volumeName":"U-Claw"`, `"mountPath":"/Volumes/U-Claw"`, `"driveLetter":"E:"`} {
		request := httptest.NewRequest(http.MethodPost, "/v1/activations", strings.NewReader(activationBodyWithDeviceAliases(field)))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("mutable field %s accepted: %d %s", field, response.Code, response.Body.String())
		}
	}
}

func TestPublicHandlerProjectsStableRedactedErrors(t *testing.T) {
	secret := "Authorization: Bearer private-secret"
	service := &fakePublicService{activateErr: errors.Join(activation.ErrActivationServiceUnavailable, errors.New(secret))}
	handler := NewPublicHandler(PublicHandlerOptions{Activation: service, Lifecycle: service, RequestIDs: strings.NewReader(strings.Repeat("b", 64))})
	body := `{"activationCode":"TESTTESTTESTTESTTESTTEST12","usbFingerprint":{"version":"uclaw-usb-v1","sha256":"` + strings.Repeat("a", 64) + `"},"clientVersion":"1.0.0","idempotencyKey":"activation-001"}`
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

func activationBodyWithDeviceAliases(extraMacEvidence string) string {
	extra := ""
	if extraMacEvidence != "" {
		extra = "," + extraMacEvidence
	}
	return `{"activationCode":"TESTTESTTESTTESTTESTTEST12","usbFingerprint":{"version":"uclaw-usb-v1","sha256":"` + strings.Repeat("a", 64) + `"},"deviceAliases":[{"target":"win-x64","fingerprint":{"version":"uclaw-usb-v1","sha256":"` + strings.Repeat("a", 64) + `"},"evidence":{"target":"win-x64","platform":"win32","arch":"x64","source":"windows-storage-descriptor","busType":"USB","vendor":"ACME","product":"FLASH DRIVE","revision":"1.00","serial":"SN123","capacityBytes":64000000000,"uniqueDescriptorSha256":"` + strings.Repeat("b", 64) + `"}},{"target":"macos-arm64","fingerprint":{"version":"uclaw-usb-v2","sha256":"` + strings.Repeat("c", 64) + `"},"evidence":{"target":"macos-arm64","platform":"darwin","arch":"arm64","source":"macos-diskutil","busProtocol":"USB","deviceLocation":"external","vendor":"ACME","product":"FLASH DRIVE","revision":"1.00","serial":"SN123","capacityBytes":64000000000,"volumeUuid":"4f2b2fc0-3e70-49a0-9dfc-0e012aef0001","mediaUuid":"7A9877AE-2941-4F87-83EF-C9B7DF8DA111"` + extra + `}}],"clientVersion":"1.0.0","idempotencyKey":"activation-001"}`
}

func TestActivateErrorReportsBindingStageAndActivationID(t *testing.T) {
	for name, result := range map[string]activation.ActivateResult{
		"before bind":  {},
		"server bound": {ActivationID: "act_fixture_001"},
	} {
		t.Run(name, func(t *testing.T) {
			service := &fakePublicService{activateResult: result, activateErr: activation.ErrActivationServiceUnavailable}
			handler := NewPublicHandler(PublicHandlerOptions{Activation: service, RequestIDs: strings.NewReader(strings.Repeat("c", 64))})
			body := `{"activationCode":"TESTTESTTESTTESTTESTTEST12","usbFingerprint":{"version":"uclaw-usb-v1","sha256":"` + strings.Repeat("a", 64) + `"},"clientVersion":"1.0.0","idempotencyKey":"activation-001"}`
			request := httptest.NewRequest(http.MethodPost, "/v1/activations", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			var payload publicError
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			wantStage := "failed_before_bind"
			if result.ActivationID != "" {
				wantStage = "server_bound"
			}
			if payload.Stage == nil || *payload.Stage != wantStage || (result.ActivationID != "" && (payload.ActivationID == nil || *payload.ActivationID != result.ActivationID)) {
				t.Fatalf("payload=%+v", payload)
			}
		})
	}
}

func TestActivateValidationErrorReportsFailedBeforeBind(t *testing.T) {
	handler := NewPublicHandler(PublicHandlerOptions{RequestIDs: strings.NewReader(strings.Repeat("d", 64))})
	request := httptest.NewRequest(http.MethodPost, "/v1/activations", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var payload publicError
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Stage == nil || *payload.Stage != "failed_before_bind" || payload.ActivationID != nil {
		t.Fatalf("payload=%+v", payload)
	}
}

func TestPublicHandlerServesClientPolicy(t *testing.T) {
	service := &fakePublicService{clientPolicy: policy.ClientPolicy{SchemaVersion: 1, PolicyEpoch: 107, RequiredReleaseSequence: 107, ReleaseID: "release-107", ContentVersion: "1.5.0", Reason: policy.ReleaseReasonRelease, ManifestURL: "https://cdn.example.test/releases/107/manifest.json", ManifestSHA256: strings.Repeat("a", 64), IssuedAt: "2026-08-21T01:02:03Z", ExpiresAt: "2026-08-21T01:07:03Z", Signature: policy.Signature{Algorithm: "ed25519", KeyID: "policy-key", Value: strings.Repeat("A", 88)}}}
	handler := NewPublicHandler(PublicHandlerOptions{Activation: service, Lifecycle: service, Policy: service, RequestIDs: strings.NewReader(strings.Repeat("c", 64))})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/client-policy", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"requiredReleaseSequence":107`) {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	service.policyErr = policy.ErrUnavailable
	failed := httptest.NewRecorder()
	handler.ServeHTTP(failed, httptest.NewRequest(http.MethodGet, "/v1/client-policy", nil))
	if failed.Code != http.StatusServiceUnavailable || strings.Contains(failed.Body.String(), "release-107") {
		t.Fatalf("fail-closed=%d %s", failed.Code, failed.Body.String())
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
