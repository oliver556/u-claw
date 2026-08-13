package transport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	adminservice "u-claw-activation-server/internal/admin"
)

func httpOperators(secret string) adminservice.OperatorRegistry {
	sum := sha256.Sum256([]byte(secret))
	return adminservice.OperatorRegistry{"operator_fixture": sum}
}

type fakeHTTPAdmin struct {
	mutation   adminservice.Mutation
	auditQuery adminservice.AuditQuery
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
