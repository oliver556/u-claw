package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	adminservice "u-claw-activation-server/internal/admin"
	"u-claw-activation-server/internal/policy"
	"u-claw-activation-server/internal/releaseauth"
)

func httpOperators(secret string) adminservice.OperatorRegistry {
	sum := sha256.Sum256([]byte(secret))
	return adminservice.OperatorRegistry{"operator_fixture": sum}
}

type fakeHTTPAdmin struct {
	mutation   adminservice.Mutation
	token      adminservice.DeviceTokenMutation
	auditQuery adminservice.AuditQuery
}

type fakeReleaseAdmin struct {
	published policy.Release
	rollback  policy.Release
}

func (service *fakeReleaseAdmin) Publish(_ context.Context, release policy.Release) (policy.ProductionState, error) {
	service.published = release
	release.Status = policy.ReleaseStatusCurrent
	return policy.ProductionState{PolicyEpoch: 107, Current: &release}, nil
}
func (service *fakeReleaseAdmin) ForwardRollback(_ context.Context, release policy.Release) (policy.ProductionState, error) {
	service.rollback = release
	release.ContentVersion = "1.5.0"
	release.Reason = policy.ReleaseReasonRollback
	release.Status = policy.ReleaseStatusCurrent
	stable := policy.Release{ReleaseSequence: 105, ReleaseID: "release-105", ContentVersion: "1.5.0", Reason: policy.ReleaseReasonRelease, Status: policy.ReleaseStatusStable}
	return policy.ProductionState{PolicyEpoch: 108, Current: &release, PreviousStable: &stable}, nil
}

func (*fakeHTTPAdmin) Generate(context.Context, adminservice.GenerateInput) ([]adminservice.InventorySummary, error) {
	return []adminservice.InventorySummary{{InventoryID: "inv_fixture_001", Username: "UCLAW-001", Status: "prepared"}}, nil
}
func (*fakeHTTPAdmin) Import(context.Context, adminservice.ImportInput) ([]adminservice.InventorySummary, error) {
	return nil, nil
}
func (*fakeHTTPAdmin) Show(context.Context, adminservice.InventoryLocator) (adminservice.InventorySummary, error) {
	return adminservice.InventorySummary{InventoryID: "inv_fixture_001"}, nil
}
func (service *fakeHTTPAdmin) MutateLicense(_ context.Context, mutation adminservice.Mutation) (adminservice.MutationResult, error) {
	service.mutation = mutation
	return adminservice.MutationResult{LicenseID: mutation.LicenseID, Status: string(mutation.Action)}, nil
}
func (*fakeHTTPAdmin) MarkConfigured(context.Context, adminservice.InventoryLocator, adminservice.Operation) (adminservice.InventorySummary, error) {
	return adminservice.InventorySummary{InventoryID: "inv_fixture_001", NewAPISetupStatus: "configured"}, nil
}
func (service *fakeHTTPAdmin) Audit(_ context.Context, query adminservice.AuditQuery) (adminservice.AuditPage, error) {
	service.auditQuery = query
	return adminservice.AuditPage{Items: []adminservice.AuditEvent{{Action: "license.revoke", Outcome: "succeeded"}}}, nil
}
func (*fakeHTTPAdmin) ShowMapping(_ context.Context, inventoryID string) (adminservice.MappingSummary, error) {
	return adminservice.MappingSummary{InventoryID: inventoryID, BaseURLHost: "api.example.test", DefaultModel: "model-a", AllowedModels: []string{"model-a"}, RequestsPerMinute: 60, ConcurrentRequests: 2, KeyVersion: "kms-v1", Status: "configured"}, nil
}
func (service *fakeHTTPAdmin) MutateDeviceToken(_ context.Context, mutation adminservice.DeviceTokenMutation) (adminservice.DeviceTokenResult, error) {
	service.token = mutation
	return adminservice.DeviceTokenResult{LicenseID: mutation.LicenseID, Status: string(mutation.Action)}, nil
}

func TestAdminHTTPRequiresIndependentBearerAndStrictJSON(t *testing.T) {
	service := &fakeHTTPAdmin{}
	handler := NewAdminHandler(AdminHandlerOptions{Service: service, Operators: httpOperators(strings.Repeat("a", 32))})
	body := `{"operatorId":"operator_fixture","requestId":"request_fixture_001","idempotencyKey":"admin-fixture-001","reason":"support","confirmTarget":"` + adminservice.TargetDigest("lic_fixture_001") + `"}`
	for _, test := range []struct {
		name, authorization, payload string
		want                         int
	}{
		{"missing bearer", "", body, http.StatusUnauthorized},
		{"wrong bearer", "Bearer " + strings.Repeat("b", 32), body, http.StatusUnauthorized},
		{"unknown field", "Bearer " + strings.Repeat("a", 32), strings.TrimSuffix(body, "}") + `,"extra":true}`, http.StatusBadRequest},
		{"valid", "Bearer " + strings.Repeat("a", 32), body, http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/internal/v1/licenses/lic_fixture_001/revoke", bytes.NewBufferString(test.payload))
			request.Header.Set("Content-Type", "application/json")
			if test.authorization != "" {
				request.Header.Set("Authorization", test.authorization)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestAdminHTTPExposesSeparateRoutes(t *testing.T) {
	handler := NewAdminHandler(AdminHandlerOptions{Service: &fakeHTTPAdmin{}, Operators: httpOperators(strings.Repeat("a", 32))})
	for _, target := range []string{"/internal/v1/inventory/inv_fixture_001", "/internal/v1/audit"} {
		request := httptest.NewRequest(http.MethodGet, target, nil)
		request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", target, response.Code, response.Body.String())
		}
	}
}

func TestAdminHTTPDecodesOpaqueAuditCursorAndRejectsInvalidCursor(t *testing.T) {
	service := &fakeHTTPAdmin{}
	handler := NewAdminHandler(AdminHandlerOptions{Service: service, Operators: httpOperators(strings.Repeat("a", 32))})
	want := adminservice.AuditCursor{CreatedAt: time.Date(2026, 8, 13, 1, 2, 3, 0, time.UTC), EventID: "00000000-0000-4000-8000-000000000001"}
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/audit?limit=25&before="+adminservice.EncodeAuditCursor(want), nil)
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.auditQuery.Before == nil || !service.auditQuery.Before.CreatedAt.Equal(want.CreatedAt) || service.auditQuery.Before.EventID != want.EventID {
		t.Fatalf("status=%d query=%+v body=%s", response.Code, service.auditQuery, response.Body.String())
	}
	invalid := httptest.NewRequest(http.MethodGet, "/internal/v1/audit?before=not-base64", nil)
	invalid.Header = request.Header.Clone()
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid status=%d body=%s", invalidResponse.Code, invalidResponse.Body.String())
	}
}

func TestAdminHTTPBalanceStatusUsesDesignedPatchRoute(t *testing.T) {
	handler := NewAdminHandler(AdminHandlerOptions{Service: &fakeHTTPAdmin{}, Operators: httpOperators(strings.Repeat("a", 32))})
	body := `{"operatorId":"operator_fixture","requestId":"request_fixture_001","idempotencyKey":"admin-fixture-001","reason":"balance provisioned","balanceStatus":"configured"}`
	request := httptest.NewRequest(http.MethodPatch, "/internal/v1/new-api-bindings/dev_fixture_001/balance-status", bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	old := httptest.NewRequest(http.MethodPost, "/internal/v1/new-api-bindings/dev_fixture_001/mark-configured", bytes.NewBufferString(body))
	old.Header = request.Header.Clone()
	oldResponse := httptest.NewRecorder()
	handler.ServeHTTP(oldResponse, old)
	if oldResponse.Code != http.StatusNotFound {
		t.Fatalf("old route status=%d", oldResponse.Code)
	}
}

func TestAdminHTTPPublishesVerifiedReleaseAndForwardRollback(t *testing.T) {
	now := time.Date(2026, 8, 21, 1, 5, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := releaseauth.NewVerifier("release-gate-2026-01", publicKey, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	releases := &fakeReleaseAdmin{}
	handler := NewAdminHandler(AdminHandlerOptions{Service: &fakeHTTPAdmin{}, Release: releases, ReleaseAuthorization: verifier, Operators: httpOperators(strings.Repeat("a", 32))})
	proof := releaseAuthorizationFixture(now, 107)
	proof.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, releaseauth.SigningPayload(proof)))
	for _, test := range []struct {
		path           string
		contentVersion any
	}{
		{"/internal/v1/releases/publish", "1.7.0"},
		{"/internal/v1/releases/forward-rollback", nil},
	} {
		payload := map[string]any{"operatorId": "operator_fixture", "requestId": "request_fixture_001", "idempotencyKey": "release-fixture-001", "reason": "release operation", "releaseSequence": 107, "releaseId": "release-107", "manifestUrl": proof.ManifestURL, "manifestSha256": proof.ManifestSHA256, "authorization": proof}
		if test.contentVersion != nil {
			payload["contentVersion"] = test.contentVersion
		}
		encoded, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		request := httptest.NewRequest(http.MethodPost, test.path, bytes.NewReader(encoded))
		request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"policyEpoch"`) {
			t.Fatalf("%s status=%d body=%s", test.path, response.Code, response.Body.String())
		}
	}
	if releases.published.ContentVersion != "1.7.0" || releases.rollback.ContentVersion != "" {
		t.Fatalf("publish=%+v rollback=%+v", releases.published, releases.rollback)
	}
}

func TestAdminHTTPRejectsAdminBearerWithoutValidReleaseAuthorization(t *testing.T) {
	now := time.Date(2026, 8, 21, 1, 5, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := releaseauth.NewVerifier("release-gate-2026-01", publicKey, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAdminHandler(AdminHandlerOptions{Service: &fakeHTTPAdmin{}, Release: &fakeReleaseAdmin{}, ReleaseAuthorization: verifier, Operators: httpOperators(strings.Repeat("a", 32))})
	valid := releaseAuthorizationFixture(now, 107)
	valid.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, releaseauth.SigningPayload(valid)))
	for _, test := range []struct {
		name  string
		proof any
	}{
		{name: "missing proof", proof: nil},
		{name: "bad signature", proof: func() releaseauth.Authorization {
			value := valid
			value.Signature.Value = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
			return value
		}()},
		{name: "wrong key id", proof: func() releaseauth.Authorization { value := valid; value.Signature.KeyID = "wrong-key"; return value }()},
		{name: "wrong sequence", proof: func() releaseauth.Authorization { value := valid; value.RequiredReleaseSequence++; return value }()},
		{name: "wrong digest", proof: func() releaseauth.Authorization {
			value := valid
			value.ManifestSHA256 = strings.Repeat("f", 64)
			return value
		}()},
		{name: "expired", proof: func() releaseauth.Authorization {
			value := valid
			value.IssuedAt = now.Add(-11 * time.Minute).Format(time.RFC3339)
			value.ExpiresAt = now.Format(time.RFC3339)
			value.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, releaseauth.SigningPayload(value)))
			return value
		}()},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"operatorId": "operator_fixture", "requestId": "request_fixture_001", "idempotencyKey": "release-fixture-001", "reason": "release operation", "releaseSequence": 107, "releaseId": "release-107", "contentVersion": "1.7.0", "manifestUrl": valid.ManifestURL, "manifestSha256": valid.ManifestSHA256}
			if test.proof != nil {
				payload["authorization"] = test.proof
			}
			encoded, _ := json.Marshal(payload)
			request := httptest.NewRequest(http.MethodPost, "/internal/v1/releases/publish", bytes.NewReader(encoded))
			request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func releaseAuthorizationFixture(now time.Time, sequence uint64) releaseauth.Authorization {
	releaseID := "release-107"
	baseURL := "https://cdn.example.test/releases/" + releaseID + "/"
	artifacts := map[string]releaseauth.Artifact{
		"inventory.json":        {Bytes: 11, SHA256: strings.Repeat("a", 64)},
		"runtime-manifest.json": {Bytes: 12, SHA256: strings.Repeat("b", 64)},
		"runtime-tree.sha256":   {Bytes: 13, SHA256: strings.Repeat("c", 64)},
		"runtime.pkg":           {Bytes: 14, SHA256: strings.Repeat("d", 64)},
		"sbom.spdx.json":        {Bytes: 15, SHA256: strings.Repeat("e", 64)},
	}
	readback := make(map[string]releaseauth.Artifact, len(artifacts))
	for name, artifact := range artifacts {
		artifact.URL = baseURL + name
		readback[name] = artifact
	}
	return releaseauth.Authorization{SchemaVersion: 1, Allowed: true, Gate: "cdn-readback-complete", ReleaseID: releaseID, RequiredReleaseSequence: sequence, CommitSHA: strings.Repeat("a", 40), ManifestURL: baseURL + "runtime-manifest.json", ManifestSHA256: artifacts["runtime-manifest.json"].SHA256, RuntimeSHA256: artifacts["runtime.pkg"].SHA256, Artifacts: artifacts, CDNReadback: readback, Evidence: releaseauth.Evidence{BuildCompletedAt: now.Add(-5 * time.Minute).Format(time.RFC3339), FinalRuntimeSmokeCompletedAt: now.Add(-4 * time.Minute).Format(time.RFC3339), PromotionsCompletedAt: now.Add(-3 * time.Minute).Format(time.RFC3339), UploadCompletedAt: now.Add(-2 * time.Minute).Format(time.RFC3339), CDNReadbackCompletedAt: now.Add(-time.Minute).Format(time.RFC3339)}, IssuedAt: now.Add(-30 * time.Second).Format(time.RFC3339), ExpiresAt: now.Add(9*time.Minute + 30*time.Second).Format(time.RFC3339), Signature: releaseauth.Signature{Algorithm: "ed25519", KeyID: "release-gate-2026-01"}}
}

func TestAdminHTTPShowsRedactedMappingAndControlsDeviceToken(t *testing.T) {
	service := &fakeHTTPAdmin{}
	handler := NewAdminHandler(AdminHandlerOptions{Service: service, Operators: httpOperators(strings.Repeat("a", 32))})
	show := httptest.NewRequest(http.MethodGet, "/internal/v1/new-api-bindings/00000000-0000-4000-8000-000000000001", nil)
	show.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
	showResponse := httptest.NewRecorder()
	handler.ServeHTTP(showResponse, show)
	if showResponse.Code != http.StatusOK || strings.Contains(showResponse.Body.String(), "apiKey") || strings.Contains(showResponse.Body.String(), "envelope") || !strings.Contains(showResponse.Body.String(), "api.example.test") {
		t.Fatalf("status=%d body=%s", showResponse.Code, showResponse.Body.String())
	}
	licenseID := "00000000-0000-4000-8000-000000000003"
	body := `{"operatorId":"operator_fixture","requestId":"request_fixture_001","idempotencyKey":"admin-fixture-001","reason":"support","confirmTarget":"` + adminservice.TargetDigest(licenseID) + `"}`
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/device-tokens/"+licenseID+"/disable", bytes.NewBufferString(body))
	request.Header = show.Header.Clone()
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.token.Action != adminservice.DeviceTokenDisable {
		t.Fatalf("status=%d mutation=%+v body=%s", response.Code, service.token, response.Body.String())
	}
	reissue := httptest.NewRequest(http.MethodPost, "/internal/v1/device-tokens/"+licenseID+"/reissue", bytes.NewBufferString(body))
	reissue.Header = request.Header.Clone()
	reissueResponse := httptest.NewRecorder()
	handler.ServeHTTP(reissueResponse, reissue)
	if reissueResponse.Code != http.StatusNotFound {
		t.Fatalf("reissue route status=%d", reissueResponse.Code)
	}
}
