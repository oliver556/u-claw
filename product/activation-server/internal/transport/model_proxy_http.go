package transport

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"u-claw-activation-server/internal/modelproxy"
)

var (
	modelNamePattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
	proxyIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)
)

const (
	maxSafeInteger          int64 = 9_007_199_254_740_991
	modelsResponseBodyBytes       = 1 << 20
	maximumErrorBodyBytes         = 64 << 10
)

type ModelProxyService interface {
	Authorize(context.Context, string, string, string) (modelproxy.Grant, error)
	Complete(context.Context, modelproxy.Grant, string, string, int, *modelproxy.Usage)
}
type ModelProxyHandlerOptions struct {
	Service           ModelProxyService
	Client            *http.Client
	AllowedHosts      []string
	RequestIDs        io.Reader
	Timeout           time.Duration
	Observer          modelproxy.Observer
	RequestBodyBytes  int64
	ResponseBodyBytes int64
	EnabledModels     []string
}
type modelProxyHandler struct {
	service           ModelProxyService
	client            *http.Client
	allowedHosts      []string
	requestIDs        io.Reader
	timeout           time.Duration
	observer          modelproxy.Observer
	requestBodyBytes  int64
	responseBodyBytes int64
	enabledModels     map[string]struct{}
	requestIDMu       sync.Mutex
	lastRequestID     string
}

func NewModelProxyHandler(o ModelProxyHandlerOptions) http.Handler {
	if o.RequestIDs == nil {
		o.RequestIDs = rand.Reader
	}
	if o.Timeout <= 0 {
		o.Timeout = 60 * time.Second
	}
	if o.RequestBodyBytes <= 0 {
		o.RequestBodyBytes = 1 << 20
	}
	if o.ResponseBodyBytes <= 0 {
		o.ResponseBodyBytes = 4 << 20
	}
	enabledModels := make(map[string]struct{}, len(o.EnabledModels))
	for _, model := range o.EnabledModels {
		enabledModels[model] = struct{}{}
	}
	return &modelProxyHandler{service: o.Service, client: o.Client, allowedHosts: append([]string(nil), o.AllowedHosts...), requestIDs: o.RequestIDs, timeout: o.Timeout, observer: o.Observer, requestBodyBytes: o.RequestBodyBytes, responseBodyBytes: o.ResponseBodyBytes, enabledModels: enabledModels}
}

type chatMessage struct {
	Role       string          `json:"role"`
	Content    *string         `json:"content,omitempty"`
	Name       string          `json:"name,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	ToolCalls  json.RawMessage `json:"tool_calls,omitempty"`
}
type chatRequest struct {
	Model         string          `json:"model"`
	Messages      []chatMessage   `json:"messages"`
	MaxTokens     *int            `json:"max_tokens,omitempty"`
	Stream        *bool           `json:"stream"`
	StreamOptions json.RawMessage `json:"stream_options,omitempty"`
	Tools         json.RawMessage `json:"tools,omitempty"`
	ToolChoice    json.RawMessage `json:"tool_choice,omitempty"`
}

type imageGenerationRequest struct {
	Model          string `json:"model"`
	Prompt         string `json:"prompt"`
	N              *int   `json:"n,omitempty"`
	Quality        string `json:"quality,omitempty"`
	ResponseFormat string `json:"response_format,omitempty"`
	Size           string `json:"size,omitempty"`
	Style          string `json:"style,omitempty"`
}
type tokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

func (h *modelProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID, err := h.requestID()
	if err != nil {
		writeProxyError(w, 503, "REQUEST_ID_UNAVAILABLE", "")
		return
	}
	w.Header().Set("X-Request-ID", requestID)
	route := ""
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/model-api/v1/models":
		route = "models"
	case r.Method == http.MethodPost && r.URL.Path == "/model-api/v1/chat/completions":
		route = "chat"
	case r.Method == http.MethodPost && r.URL.Path == "/model-api/v1/images/generations":
		route = "images.generations"
	case r.Method == http.MethodPost && r.URL.Path == "/model-api/v1/images/edits":
		route = "images.edits"
	default:
		writeProxyError(w, 404, "NOT_FOUND", requestID)
		return
	}
	bearer, ok := strictBearer(r.Header.Values("Authorization"))
	if !ok {
		writeProxyError(w, 401, "AUTHENTICATION_FAILED", requestID)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	r = r.WithContext(ctx)
	var chat chatRequest
	var image imageGenerationRequest
	var upstreamBody []byte
	var upstreamContentType string
	if route == "models" {
		nonempty, readErr := hasGETBody(w, r)
		if readErr != nil || nonempty {
			writeProxyError(w, 400, "INVALID_REQUEST", requestID)
			return
		}
	}
	if route == "chat" {
		if err := decodeModelRequest(w, r, &chat, h.requestBodyBytes); err != nil {
			status := 400
			if errors.Is(err, errBodyTooLarge) {
				status = 413
			}
			writeProxyError(w, status, map[bool]string{true: "REQUEST_TOO_LARGE", false: "INVALID_REQUEST"}[status == 413], requestID)
			return
		}
		if !validChat(chat) {
			writeProxyError(w, 400, "INVALID_REQUEST", requestID)
			return
		}
		upstreamBody, _ = json.Marshal(chat)
		upstreamContentType = "application/json"
	}
	if route == "images.generations" {
		if err := decodeModelRequest(w, r, &image, h.requestBodyBytes); err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, errBodyTooLarge) {
				status = http.StatusRequestEntityTooLarge
			}
			writeProxyError(w, status, map[bool]string{true: "REQUEST_TOO_LARGE", false: "INVALID_REQUEST"}[status == http.StatusRequestEntityTooLarge], requestID)
			return
		}
		if !validImageGeneration(image) {
			writeProxyError(w, http.StatusBadRequest, "INVALID_REQUEST", requestID)
			return
		}
		upstreamBody, _ = json.Marshal(image)
		upstreamContentType = "application/json"
	}
	if route == "images.edits" {
		var parseErr error
		image.Model, upstreamBody, upstreamContentType, parseErr = restrictedImageEdit(w, r, h.requestBodyBytes)
		if parseErr != nil {
			status := http.StatusBadRequest
			if errors.Is(parseErr, errBodyTooLarge) {
				status = http.StatusRequestEntityTooLarge
			}
			writeProxyError(w, status, map[bool]string{true: "REQUEST_TOO_LARGE", false: "INVALID_REQUEST"}[status == http.StatusRequestEntityTooLarge], requestID)
			return
		}
	}
	if h.service == nil || h.client == nil {
		writeProxyError(w, 503, "SERVICE_UNAVAILABLE", requestID)
		return
	}
	model := chat.Model
	if strings.HasPrefix(route, "images.") {
		model = image.Model
	}
	grant, err := h.service.Authorize(ctx, bearer, model, requestID)
	if err != nil {
		status, code := serviceError(err)
		writeProxyError(w, status, code, requestID)
		return
	}
	defer grant.Clear()
	outcome, status, usage := "unavailable", 502, (*modelproxy.Usage)(nil)
	defer func() { h.service.Complete(ctx, grant, route, outcome, status, usage) }()
	if model != "" && !h.modelEnabled(model) {
		outcome, status = "model_not_found", http.StatusNotFound
		writeProxyError(w, status, "MODEL_NOT_FOUND", requestID)
		return
	}
	target, err := modelproxy.ValidateBaseURL(grant.Authorization.BaseURL, h.allowedHosts)
	if err != nil {
		outcome, status = "unavailable", 503
		writeProxyError(w, 503, "SERVICE_UNAVAILABLE", requestID)
		return
	}
	upstreamURL := *target
	upstreamPath := "models"
	switch route {
	case "chat":
		upstreamPath = "chat/completions"
	case "images.generations":
		upstreamPath = "images/generations"
	case "images.edits":
		upstreamPath = "images/edits"
	}
	upstreamURL.Path = path.Join(strings.TrimSuffix(target.Path, "/"), upstreamPath)
	var body io.Reader
	if len(upstreamBody) > 0 {
		body = bytes.NewReader(upstreamBody)
	}
	upstream, _ := http.NewRequestWithContext(ctx, r.Method, upstreamURL.String(), body)
	upstream.Header.Set("Authorization", "Bearer "+string(grant.APIKey))
	upstream.Header.Set("Accept", "application/json")
	if route == "chat" && chat.Stream != nil && *chat.Stream {
		upstream.Header.Set("Accept", "text/event-stream")
	}
	upstream.Header.Set("X-Request-ID", requestID)
	if upstreamContentType != "" {
		upstream.Header.Set("Content-Type", upstreamContentType)
	}
	started := time.Now()
	response, err := h.client.Do(upstream)
	upstream.Header.Del("Authorization")
	if err != nil {
		h.observe("unavailable", started)
		outcome = "unavailable"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
			writeProxyError(w, status, "UPSTREAM_TIMEOUT", requestID)
			return
		}
		status = http.StatusBadGateway
		writeProxyError(w, status, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		errorBody, _ := readBounded(response.Body, maximumErrorBodyBytes)
		mappedStatus, code, mappedOutcome := upstreamError(response.StatusCode, errorBody)
		h.observe(mappedOutcome, started)
		outcome, status = mappedOutcome, mappedStatus
		writeProxyError(w, mappedStatus, code, requestID)
		return
	}
	if route == "chat" && chat.Stream != nil && *chat.Stream {
		if !isEventStream(response.Header.Get("Content-Type")) {
			h.observe("invalid_response", started)
			outcome, status = "invalid_response", http.StatusBadGateway
			writeProxyError(w, status, "UPSTREAM_UNAVAILABLE", requestID)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(response.StatusCode)
		if err := relaySSE(w, response.Body, h.responseBodyBytes); err != nil {
			h.observe("invalid_response", started)
			outcome = "invalid_response"
			return
		}
		outcome, status = "succeeded", response.StatusCode
		h.observe("success", started)
		return
	}
	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		h.observe("invalid_response", started)
		outcome, status = "invalid_response", 502
		writeProxyError(w, 502, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	responseBodyBytes := h.responseBodyBytes
	if route == "models" {
		responseBodyBytes = modelsResponseBodyBytes
	}
	content, err := readBounded(response.Body, responseBodyBytes)
	if err != nil || rejectUpstreamDuplicateKeys(content) != nil || !validUpstreamJSON(route, content) {
		h.observe("invalid_response", started)
		outcome, status = "invalid_response", 502
		writeProxyError(w, 502, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	if route == "models" && len(h.enabledModels) > 0 {
		content = filterModels(content, h.enabledModelIDs())
	}
	if route == "chat" {
		var response struct {
			Usage *tokenUsage `json:"usage"`
		}
		_ = json.Unmarshal(content, &response)
		if response.Usage != nil {
			usage = &modelproxy.Usage{PromptTokens: response.Usage.PromptTokens, CompletionTokens: response.Usage.CompletionTokens, TotalTokens: response.Usage.TotalTokens}
		}
	}
	outcome, status = "succeeded", response.StatusCode
	h.observe("success", started)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(content)
}

func (h *modelProxyHandler) modelEnabled(model string) bool {
	if len(h.enabledModels) == 0 {
		return true
	}
	_, ok := h.enabledModels[model]
	return ok
}

func (h *modelProxyHandler) enabledModelIDs() []string {
	models := make([]string, 0, len(h.enabledModels))
	for model := range h.enabledModels {
		models = append(models, model)
	}
	return models
}
func (h *modelProxyHandler) observe(outcome string, started time.Time) {
	if h.observer != nil {
		h.observer.RecordModelProxyUpstream(outcome, time.Since(started))
	}
}
func (h *modelProxyHandler) requestID() (string, error) {
	b := make([]byte, 16)
	if _, err := io.ReadFull(h.requestIDs, b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	encoded := hex.EncodeToString(b)
	requestID := encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
	h.requestIDMu.Lock()
	defer h.requestIDMu.Unlock()
	if requestID == h.lastRequestID {
		return "", errors.New("request ID entropy repeated")
	}
	h.lastRequestID = requestID
	return requestID, nil
}

func rejectUpstreamDuplicateKeys(content []byte) error { return rejectDuplicateKeys(content) }
func strictBearer(values []string) (string, bool) {
	if len(values) != 1 {
		return "", false
	}
	v := values[0]
	if !strings.HasPrefix(v, "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(v, "Bearer ")
	return token, token != "" && strings.TrimSpace(token) == token && !strings.ContainsAny(token, " \t\r\n")
}
func decodeModelRequest(w http.ResponseWriter, r *http.Request, out any, limit int64) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return errInvalidRequest
	}
	if r.ContentLength > limit {
		return errBodyTooLarge
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	content, err := io.ReadAll(r.Body)
	if err != nil {
		var max *http.MaxBytesError
		if errors.As(err, &max) {
			return errBodyTooLarge
		}
		return errInvalidRequest
	}
	if rejectDuplicateKeys(content) != nil {
		return errInvalidRequest
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if decoder.Decode(out) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return errInvalidRequest
	}
	return nil
}
func hasGETBody(w http.ResponseWriter, r *http.Request) (bool, error) {
	if r.Body == nil {
		return false, nil
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	buffer := make([]byte, 1)
	n, err := r.Body.Read(buffer)
	if err != nil && err != io.EOF {
		return false, err
	}
	return n > 0, nil
}
func validChat(c chatRequest) bool {
	if !modelNamePattern.MatchString(c.Model) || c.Stream == nil || len(c.Messages) == 0 || (c.MaxTokens != nil && (*c.MaxTokens < 1 || *c.MaxTokens > 32768)) {
		return false
	}
	for _, m := range c.Messages {
		switch m.Role {
		case "system", "user":
			if m.Content == nil || *m.Content == "" || m.Name != "" || m.ToolCallID != "" || len(m.ToolCalls) > 0 {
				return false
			}
		case "assistant":
			if (m.Content == nil || *m.Content == "") && (len(m.ToolCalls) == 0 || string(m.ToolCalls) == "null") {
				return false
			}
			if m.ToolCallID != "" {
				return false
			}
		case "tool":
			if m.Content == nil || *m.Content == "" || !proxyIdentifierPattern.MatchString(m.ToolCallID) || len(m.ToolCalls) > 0 {
				return false
			}
		default:
			return false
		}
	}
	if len(c.Tools) > 0 && string(c.Tools) == "null" {
		return false
	}
	return true
}

func validImageGeneration(request imageGenerationRequest) bool {
	return modelNamePattern.MatchString(request.Model) && strings.TrimSpace(request.Prompt) != "" && len(request.Prompt) <= 64<<10 && (request.N == nil || (*request.N >= 1 && *request.N <= 10))
}

func restrictedImageEdit(w http.ResponseWriter, r *http.Request, limit int64) (string, []byte, string, error) {
	mediaType, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" || parameters["boundary"] == "" {
		return "", nil, "", errInvalidRequest
	}
	if r.ContentLength > limit {
		return "", nil, "", errBodyTooLarge
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	reader := multipart.NewReader(r.Body, parameters["boundary"])
	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	values := map[string]string{}
	files := 0
	for {
		part, partErr := reader.NextPart()
		if errors.Is(partErr, io.EOF) {
			break
		}
		if partErr != nil {
			var max *http.MaxBytesError
			if errors.As(partErr, &max) {
				return "", nil, "", errBodyTooLarge
			}
			return "", nil, "", errInvalidRequest
		}
		name, filename := part.FormName(), part.FileName()
		switch {
		case name == "image[]" && filename != "" && files < 4:
			baseName := path.Base(strings.ReplaceAll(filename, `\`, "/"))
			if !validImageFilename(baseName) {
				return "", nil, "", errInvalidRequest
			}
			fileWriter, createErr := writer.CreateFormFile("image[]", baseName)
			if createErr != nil {
				return "", nil, "", errInvalidRequest
			}
			if _, createErr = io.Copy(fileWriter, part); createErr != nil {
				return "", nil, "", errInvalidRequest
			}
			files++
		case (name == "model" || name == "prompt") && filename == "" && values[name] == "":
			value, readErr := io.ReadAll(io.LimitReader(part, 64<<10+1))
			if readErr != nil || len(value) > 64<<10 {
				return "", nil, "", errInvalidRequest
			}
			values[name] = string(value)
		default:
			return "", nil, "", errInvalidRequest
		}
	}
	if files == 0 || !modelNamePattern.MatchString(values["model"]) || strings.TrimSpace(values["prompt"]) == "" {
		return "", nil, "", errInvalidRequest
	}
	for _, name := range []string{"model", "prompt"} {
		if err := writer.WriteField(name, values[name]); err != nil {
			return "", nil, "", errInvalidRequest
		}
	}
	if err := writer.Close(); err != nil {
		return "", nil, "", errInvalidRequest
	}
	return values["model"], buffer.Bytes(), writer.FormDataContentType(), nil
}

func validImageFilename(name string) bool {
	if name == "" || name == "." || len(name) > 128 || strings.ContainsAny(name, "\r\n\x00") {
		return false
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".webp":
		return true
	default:
		return false
	}
}
func serviceError(err error) (int, string) {
	switch {
	case errors.Is(err, modelproxy.ErrAuthenticationFailed):
		return 401, "AUTHENTICATION_FAILED"
	case errors.Is(err, modelproxy.ErrModelNotAllowed):
		return 403, "MODEL_NOT_ALLOWED"
	case errors.Is(err, modelproxy.ErrAdmissionLimited):
		return 429, "RATE_LIMITED"
	default:
		return 503, "SERVICE_UNAVAILABLE"
	}
}
func upstreamError(status int, body []byte) (int, string, string) {
	switch status {
	case 401:
		return 502, "UPSTREAM_AUTHENTICATION_FAILED", "authentication_failed"
	case 403:
		return 502, "UPSTREAM_PERMISSION_DENIED", "permission_denied"
	case 429:
		if insufficientBalance(body) {
			return 402, "BALANCE_INSUFFICIENT", "balance_insufficient"
		}
		return 429, "UPSTREAM_RATE_LIMITED", "rate_limited"
	case 404:
		if modelMissing(body) {
			return 404, "MODEL_NOT_FOUND", "model_not_found"
		}
		return 502, "UPSTREAM_UNAVAILABLE", "unavailable"
	default:
		return 502, "UPSTREAM_UNAVAILABLE", "unavailable"
	}
}

func upstreamErrorText(body []byte) string {
	var response struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &response) != nil {
		return ""
	}
	return strings.ToLower(response.Error.Code + " " + response.Error.Message)
}

func insufficientBalance(body []byte) bool {
	text := upstreamErrorText(body)
	return strings.Contains(text, "insufficient_quota") || strings.Contains(text, "balance") || strings.Contains(text, "quota exhausted") || strings.Contains(text, "余额") || strings.Contains(text, "额度不足")
}

func modelMissing(body []byte) bool {
	text := upstreamErrorText(body)
	return strings.Contains(text, "model_not_found") || strings.Contains(text, "model not found") || strings.Contains(text, "模型不存在")
}

func isEventStream(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && mediaType == "text/event-stream"
}

func relaySSE(w http.ResponseWriter, body io.Reader, limit int64) error {
	reader := bufio.NewReader(io.LimitReader(body, limit+1))
	written := int64(0)
	flusher, _ := w.(http.Flusher)
	for {
		line, err := reader.ReadBytes('\n')
		written += int64(len(line))
		if written > limit {
			return errors.New("bounded response invalid")
		}
		if len(line) > 0 {
			if _, writeErr := w.Write(line); writeErr != nil {
				return writeErr
			}
			if flusher != nil && (bytes.Equal(line, []byte("\n")) || bytes.Equal(line, []byte("\r\n"))) {
				flusher.Flush()
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
func readBounded(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, errors.New("bounded response invalid")
	}
	return b, nil
}
func validUpstreamJSON(route string, b []byte) bool {
	var top map[string]json.RawMessage
	if json.Unmarshal(b, &top) != nil {
		return false
	}
	if route == "models" {
		if !hasAllowedKeys(top, []string{"object", "data"}, "success") {
			return false
		}
		var object string
		var data []map[string]json.RawMessage
		if json.Unmarshal(top["object"], &object) != nil || object != "list" || json.Unmarshal(top["data"], &data) != nil || data == nil {
			return false
		}
		if success, ok := top["success"]; ok {
			var value bool
			if json.Unmarshal(success, &value) != nil {
				return false
			}
		}
		for _, m := range data {
			if !hasAllowedKeys(m, []string{"id", "object", "created", "owned_by"}, "supported_endpoint_types") {
				return false
			}
			var id, obj, owner string
			var created int64
			if json.Unmarshal(m["id"], &id) != nil || !modelNamePattern.MatchString(id) || json.Unmarshal(m["object"], &obj) != nil || obj != "model" || json.Unmarshal(m["owned_by"], &owner) != nil || !proxyIdentifierPattern.MatchString(owner) || json.Unmarshal(m["created"], &created) != nil || created < 0 || created > maxSafeInteger {
				return false
			}
			if endpoints, ok := m["supported_endpoint_types"]; ok {
				var values []string
				if json.Unmarshal(endpoints, &values) != nil || values == nil {
					return false
				}
				for _, value := range values {
					if !proxyIdentifierPattern.MatchString(value) {
						return false
					}
				}
			}
		}
		return true
	}
	if strings.HasPrefix(route, "images.") {
		return validImageResponse(top)
	}
	if !hasExactKeys(top, "id", "object", "created", "model", "choices", "usage") {
		return false
	}
	var id, obj, model string
	var created int64
	var choices []map[string]json.RawMessage
	if json.Unmarshal(top["id"], &id) != nil || !proxyIdentifierPattern.MatchString(id) || json.Unmarshal(top["object"], &obj) != nil || obj != "chat.completion" || json.Unmarshal(top["model"], &model) != nil || !modelNamePattern.MatchString(model) || json.Unmarshal(top["created"], &created) != nil || created < 0 || created > maxSafeInteger || json.Unmarshal(top["choices"], &choices) != nil || len(choices) == 0 {
		return false
	}
	for _, choice := range choices {
		if !hasExactKeys(choice, "index", "message", "finish_reason") {
			return false
		}
		var index int64
		var message map[string]json.RawMessage
		var finishReason string
		if json.Unmarshal(choice["index"], &index) != nil || index < 0 || index > maxSafeInteger || json.Unmarshal(choice["message"], &message) != nil || !hasExactKeys(message, "role", "content") || json.Unmarshal(choice["finish_reason"], &finishReason) != nil || (finishReason != "stop" && finishReason != "length" && finishReason != "content_filter") {
			return false
		}
		var role, content string
		if json.Unmarshal(message["role"], &role) != nil || role != "assistant" || json.Unmarshal(message["content"], &content) != nil {
			return false
		}
	}
	var fields map[string]json.RawMessage
	var promptTokens, completionTokens, totalTokens int64
	if json.Unmarshal(top["usage"], &fields) != nil || !hasAllowedKeys(fields, []string{"prompt_tokens", "completion_tokens", "total_tokens"}, "completion_tokens_details") || json.Unmarshal(fields["prompt_tokens"], &promptTokens) != nil || json.Unmarshal(fields["completion_tokens"], &completionTokens) != nil || json.Unmarshal(fields["total_tokens"], &totalTokens) != nil || promptTokens < 0 || completionTokens < 0 || totalTokens < 0 || promptTokens > maxSafeInteger || completionTokens > maxSafeInteger || totalTokens > maxSafeInteger {
		return false
	}
	if details, ok := fields["completion_tokens_details"]; ok {
		var values map[string]int64
		if json.Unmarshal(details, &values) != nil || values == nil {
			return false
		}
		for _, value := range values {
			if value < 0 || value > maxSafeInteger {
				return false
			}
		}
	}
	return true
}

func validImageResponse(top map[string]json.RawMessage) bool {
	if !hasAllowedKeys(top, []string{"created", "data"}, "background", "output_format", "quality", "size", "model", "usage") {
		return false
	}
	var created int64
	var data []map[string]json.RawMessage
	if json.Unmarshal(top["created"], &created) != nil || created < 0 || created > maxSafeInteger || json.Unmarshal(top["data"], &data) != nil || len(data) == 0 {
		return false
	}
	for _, key := range []string{"background", "output_format", "quality", "size"} {
		if raw, ok := top[key]; ok {
			var value string
			if json.Unmarshal(raw, &value) != nil || value == "" || len(value) > 128 {
				return false
			}
		}
	}
	if raw, ok := top["model"]; ok {
		var model string
		if json.Unmarshal(raw, &model) != nil || !modelNamePattern.MatchString(model) {
			return false
		}
	}
	if raw, ok := top["usage"]; ok && !validImageUsage(raw) {
		return false
	}
	for _, item := range data {
		if !hasAllowedKeys(item, nil, "url", "b64_json", "revised_prompt") {
			return false
		}
		_, hasURL := item["url"]
		_, hasBase64 := item["b64_json"]
		if hasURL == hasBase64 {
			return false
		}
		var value string
		if raw, ok := item["url"]; ok {
			if json.Unmarshal(raw, &value) != nil || value == "" {
				return false
			}
		} else if raw, ok := item["b64_json"]; ok {
			if json.Unmarshal(raw, &value) != nil || value == "" {
				return false
			}
		}
		if raw, ok := item["revised_prompt"]; ok {
			if json.Unmarshal(raw, &value) != nil || len(value) > 64<<10 {
				return false
			}
		}
	}
	return true
}

func validImageUsage(raw json.RawMessage) bool {
	var usage map[string]json.RawMessage
	if json.Unmarshal(raw, &usage) != nil || len(usage) == 0 || !hasAllowedKeys(usage, nil, "input_tokens", "output_tokens", "total_tokens", "input_tokens_details") {
		return false
	}
	for _, key := range []string{"input_tokens", "output_tokens", "total_tokens"} {
		if value, ok := usage[key]; ok && !validTokenCount(value) {
			return false
		}
	}
	if rawDetails, ok := usage["input_tokens_details"]; ok {
		var details map[string]json.RawMessage
		if json.Unmarshal(rawDetails, &details) != nil || details == nil || !hasAllowedKeys(details, nil, "text_tokens", "image_tokens") {
			return false
		}
		for _, value := range details {
			if !validTokenCount(value) {
				return false
			}
		}
	}
	return true
}

func validTokenCount(raw json.RawMessage) bool {
	var value int64
	return json.Unmarshal(raw, &value) == nil && value >= 0 && value <= maxSafeInteger
}

func hasExactKeys(value map[string]json.RawMessage, keys ...string) bool {
	if len(value) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	return true
}

func hasAllowedKeys(value map[string]json.RawMessage, required []string, optional ...string) bool {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		if _, ok := value[key]; !ok {
			return false
		}
		allowed[key] = struct{}{}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	for key := range value {
		if _, ok := allowed[key]; !ok {
			return false
		}
	}
	return true
}

func filterModels(content []byte, allowed []string) []byte {
	var response map[string]json.RawMessage
	var models []json.RawMessage
	if json.Unmarshal(content, &response) != nil || json.Unmarshal(response["data"], &models) != nil {
		return content
	}
	set := make(map[string]struct{}, len(allowed))
	for _, model := range allowed {
		set[model] = struct{}{}
	}
	filtered := models[:0]
	for _, model := range models {
		var item map[string]json.RawMessage
		var id string
		if json.Unmarshal(model, &item) == nil && json.Unmarshal(item["id"], &id) == nil {
			if _, ok := set[id]; ok {
				filtered = append(filtered, model)
			}
		}
	}
	response["data"], _ = json.Marshal(filtered)
	encoded, err := json.Marshal(response)
	if err != nil {
		return content
	}
	return encoded
}
func writeProxyError(w http.ResponseWriter, status int, code, requestID string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "message": http.StatusText(status), "requestId": requestID})
}
