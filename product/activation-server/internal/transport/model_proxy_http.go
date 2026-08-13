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
	"time"

	"u-claw-activation-server/internal/modelproxy"
)

const modelRequestLimit int64 = 1 << 20

var modelNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)

type ModelProxyService interface {
	Authorize(context.Context, string, string, string) (modelproxy.Grant, error)
	Complete(context.Context, modelproxy.Grant, string, string, int, *modelproxy.Usage)
}
type ModelProxyHandlerOptions struct {
	Service      ModelProxyService
	Client       *http.Client
	AllowedHosts []string
	RequestIDs   io.Reader
	Timeout      time.Duration
	Observer     modelproxy.Observer
}
type modelProxyHandler struct {
	service      ModelProxyService
	client       *http.Client
	allowedHosts []string
	requestIDs   io.Reader
	timeout      time.Duration
	observer     modelproxy.Observer
}

func NewModelProxyHandler(o ModelProxyHandlerOptions) http.Handler {
	if o.RequestIDs == nil {
		o.RequestIDs = rand.Reader
	}
	if o.Timeout <= 0 {
		o.Timeout = 60 * time.Second
	}
	return &modelProxyHandler{service: o.Service, client: o.Client, allowedHosts: append([]string(nil), o.AllowedHosts...), requestIDs: o.RequestIDs, timeout: o.Timeout, observer: o.Observer}
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
}
type modelResponse struct {
	Object string `json:"object"`
	Data   []struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		OwnedBy string `json:"owned_by"`
	} `json:"data"`
}
type chatResponse struct {
	ID, Object string
	Created    int64  `json:"created"`
	Model      string `json:"model"`
	Choices    []struct {
		Index        int         `json:"index"`
		Message      chatMessage `json:"message"`
		FinishReason string      `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

func (h *modelProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := h.requestID()
	w.Header().Set("X-Request-ID", requestID)
	route := ""
	var chat chatRequest
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/model-api/v1/models":
		route = "models"
		if r.Body != nil && r.ContentLength != 0 {
			writeProxyError(w, 400, "INVALID_REQUEST", requestID)
			return
		}
	case r.Method == http.MethodPost && r.URL.Path == "/model-api/v1/chat/completions":
		route = "chat"
		if err := decodeModelRequest(w, r, &chat); err != nil {
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
	default:
		writeProxyError(w, 404, "NOT_FOUND", requestID)
		return
	}
	bearer, ok := strictBearer(r.Header.Values("Authorization"))
	if !ok {
		writeProxyError(w, 401, "AUTHENTICATION_FAILED", requestID)
		return
	}
	if h.service == nil || h.client == nil {
		writeProxyError(w, 503, "SERVICE_UNAVAILABLE", requestID)
		return
	}
	model := chat.Model
	grant, err := h.service.Authorize(r.Context(), bearer, model, requestID)
	if err != nil {
		status, code := serviceError(err)
		writeProxyError(w, status, code, requestID)
		return
	}
	defer grant.Clear()
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	target, err := modelproxy.ValidateBaseURL(grant.Authorization.BaseURL, h.allowedHosts)
	if err != nil {
		h.service.Complete(r.Context(), grant, route, "unavailable", 503, nil)
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
	if err != nil {
		h.observe("unavailable", started)
		h.service.Complete(r.Context(), grant, route, "unavailable", 502, nil)
		writeProxyError(w, 502, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		status, code, outcome := upstreamError(response.StatusCode)
		h.observe(outcome, started)
		h.service.Complete(r.Context(), grant, route, outcome, status, nil)
		writeProxyError(w, status, code, requestID)
		return
	}
	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		h.observe("invalid_response", started)
		h.service.Complete(r.Context(), grant, route, "invalid_response", 502, nil)
		writeProxyError(w, 502, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	limit := int64(1 << 20)
	if route == "chat" {
		limit = 4 << 20
	}
	content, err := readBounded(response.Body, limit)
	if err != nil || !validUpstreamJSON(route, content) {
		h.observe("invalid_response", started)
		h.service.Complete(r.Context(), grant, route, "invalid_response", 502, nil)
		writeProxyError(w, 502, "UPSTREAM_UNAVAILABLE", requestID)
		return
	}
	if route == "models" {
		content = filterModels(content, grant.Authorization.AllowedModels)
	}
	var usage *modelproxy.Usage
	if route == "chat" {
		var c chatResponse
		_ = json.Unmarshal(content, &c)
		usage = &modelproxy.Usage{PromptTokens: c.Usage.PromptTokens, CompletionTokens: c.Usage.CompletionTokens, TotalTokens: c.Usage.TotalTokens}
	}
	h.service.Complete(r.Context(), grant, route, "succeeded", response.StatusCode, usage)
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
func (h *modelProxyHandler) requestID() string {
	b := make([]byte, 16)
	if _, err := io.ReadFull(h.requestIDs, b); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	encoded := hex.EncodeToString(b)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}
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
func decodeModelRequest(w http.ResponseWriter, r *http.Request, out any) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return errInvalidRequest
	}
	if r.ContentLength > modelRequestLimit {
		return errBodyTooLarge
	}
	r.Body = http.MaxBytesReader(w, r.Body, modelRequestLimit)
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
func validChat(c chatRequest) bool {
	if !modelNamePattern.MatchString(c.Model) || c.Stream || len(c.Messages) == 0 {
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
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if route == "models" {
		var v modelResponse
		if decoder.Decode(&v) != nil || decoder.Decode(&struct{}{}) != io.EOF || v.Object != "list" {
			return false
		}
		for _, m := range v.Data {
			if m.ID == "" || m.Object != "model" || m.OwnedBy == "" || m.Created < 0 {
				return false
			}
		}
		return true
	}
	var v chatResponse
	if decoder.Decode(&v) != nil || decoder.Decode(&struct{}{}) != io.EOF || v.ID == "" || v.Object != "chat.completion" || v.Model == "" || v.Created < 0 {
		return false
	}
	for _, c := range v.Choices {
		if c.Index < 0 || c.Message.Role != "assistant" || (c.FinishReason != "stop" && c.FinishReason != "length" && c.FinishReason != "content_filter") {
			return false
		}
	}
	return v.Usage.PromptTokens >= 0 && v.Usage.CompletionTokens >= 0 && v.Usage.TotalTokens >= 0
}

func filterModels(content []byte, allowed []string) []byte {
	var response modelResponse
	if json.Unmarshal(content, &response) != nil {
		return content
	}
	set := make(map[string]struct{}, len(allowed))
	for _, model := range allowed {
		set[model] = struct{}{}
	}
	filtered := response.Data[:0]
	for _, model := range response.Data {
		if _, ok := set[model.ID]; ok {
			filtered = append(filtered, model)
		}
	}
	response.Data = filtered
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
