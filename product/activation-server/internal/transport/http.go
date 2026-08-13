package transport

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"u-claw-activation-server/internal/activation"
	"u-claw-activation-server/internal/lifecycle"
	"u-claw-activation-server/internal/policy"
)

const maximumRequestBodyBytes = 1 << 20
const operationTimeout = 5 * time.Second

type ActivationService interface {
	Activate(context.Context, activation.ActivateInput) (activation.ActivateResult, error)
	Commit(context.Context, activation.CommitInput) error
}

type LifecycleService interface {
	Status(context.Context, string, string) (lifecycle.Response, error)
	Recover(context.Context, lifecycle.RecoverInput) ([]byte, error)
	DeviceToken(context.Context, lifecycle.DeviceTokenInput) (lifecycle.DeviceTokenResponse, error)
}

type PublicHandlerOptions struct {
	Activation ActivationService
	Lifecycle  LifecycleService
	RequestIDs io.Reader
}

type publicHandler struct {
	activation ActivationService
	lifecycle  LifecycleService
	requestIDs io.Reader
}

func NewPublicHandler(options PublicHandlerOptions) http.Handler {
	randomSource := options.RequestIDs
	if randomSource == nil {
		randomSource = rand.Reader
	}
	return &publicHandler{activation: options.Activation, lifecycle: options.Lifecycle, requestIDs: randomSource}
}

func (handler *publicHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	requestID := handler.newRequestID()
	writer.Header().Set("X-Request-ID", requestID)
	switch {
	case request.Method == http.MethodPost && request.URL.Path == "/v1/activations":
		handler.activate(writer, request, requestID)
	case request.Method == http.MethodPost && strings.HasPrefix(request.URL.Path, "/v1/activations/") && strings.HasSuffix(request.URL.Path, "/commit"):
		handler.commit(writer, request, requestID)
	case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/v1/licenses/") && strings.HasSuffix(request.URL.Path, "/status"):
		handler.status(writer, request, requestID)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/client-policy":
		writeJSON(writer, http.StatusOK, policy.ProductionClientPolicy())
	case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/v1/activations/"):
		handler.recover(writer, request, requestID)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/device-tokens":
		handler.deviceToken(writer, request, requestID)
	default:
		handler.writeError(writer, requestID, "", nil, errNotFound)
	}
}

func (handler *publicHandler) recover(writer http.ResponseWriter, request *http.Request, requestID string) {
	activationID := strings.TrimPrefix(request.URL.Path, "/v1/activations/")
	if activationID == "" || strings.Contains(activationID, "/") {
		handler.writeError(writer, requestID, "", nil, errNotFound)
		return
	}
	secret, ok := bearerSecret(request.Header.Values("Authorization"))
	if !ok {
		handler.writeError(writer, requestID, "", nil, lifecycle.ErrAuthentication)
		return
	}
	if handler.lifecycle == nil {
		handler.writeError(writer, requestID, "", nil, lifecycle.ErrUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), operationTimeout)
	defer cancel()
	material, err := handler.lifecycle.Recover(ctx, lifecycle.RecoverInput{ActivationID: activationID, StartupSecret: secret, RequestID: requestID})
	if err != nil {
		handler.writeError(writer, requestID, activationID, nil, err)
		return
	}
	writeRawJSON(writer, http.StatusOK, material)
}

type deviceTokenRequest struct {
	DeviceID       string `json:"deviceId"`
	LicenseID      string `json:"licenseId"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func (handler *publicHandler) deviceToken(writer http.ResponseWriter, request *http.Request, requestID string) {
	secret, ok := bearerSecret(request.Header.Values("Authorization"))
	if !ok {
		handler.writeError(writer, requestID, "", nil, lifecycle.ErrAuthentication)
		return
	}
	var input deviceTokenRequest
	if err := decodeRequest(writer, request, &input); err != nil {
		handler.writeError(writer, requestID, "", nil, err)
		return
	}
	if handler.lifecycle == nil {
		handler.writeError(writer, requestID, "", nil, lifecycle.ErrUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), operationTimeout)
	defer cancel()
	response, err := handler.lifecycle.DeviceToken(ctx, lifecycle.DeviceTokenInput{DeviceID: input.DeviceID, LicenseID: input.LicenseID, IdempotencyKey: input.IdempotencyKey, StartupSecret: secret})
	if err != nil {
		handler.writeError(writer, requestID, "", nil, err)
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

type activationRequest struct {
	Username       string `json:"username"`
	ActivationCode string `json:"activationCode"`
	USBFingerprint struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	} `json:"usbFingerprint"`
	ClientVersion  string `json:"clientVersion"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func (handler *publicHandler) activate(writer http.ResponseWriter, request *http.Request, requestID string) {
	var input activationRequest
	if err := decodeRequest(writer, request, &input); err != nil {
		handler.writeError(writer, requestID, "", nil, err)
		return
	}
	if handler.activation == nil {
		handler.writeError(writer, requestID, "", nil, activation.ErrActivationServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), operationTimeout)
	defer cancel()
	result, err := handler.activation.Activate(ctx, activation.ActivateInput{Username: input.Username, ActivationCode: input.ActivationCode, FingerprintVersion: input.USBFingerprint.Version, FingerprintSHA256: input.USBFingerprint.SHA256, ClientVersion: input.ClientVersion, IdempotencyKey: input.IdempotencyKey, RequestID: requestID})
	if err != nil {
		handler.writeError(writer, requestID, result.ActivationID, nil, err)
		return
	}
	writeRawJSON(writer, http.StatusOK, result.Material)
}

type commitRequest struct {
	IdempotencyKey     string `json:"idempotencyKey"`
	ArtifactGeneration int64  `json:"artifactGeneration"`
}

func (handler *publicHandler) commit(writer http.ResponseWriter, request *http.Request, requestID string) {
	// Frozen OpenAPI intentionally defines commit without BearerAuth. It only advances
	// a server_bound attempt and never returns activation material.
	activationID := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/v1/activations/"), "/commit")
	if activationID == "" || strings.Contains(activationID, "/") {
		handler.writeError(writer, requestID, "", nil, errNotFound)
		return
	}
	var input commitRequest
	if err := decodeRequest(writer, request, &input); err != nil {
		handler.writeError(writer, requestID, activationID, nil, err)
		return
	}
	if handler.activation == nil {
		handler.writeError(writer, requestID, activationID, nil, activation.ErrActivationServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), operationTimeout)
	defer cancel()
	err := handler.activation.Commit(ctx, activation.CommitInput{ActivationID: activationID, IdempotencyKey: input.IdempotencyKey, ArtifactGeneration: input.ArtifactGeneration, RequestID: requestID})
	if err != nil {
		stage := "server_bound"
		handler.writeError(writer, requestID, activationID, &stage, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (handler *publicHandler) status(writer http.ResponseWriter, request *http.Request, requestID string) {
	licenseID := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/v1/licenses/"), "/status")
	if licenseID == "" || strings.Contains(licenseID, "/") {
		handler.writeError(writer, requestID, "", nil, errNotFound)
		return
	}
	secret, ok := bearerSecret(request.Header.Values("Authorization"))
	if !ok {
		handler.writeError(writer, requestID, "", nil, lifecycle.ErrAuthentication)
		return
	}
	if handler.lifecycle == nil {
		handler.writeError(writer, requestID, "", nil, lifecycle.ErrUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), operationTimeout)
	defer cancel()
	response, err := handler.lifecycle.Status(ctx, licenseID, secret)
	if err != nil {
		handler.writeError(writer, requestID, "", nil, err)
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func decodeRequest(writer http.ResponseWriter, request *http.Request, output any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errInvalidRequest
	}
	if request.ContentLength > maximumRequestBodyBytes {
		return errBodyTooLarge
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maximumRequestBodyBytes)
	content, err := io.ReadAll(request.Body)
	if err != nil {
		var maxError *http.MaxBytesError
		if errors.As(err, &maxError) {
			return errBodyTooLarge
		}
		return errInvalidRequest
	}
	if rejectDuplicateKeys(content) != nil {
		return errInvalidRequest
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return errInvalidRequest
	}
	return nil
}

func rejectDuplicateKeys(content []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var visit func() error
	visit = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return errInvalidRequest
				}
				if _, exists := seen[key]; exists {
					return errInvalidRequest
				}
				seen[key] = struct{}{}
				if err := visit(); err != nil {
					return err
				}
			}
			_, err = decoder.Token()
			return err
		case '[':
			for decoder.More() {
				if err := visit(); err != nil {
					return err
				}
			}
			_, err = decoder.Token()
			return err
		default:
			return errInvalidRequest
		}
	}
	if err := visit(); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errInvalidRequest
	}
	return nil
}

func bearerSecret(values []string) (string, bool) {
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return "", false
	}
	value := strings.TrimPrefix(values[0], "Bearer ")
	return value, value != "" && strings.TrimSpace(value) == value && !strings.ContainsAny(value, " \t\r\n")
}

var (
	errInvalidRequest = errors.New("invalid request")
	errBodyTooLarge   = errors.New("request body too large")
	errNotFound       = errors.New("not found")
)

type publicError struct {
	RequestID    string  `json:"requestId"`
	ActivationID *string `json:"activationId"`
	Code         string  `json:"code"`
	Stage        *string `json:"stage"`
	Retryable    bool    `json:"retryable"`
	SupportCode  string  `json:"supportCode"`
}

func (handler *publicHandler) writeError(writer http.ResponseWriter, requestID, activationID string, stage *string, err error) {
	status, code, retryable, support := projectError(err)
	var activationPointer *string
	if activationID != "" {
		activationPointer = &activationID
	}
	writeJSON(writer, status, publicError{RequestID: requestID, ActivationID: activationPointer, Code: code, Stage: stage, Retryable: retryable, SupportCode: support})
}

func projectError(err error) (int, string, bool, string) {
	switch {
	case errors.Is(err, errBodyTooLarge):
		return http.StatusRequestEntityTooLarge, "ACTIVATION_INVALID", false, "ACT-REQ-002"
	case errors.Is(err, errInvalidRequest):
		return http.StatusBadRequest, "ACTIVATION_INVALID", false, "ACT-REQ-001"
	case errors.Is(err, errNotFound):
		return http.StatusNotFound, "ACTIVATION_NOT_FOUND", false, "ACT-REQ-404"
	case errors.Is(err, lifecycle.ErrAuthentication):
		return http.StatusUnauthorized, "AUTHENTICATION_FAILED", false, "ACT-AUTH-001"
	case errors.Is(err, activation.ErrActivationInvalid):
		return http.StatusBadRequest, "ACTIVATION_INVALID", false, "ACT-INV-001"
	case errors.Is(err, activation.ErrActivationCodeAlreadyBound):
		return http.StatusConflict, "ACTIVATION_CODE_ALREADY_BOUND", false, "ACT-BIND-001"
	case errors.Is(err, activation.ErrIdempotencyConflict):
		return http.StatusConflict, "IDEMPOTENCY_CONFLICT", false, "ACT-IDEM-001"
	case errors.Is(err, activation.ErrActivationInProgress):
		return http.StatusConflict, "ACTIVATION_IN_PROGRESS", true, "ACT-BIND-002"
	case errors.Is(err, activation.ErrNewAPINotConfigured):
		return http.StatusConflict, "BUILTIN_BALANCE_PENDING", false, "ACT-BAL-001"
	default:
		return http.StatusServiceUnavailable, "ACTIVATION_SERVICE_UNAVAILABLE", true, "ACT-SVC-001"
	}
}

func (handler *publicHandler) newRequestID() string {
	value := make([]byte, 16)
	if _, err := io.ReadFull(handler.requestIDs, value); err != nil {
		_, _ = rand.Read(value)
	}
	return "req_" + hex.EncodeToString(value)
}
func writeJSON(writer http.ResponseWriter, status int, value any) {
	encoded, _ := json.Marshal(value)
	writeRawJSON(writer, status, encoded)
}
func writeRawJSON(writer http.ResponseWriter, status int, encoded []byte) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(append(encoded, '\n'))
}
