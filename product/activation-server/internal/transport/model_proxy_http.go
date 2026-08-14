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

const maxSafeInteger int64 = 9_007_199_254_740_991

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
	return &modelProxyHandler{service: o.Service, client: o.Client, allowedHosts: append([]string(nil), o.AllowedHosts...), requestIDs: o.RequestIDs, timeout: o.Timeout, observer: o.Observer, requestBodyBytes: o.RequestBodyBytes, responseBodyBytes: o.ResponseBodyBytes}
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type chatRequest struct {
	Model     string        `json:"model"`
	Messages  []chatMessage `json:"messages"`
	MaxTokens *int          `json:"max_tokens,omitempty"`
	Stream    bool          `json:"stream"`
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
	}
	if h.service == nil || h.client == nil {
		writeProxyError(w, 503, "SERVICE_UNAVAILABLE", requestID)
		return
	}
	model := chat.Model
	grant, err := h.service.Authorize(ctx, bearer, model, requestID)
	if err != nil {
		status, code := serviceError(err)
		writeProxyError(w, status, code, requestID)
		return
	}
	defer grant.Clear()
	outcome, status, usage := "unavailable", 502, (*modelproxy.Usage)(nil)
	defer func() { h.service.Complete(ctx, grant, route, outcome, status, usage) }()
	target, err := modelproxy.ValidateBaseURL(grant.Authorization.BaseURL, h.allowedHosts)
	if err != nil {
		outcome, status = "unavailable", 503
		writeProxyError(w, 503, "SERVICE_UNAVAILABLE", requestID)
		return
	}
	upstreamURL := *target
	upstreamURL.Path = path.Join(strings.TrimSuffix(target.Path, "/"), map[bool]string{true: "chat/completions", false: "models"}[route == "chat"])
	var body io.Reader
	if route == "chat" {
		encoded, _ := json.Marshal(chat)
		body = bytes.NewReader(encoded)
	}
	upstream, _ := http.NewRequestWithContext(ctx, r.Method, upstreamURL.String(), body)
	upstream.Header.Set("Authorization", "Bearer "+string(grant.APIKey))
	upstream.Header.Set("Accept", "application/json")
	upstream.Header.Set("X-Request-ID", requestID)
	if route == "chat" {
		upstream.Header.Set("Content-Type", "application/json")
	}
	started := time.Now()
	response, err := h.client.Do(upstream)
	upstream.Header.Del("Authorization")
	if err != nil {
		h.observe("unavailable", started)
		writeProxyError(w, 502, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		mappedStatus, code, mappedOutcome := upstreamError(response.StatusCode)
		h.observe(mappedOutcome, started)
		outcome, status = mappedOutcome, mappedStatus
		writeProxyError(w, mappedStatus, code, requestID)
		return
	}
	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		h.observe("invalid_response", started)
		outcome, status = "invalid_response", 502
		writeProxyError(w, 502, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	content, err := readBounded(response.Body, h.responseBodyBytes)
	if err != nil || rejectUpstreamDuplicateKeys(content) != nil || !validUpstreamJSON(route, content) {
		h.observe("invalid_response", started)
		outcome, status = "invalid_response", 502
		writeProxyError(w, 502, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	if route == "models" {
		content = filterModels(content, grant.Authorization.AllowedModels)
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
	if !modelNamePattern.MatchString(c.Model) || c.Stream || len(c.Messages) == 0 || (c.MaxTokens != nil && (*c.MaxTokens < 1 || *c.MaxTokens > 32768)) {
		return false
	}
	for _, m := range c.Messages {
		if (m.Role != "system" && m.Role != "user" && m.Role != "assistant") || m.Content == "" {
			return false
		}
	}
	return true
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
func upstreamError(status int) (int, string, string) {
	switch status {
	case 401, 403:
		return 502, "UPSTREAM_AUTHENTICATION_FAILED", "authentication_failed"
	case 429:
		return 429, "UPSTREAM_RATE_LIMITED", "rate_limited"
	default:
		return 502, "UPSTREAM_UNAVAILABLE", "unavailable"
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
		if !hasExactKeys(top, "object", "data") {
			return false
		}
		var object string
		var data []map[string]json.RawMessage
		if json.Unmarshal(top["object"], &object) != nil || object != "list" || json.Unmarshal(top["data"], &data) != nil {
			return false
		}
		for _, m := range data {
			if !hasExactKeys(m, "id", "object", "created", "owned_by") {
				return false
			}
			var id, obj, owner string
			var created int64
			if json.Unmarshal(m["id"], &id) != nil || !modelNamePattern.MatchString(id) || json.Unmarshal(m["object"], &obj) != nil || obj != "model" || json.Unmarshal(m["owned_by"], &owner) != nil || !proxyIdentifierPattern.MatchString(owner) || json.Unmarshal(m["created"], &created) != nil || created < 0 || created > maxSafeInteger {
				return false
			}
		}
		return true
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
	if json.Unmarshal(top["usage"], &fields) != nil || !hasExactKeys(fields, "prompt_tokens", "completion_tokens", "total_tokens") || json.Unmarshal(fields["prompt_tokens"], &promptTokens) != nil || json.Unmarshal(fields["completion_tokens"], &completionTokens) != nil || json.Unmarshal(fields["total_tokens"], &totalTokens) != nil || promptTokens < 0 || completionTokens < 0 || totalTokens < 0 || promptTokens > maxSafeInteger || completionTokens > maxSafeInteger || totalTokens > maxSafeInteger {
		return false
	}
	return true
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
