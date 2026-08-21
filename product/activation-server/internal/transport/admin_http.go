package transport

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	adminservice "u-claw-activation-server/internal/admin"
	"u-claw-activation-server/internal/policy"
	"u-claw-activation-server/internal/releaseauth"
)

type ReleasePolicyAdmin interface {
	Publish(context.Context, policy.Release) (policy.ProductionState, error)
	ForwardRollback(context.Context, policy.Release) (policy.ProductionState, error)
}

type AdminService interface {
	Generate(context.Context, adminservice.GenerateInput) ([]adminservice.InventorySummary, error)
	Import(context.Context, adminservice.ImportInput) ([]adminservice.InventorySummary, error)
	Show(context.Context, adminservice.InventoryLocator) (adminservice.InventorySummary, error)
	MutateLicense(context.Context, adminservice.Mutation) (adminservice.MutationResult, error)
	MarkConfigured(context.Context, adminservice.InventoryLocator, adminservice.Operation) (adminservice.InventorySummary, error)
	Audit(context.Context, adminservice.AuditQuery) (adminservice.AuditPage, error)
	ShowMapping(context.Context, string) (adminservice.MappingSummary, error)
	MutateDeviceToken(context.Context, adminservice.DeviceTokenMutation) (adminservice.DeviceTokenResult, error)
}

type AdminHandlerOptions struct {
	Service              AdminService
	Operators            adminservice.OperatorRegistry
	Release              ReleasePolicyAdmin
	ReleaseAuthorization *releaseauth.Verifier
}

type adminHandler struct {
	service              AdminService
	operators            adminservice.OperatorRegistry
	release              ReleasePolicyAdmin
	releaseAuthorization *releaseauth.Verifier
	mux                  *http.ServeMux
}

type adminOperationRequest struct {
	OperatorID     string `json:"operatorId"`
	RequestID      string `json:"requestId"`
	IdempotencyKey string `json:"idempotencyKey"`
	Reason         string `json:"reason"`
	ConfirmTarget  string `json:"confirmTarget,omitempty"`
}
type adminGenerateRequest struct {
	adminOperationRequest
	Count int `json:"count"`
}
type adminImportRecordRequest struct {
	Username       string `json:"username"`
	ActivationCode string `json:"activationCode"`
	NewAPIUserID   string `json:"newApiUserId"`
	NewAPIUsername string `json:"newApiUsername"`
	PolicyDigest   string `json:"policyDigest"`
}
type adminImportRequest struct {
	adminOperationRequest
	Records []adminImportRecordRequest `json:"records"`
}
type adminBalanceStatusRequest struct {
	adminOperationRequest
	BalanceStatus string `json:"balanceStatus"`
}
type adminReleaseRequest struct {
	adminOperationRequest
	ReleaseSequence uint64                    `json:"releaseSequence"`
	ReleaseID       string                    `json:"releaseId"`
	ContentVersion  string                    `json:"contentVersion,omitempty"`
	ManifestURL     string                    `json:"manifestUrl"`
	ManifestSHA256  string                    `json:"manifestSha256"`
	Authorization   releaseauth.Authorization `json:"authorization"`
}
type releaseSlotResponse struct {
	ReleaseSequence uint64 `json:"releaseSequence"`
	ReleaseID       string `json:"releaseId"`
	ContentVersion  string `json:"contentVersion"`
	Reason          string `json:"reason"`
	Status          string `json:"status"`
}
type productionSlotsResponse struct {
	PolicyEpoch    uint64               `json:"policyEpoch"`
	Current        releaseSlotResponse  `json:"current"`
	PreviousStable *releaseSlotResponse `json:"previousStable"`
}

type inventorySecretResponse struct {
	InventoryID    string `json:"inventoryId"`
	Username       string `json:"username"`
	ActivationCode string `json:"activationCode"`
}

type reissueResponse struct {
	LicenseID              string  `json:"licenseId"`
	Status                 string  `json:"status"`
	Revision               int64   `json:"revision"`
	ReplacementInventoryID *string `json:"replacementInventoryId"`
	Username               string  `json:"username"`
	ActivationCode         string  `json:"activationCode"`
}
type inventorySummaryResponse struct {
	InventoryID       string  `json:"inventoryId"`
	Username          string  `json:"username"`
	Status            string  `json:"status"`
	NewAPISetupStatus string  `json:"newApiSetupStatus"`
	DeviceID          *string `json:"deviceId"`
	LicenseID         *string `json:"licenseId"`
}
type mutationResponse struct {
	LicenseID              string  `json:"licenseId"`
	Status                 string  `json:"status"`
	Revision               int64   `json:"revision"`
	ReplacementInventoryID *string `json:"replacementInventoryId"`
}
type auditEventResponse struct {
	EventID        string  `json:"eventId"`
	ActorID        string  `json:"actorId"`
	Action         string  `json:"action"`
	Outcome        string  `json:"outcome"`
	InventoryID    *string `json:"inventoryId"`
	DeviceID       *string `json:"deviceId"`
	LicenseID      *string `json:"licenseId"`
	RequestID      string  `json:"requestId"`
	Reason         *string `json:"reason"`
	IdempotencyKey *string `json:"idempotencyKey"`
	CreatedAt      string  `json:"createdAt"`
}
type auditPageResponse struct {
	Items      []auditEventResponse `json:"items"`
	NextBefore *string              `json:"nextBefore"`
}

func (request adminOperationRequest) operation(operatorID string) adminservice.Operation {
	return adminservice.Operation{OperatorID: operatorID, RequestID: request.RequestID, IdempotencyKey: request.IdempotencyKey, Reason: request.Reason}
}

func NewAdminHandler(options AdminHandlerOptions) http.Handler {
	handler := &adminHandler{service: options.Service, operators: options.Operators, release: options.Release, releaseAuthorization: options.ReleaseAuthorization, mux: http.NewServeMux()}
	handler.mux.HandleFunc("POST /internal/v1/inventory", handler.generate)
	handler.mux.HandleFunc("POST /internal/v1/inventory/import", handler.importInventory)
	handler.mux.HandleFunc("GET /internal/v1/inventory/{id}", handler.show)
	for _, action := range []adminservice.Action{adminservice.ActionDisable, adminservice.ActionEnable, adminservice.ActionRevoke, adminservice.ActionReissue} {
		handler.mux.HandleFunc("POST /internal/v1/licenses/{id}/"+string(action), handler.mutate(action))
	}
	handler.mux.HandleFunc("PATCH /internal/v1/new-api-bindings/{deviceId}/balance-status", handler.markConfigured)
	handler.mux.HandleFunc("GET /internal/v1/new-api-bindings/{inventoryId}", handler.showMapping)
	for _, action := range []adminservice.DeviceTokenAction{adminservice.DeviceTokenDisable, adminservice.DeviceTokenEnable, adminservice.DeviceTokenRevoke} {
		handler.mux.HandleFunc("POST /internal/v1/device-tokens/{licenseId}/"+string(action), handler.mutateDeviceToken(action))
	}
	handler.mux.HandleFunc("GET /internal/v1/audit", handler.audit)
	handler.mux.HandleFunc("POST /internal/v1/releases/publish", handler.publishRelease)
	handler.mux.HandleFunc("POST /internal/v1/releases/forward-rollback", handler.forwardRollback)
	return handler
}

func (handler *adminHandler) publishRelease(writer http.ResponseWriter, request *http.Request) {
	handler.changeRelease(writer, request, false)
}

func (handler *adminHandler) forwardRollback(writer http.ResponseWriter, request *http.Request) {
	handler.changeRelease(writer, request, true)
}

func (handler *adminHandler) changeRelease(writer http.ResponseWriter, request *http.Request, rollback bool) {
	var input adminReleaseRequest
	if decodeRequest(writer, request, &input) != nil {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	if _, ok := authenticatedOperator(request, input.OperatorID); !ok {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	if handler.release == nil || handler.releaseAuthorization == nil {
		handler.writeError(writer, policy.ErrUnavailable)
		return
	}
	if handler.releaseAuthorization.Verify(input.Authorization, releaseauth.ExpectedRelease{ReleaseSequence: input.ReleaseSequence, ReleaseID: input.ReleaseID, ManifestURL: input.ManifestURL, ManifestSHA256: input.ManifestSHA256}) != nil {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	release := policy.Release{ReleaseSequence: input.ReleaseSequence, ReleaseID: input.ReleaseID, ContentVersion: input.ContentVersion, ManifestURL: input.ManifestURL, ManifestSHA256: input.ManifestSHA256, ManifestReadbackVerified: true, CDNAvailable: true}
	var state policy.ProductionState
	var err error
	if rollback {
		state, err = handler.release.ForwardRollback(request.Context(), release)
	} else {
		state, err = handler.release.Publish(request.Context(), release)
	}
	if err != nil {
		handler.writeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, productionSlots(state))
}

func productionSlots(state policy.ProductionState) productionSlotsResponse {
	response := productionSlotsResponse{PolicyEpoch: state.PolicyEpoch}
	if state.Current != nil {
		response.Current = releaseSlot(*state.Current)
	}
	if state.PreviousStable != nil {
		previous := releaseSlot(*state.PreviousStable)
		response.PreviousStable = &previous
	}
	return response
}

func releaseSlot(release policy.Release) releaseSlotResponse {
	return releaseSlotResponse{ReleaseSequence: release.ReleaseSequence, ReleaseID: release.ReleaseID, ContentVersion: release.ContentVersion, Reason: release.Reason, Status: release.Status}
}

func (handler *adminHandler) showMapping(writer http.ResponseWriter, request *http.Request) {
	result, err := handler.service.ShowMapping(request.Context(), request.PathValue("inventoryId"))
	if err != nil {
		handler.writeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}
func (handler *adminHandler) mutateDeviceToken(action adminservice.DeviceTokenAction) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input adminOperationRequest
		if decodeRequest(writer, request, &input) != nil {
			handler.writeError(writer, adminservice.ErrInvalidInput)
			return
		}
		operatorID, ok := authenticatedOperator(request, input.OperatorID)
		if !ok {
			handler.writeError(writer, adminservice.ErrInvalidInput)
			return
		}
		licenseID := request.PathValue("licenseId")
		result, err := handler.service.MutateDeviceToken(request.Context(), adminservice.DeviceTokenMutation{Action: action, LicenseID: licenseID, ConfirmTarget: input.ConfirmTarget, Operation: input.operation(operatorID)})
		if err != nil {
			handler.writeError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	}
}

func (handler *adminHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	secret, ok := bearerSecret(request.Header.Values("Authorization"))
	operatorID, authenticated := handler.operators.Authenticate(secret)
	if !ok || !authenticated {
		writeJSON(writer, http.StatusUnauthorized, map[string]string{"code": "ADMIN_AUTHENTICATION_FAILED"})
		return
	}
	if handler.service == nil {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"code": "ADMIN_SERVICE_UNAVAILABLE"})
		return
	}
	handler.mux.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), operatorContextKey{}, operatorID)))
}

type operatorContextKey struct{}

func authenticatedOperator(request *http.Request, claimed string) (string, bool) {
	operatorID, ok := request.Context().Value(operatorContextKey{}).(string)
	return operatorID, ok && operatorID != "" && claimed == operatorID
}

func (handler *adminHandler) generate(writer http.ResponseWriter, request *http.Request) {
	var input adminGenerateRequest
	if decodeRequest(writer, request, &input) != nil {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	operatorID, ok := authenticatedOperator(request, input.OperatorID)
	if !ok {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	result, err := handler.service.Generate(request.Context(), adminservice.GenerateInput{Count: input.Count, Operation: input.operation(operatorID)})
	if err != nil {
		handler.writeError(writer, err)
		return
	}
	secrets := make([]inventorySecretResponse, len(result))
	for index, item := range result {
		secrets[index] = inventorySecretResponse{InventoryID: item.InventoryID, Username: item.Username, ActivationCode: item.ActivationCode}
	}
	writeJSON(writer, http.StatusCreated, secrets)
}

func (handler *adminHandler) importInventory(writer http.ResponseWriter, request *http.Request) {
	var input adminImportRequest
	if decodeRequest(writer, request, &input) != nil {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	operatorID, ok := authenticatedOperator(request, input.OperatorID)
	if !ok {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	records := make([]adminservice.ImportRecord, len(input.Records))
	for index, item := range input.Records {
		records[index] = adminservice.ImportRecord{Username: item.Username, ActivationCode: item.ActivationCode, NewAPIUserID: item.NewAPIUserID, NewAPIUsername: item.NewAPIUsername, PolicyDigest: item.PolicyDigest}
	}
	result, err := handler.service.Import(request.Context(), adminservice.ImportInput{Records: records, Operation: input.operation(operatorID)})
	if err != nil {
		handler.writeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, inventorySummaries(result))
}

func (handler *adminHandler) show(writer http.ResponseWriter, request *http.Request) {
	result, err := handler.service.Show(request.Context(), adminservice.InventoryLocator{InventoryID: request.PathValue("id")})
	if err != nil {
		handler.writeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, inventorySummary(result))
}

func (handler *adminHandler) mutate(action adminservice.Action) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input adminOperationRequest
		if decodeRequest(writer, request, &input) != nil {
			handler.writeError(writer, adminservice.ErrInvalidInput)
			return
		}
		operatorID, ok := authenticatedOperator(request, input.OperatorID)
		if !ok {
			handler.writeError(writer, adminservice.ErrInvalidInput)
			return
		}
		licenseID := request.PathValue("id")
		if input.ConfirmTarget != adminservice.TargetDigest(licenseID) {
			handler.writeError(writer, adminservice.ErrInvalidInput)
			return
		}
		result, err := handler.service.MutateLicense(request.Context(), adminservice.Mutation{Action: action, LicenseID: licenseID, ConfirmTarget: input.ConfirmTarget, Operation: input.operation(operatorID)})
		if err != nil {
			handler.writeError(writer, err)
			return
		}
		if action == adminservice.ActionReissue {
			writeJSON(writer, http.StatusOK, reissueResponse{LicenseID: result.LicenseID, Status: result.Status, Revision: result.Revision, ReplacementInventoryID: result.ReplacementInventoryID, Username: result.ReplacementUsername, ActivationCode: result.ReplacementActivationCode})
			return
		}
		writeJSON(writer, http.StatusOK, mutationResponse{LicenseID: result.LicenseID, Status: result.Status, Revision: result.Revision, ReplacementInventoryID: result.ReplacementInventoryID})
	}
}

func (handler *adminHandler) markConfigured(writer http.ResponseWriter, request *http.Request) {
	var input adminBalanceStatusRequest
	if decodeRequest(writer, request, &input) != nil {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	if input.BalanceStatus != "configured" {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	operatorID, ok := authenticatedOperator(request, input.OperatorID)
	if !ok {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	result, err := handler.service.MarkConfigured(request.Context(), adminservice.InventoryLocator{DeviceID: request.PathValue("deviceId")}, input.operation(operatorID))
	if err != nil {
		handler.writeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, inventorySummary(result))
}

func (handler *adminHandler) audit(writer http.ResponseWriter, request *http.Request) {
	limit := 100
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			handler.writeError(writer, adminservice.ErrInvalidInput)
			return
		}
		limit = parsed
	}
	if len(request.URL.Query()) > 2 || (request.URL.Query().Has("before") && strings.TrimSpace(request.URL.Query().Get("before")) == "") {
		handler.writeError(writer, adminservice.ErrInvalidInput)
		return
	}
	var before *adminservice.AuditCursor
	if raw := request.URL.Query().Get("before"); raw != "" {
		cursor, decodeErr := adminservice.DecodeAuditCursor(raw)
		if decodeErr != nil {
			handler.writeError(writer, decodeErr)
			return
		}
		before = &cursor
	}
	result, err := handler.service.Audit(request.Context(), adminservice.AuditQuery{Limit: limit, Before: before})
	if err != nil {
		handler.writeError(writer, err)
		return
	}
	responses := make([]auditEventResponse, len(result.Items))
	for index, item := range result.Items {
		responses[index] = auditEventResponse{item.EventID, item.ActorID, item.Action, item.Outcome, item.InventoryID, item.DeviceID, item.LicenseID, item.RequestID, item.Reason, item.IdempotencyKey, item.CreatedAt}
	}
	writeJSON(writer, http.StatusOK, auditPageResponse{Items: responses, NextBefore: result.NextBefore})
}

func inventorySummary(item adminservice.InventorySummary) inventorySummaryResponse {
	return inventorySummaryResponse{item.InventoryID, item.Username, item.Status, item.NewAPISetupStatus, item.DeviceID, item.LicenseID}
}
func inventorySummaries(items []adminservice.InventorySummary) []inventorySummaryResponse {
	result := make([]inventorySummaryResponse, len(items))
	for i, item := range items {
		result[i] = inventorySummary(item)
	}
	return result
}

func (handler *adminHandler) writeError(writer http.ResponseWriter, err error) {
	if errors.Is(err, policy.ErrUnavailable) {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"code": "RELEASE_POLICY_UNAVAILABLE"})
		return
	}
	if errors.Is(err, adminservice.ErrInvalidInput) || errors.Is(err, policy.ErrInvalidRelease) || errors.Is(err, policy.ErrArtifactUnavailable) || errors.Is(err, policy.ErrSequenceRegression) || errors.Is(err, policy.ErrPreviousStableUnavailable) {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"code": "ADMIN_INVALID"})
		return
	}
	writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"code": "ADMIN_SERVICE_UNAVAILABLE"})
}
