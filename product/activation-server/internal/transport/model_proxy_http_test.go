package transport

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"u-claw-activation-server/internal/modelproxy"
)

type fakeProxyService struct {
	grant         modelproxy.Grant
	err           error
	bearer, model string
	completed     bool
	ctxDeadline   bool
}

func (s *fakeProxyService) Authorize(ctx context.Context, bearer, model, requestID string) (modelproxy.Grant, error) {
	_, s.ctxDeadline = ctx.Deadline()
	s.bearer = bearer
	s.model = model
	s.grant.RequestID = requestID
	return s.grant, s.err
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("entropy failed") }

func TestModelProxyHandlerRequestIDFailureStopsBeforeDependencies(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	called := false
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { called = true; return nil, errors.New("called") })}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, RequestIDs: failingReader{}})
	req := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
	req.Header.Set("Authorization", "Bearer token")
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != 503 || !strings.Contains(res.Body.String(), "REQUEST_ID_UNAVAILABLE") || service.bearer != "" || called {
		t.Fatalf("status=%d bearer=%q called=%v body=%s", res.Code, service.bearer, called, res.Body.String())
	}
}

func TestModelProxyHandlerRejectsRepeatedRequestIDEntropy(t *testing.T) {
	service := &fakeProxyService{err: modelproxy.ErrAuthenticationFailed}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: &http.Client{}, RequestIDs: bytes.NewReader(make([]byte, 32))})
	for index := 0; index < 2; index++ {
		request := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
		request.Header.Set("Authorization", "Bearer token")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if index == 1 && (response.Code != 503 || !strings.Contains(response.Body.String(), "REQUEST_ID_UNAVAILABLE")) {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	}
}

func TestModelProxyHandlerCreatesDeadlineBeforeService(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t), err: modelproxy.ErrAuthenticationFailed}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: &http.Client{}, Timeout: 20 * time.Millisecond})
	req := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
	req.Header.Set("Authorization", "Bearer token")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if !service.ctxDeadline {
		t.Fatal("service context missing overall deadline")
	}
}

func TestModelProxyHandlerUsesConfiguredBodyLimits(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: &http.Client{}, RequestBodyBytes: 64, ResponseBodyBytes: 128})
	request := httptest.NewRequest(http.MethodPost, "/model-api/v1/chat/completions", strings.NewReader(`{"model":"allowed","messages":[{"role":"user","content":"`+strings.Repeat("x", 65)+`"}],"stream":false}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge || service.bearer != "" {
		t.Fatalf("request status=%d bearer=%q body=%s", response.Code, service.bearer, response.Body.String())
	}

	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		body := `{"id":"chatcmpl_fixture","object":"chat.completion","created":1,"model":"allowed","choices":[{"index":0,"message":{"role":"assistant","content":"` + strings.Repeat("x", 129) + `"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	h = NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}, RequestBodyBytes: 1 << 20, ResponseBodyBytes: 128})
	request = httptest.NewRequest(http.MethodPost, "/model-api/v1/chat/completions", strings.NewReader(`{"model":"allowed","messages":[{"role":"user","content":"x"}],"stream":false}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer token")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("response status=%d body=%s", response.Code, response.Body.String())
	}

	client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		body := `{"object":"list","data":[{"id":"` + strings.Repeat("x", 100) + `","object":"model","created":1,"owned_by":"owner"}]}`
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	h = NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}, RequestBodyBytes: 1 << 20, ResponseBodyBytes: 128})
	request = httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
	request.Header.Set("Authorization", "Bearer token")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("models response status=%d body=%s", response.Code, response.Body.String())
	}

	client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		model := `{"id":"allowed","object":"model","created":1,"owned_by":"owner"}`
		body := `{"object":"list","data":[` + strings.Repeat(model+",", 17000) + model + `]}`
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	h = NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}, RequestBodyBytes: 1 << 20, ResponseBodyBytes: 4 << 20})
	request = httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
	request.Header.Set("Authorization", "Bearer token")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("oversized models response status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestUpstreamDuplicateJSONRejected(t *testing.T) {
	for _, body := range []string{`{"object":"list","object":"list","data":[]}`, `{"object":"list","data":[{"id":"allowed","id":"other","object":"model","created":1,"owned_by":"owner"}]}`} {
		if rejectUpstreamDuplicateKeys([]byte(body)) == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}

func TestModelProxyHandlerMapsDuplicateUpstreamJSONTo502(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"object":"list","data":[],"data":[]}`))}, nil
	})}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
	request := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 502 {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
func (s *fakeProxyService) Complete(_ context.Context, _ modelproxy.Grant, _, _ string, _ int, _ *modelproxy.Usage) {
	s.completed = true
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func runtimeSecret(t *testing.T) []byte {
	t.Helper()
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	return []byte(hex.EncodeToString(value))
}

func validGrant(t *testing.T) modelproxy.Grant {
	return modelproxy.Grant{Authorization: modelproxy.Authorization{TokenID: "10000000-0000-4000-8000-000000000001", InventoryID: "20000000-0000-4000-8000-000000000001", BaseURL: "https://api.example.test/v1", AllowedModels: []string{"allowed"}, DefaultModel: "allowed"}, APIKey: runtimeSecret(t)}
}
func TestModelProxyHandlerRelaysStrictChatAndSanitizesHeaders(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	wantAuthorization := "Bearer " + string(service.grant.APIKey)
	var upstream *http.Request
	var upstreamAuthorization string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		upstream = r
		upstreamAuthorization = r.Header.Get("Authorization")
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}, "Set-Cookie": []string{"bad=1"}}, Body: io.NopCloser(strings.NewReader(`{"id":"chatcmpl_fixture","object":"chat.completion","created":1,"model":"allowed","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"completion_tokens_details":{"reasoning_tokens":0}}}`))}, nil
	})}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}, RequestIDs: bytes.NewReader(make([]byte, 16))})
	req := httptest.NewRequest(http.MethodPost, "/model-api/v1/chat/completions", strings.NewReader(`{"model":"allowed","messages":[{"role":"user","content":"hello"}],"stream":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer token-value")
	req.Header.Set("Cookie", "secret-cookie")
	req.Header.Set("X-Forwarded-For", "10.0.0.1")
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != 200 {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	if upstreamAuthorization != wantAuthorization || upstream.Header.Get("Authorization") != "" || upstream.Header.Get("Cookie") != "" || upstream.Header.Get("X-Forwarded-For") != "" {
		t.Fatalf("headers=%v", upstream.Header)
	}
	if res.Header().Get("Set-Cookie") != "" {
		t.Fatal("response cookie relayed")
	}
	if !strings.Contains(res.Body.String(), `"completion_tokens_details"`) {
		t.Fatalf("response extension missing: %s", res.Body.String())
	}
	if !service.completed {
		t.Fatal("admission not completed")
	}
}

func TestModelProxyHandlerAcceptsAndForwardsMaxTokens(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	var upstreamBody string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		upstreamBody = string(body)
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"chatcmpl_fixture","object":"chat.completion","created":1,"model":"allowed","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))}, nil
	})}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
	req := httptest.NewRequest(http.MethodPost, "/model-api/v1/chat/completions", strings.NewReader(`{"model":"allowed","messages":[{"role":"user","content":"hello"}],"max_tokens":32768,"stream":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer token")
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(upstreamBody, `"max_tokens":32768`) {
		t.Fatalf("status=%d upstream=%s body=%s", res.Code, upstreamBody, res.Body.String())
	}

	for _, maxTokens := range []string{"0", "32769", "1.5"} {
		req = httptest.NewRequest(http.MethodPost, "/model-api/v1/chat/completions", strings.NewReader(`{"model":"allowed","messages":[{"role":"user","content":"hello"}],"max_tokens":`+maxTokens+`,"stream":false}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer token")
		res = httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("max_tokens=%s status=%d body=%s", maxTokens, res.Code, res.Body.String())
		}
	}
}

func TestModelProxyHandlerRecordsUpstreamOutcome(t *testing.T) {
	observer := &fakeProxyObserver{}
	service := &fakeProxyService{grant: validGrant(t)}
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 500, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("secret"))}, nil
	})}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}, Observer: observer})
	req := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
	req.Header.Set("Authorization", "Bearer token")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if len(observer.outcomes) != 1 || observer.outcomes[0] != "unavailable" {
		t.Fatalf("outcomes=%v", observer.outcomes)
	}
}

func TestModelProxyHandlerReturnsGlobalModelsWithoutDeviceFiltering(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"object":"list","success":true,"data":[{"id":"allowed","object":"model","created":1,"owned_by":"owner","supported_endpoint_types":["openai"]},{"id":"blocked","object":"model","created":1,"owned_by":"owner","supported_endpoint_types":["openai"]}]}`))}, nil
	})}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
	req := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
	req.Header.Set("Authorization", "Bearer token")
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != 200 || !strings.Contains(res.Body.String(), "blocked") || !strings.Contains(res.Body.String(), "allowed") || !strings.Contains(res.Body.String(), `"success":true`) || !strings.Contains(res.Body.String(), `"supported_endpoint_types"`) {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestModelProxyHandlerAppliesOneGlobalEnabledModelSet(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"object":"list","data":[{"id":"enabled","object":"model","created":1,"owned_by":"owner"},{"id":"disabled","object":"model","created":1,"owned_by":"owner"}]}`))}, nil
	})}
	handler := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}, EnabledModels: []string{"enabled"}})
	request := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"enabled"`) || strings.Contains(response.Body.String(), `"id":"disabled"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestModelProxyHandlerRejectsUpstreamExtensions(t *testing.T) {
	cases := []struct{ route, body string }{
		{"/model-api/v1/chat/completions", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"allowed","system_fingerprint":"fp_x","choices":[{"index":0,"message":{"role":"assistant","content":"ok","custom":"yes"},"finish_reason":"stop","logprobs":{"tokens":[]}}],"custom_top":{"x":1}}`},
		{"/model-api/v1/models", `{"object":"list","custom_top":true,"data":[{"id":"allowed","object":"model","created":1,"owned_by":"owner","custom":"kept"}]}`},
	}
	for _, test := range cases {
		service := &fakeProxyService{grant: validGrant(t)}
		client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(test.body))}, nil
		})}
		h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
		method := http.MethodGet
		var body io.Reader
		if strings.Contains(test.route, "chat") {
			method = http.MethodPost
			body = strings.NewReader(`{"model":"allowed","messages":[{"role":"user","content":"x"}],"stream":false}`)
		}
		request := httptest.NewRequest(method, test.route, body)
		request.Header.Set("Authorization", "Bearer token")
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != 502 || !strings.Contains(response.Body.String(), "UPSTREAM_UNAVAILABLE") || strings.Contains(response.Body.String(), "custom") {
			t.Fatalf("route=%s status=%d body=%s", test.route, response.Code, response.Body.String())
		}
	}
}

func TestUpstreamValidationAcceptsOpenAICompatibleExtensions(t *testing.T) {
	tests := []struct{ route, body string }{
		{"models", `{"object":"list","success":true,"data":[{"id":"gpt-5.5","object":"model","created":1,"owned_by":"newapi","supported_endpoint_types":["openai"]}]}`},
		{"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"gpt-5.5","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"completion_tokens_details":{"reasoning_tokens":0}}}`},
		{"chat", `{"id":"chatcmpl_tool","object":"chat.completion","created":1,"model":"qwen3-max","system_fingerprint":"fp_x","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":\"Shanghai\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}`},
		{"chat", `{"id":"chatcmpl_reasoning","object":"chat.completion","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"message":{"role":"assistant","content":"ok","reasoning_content":"brief chain"},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`},
	}
	for _, test := range tests {
		if !validUpstreamJSON(test.route, []byte(test.body)) {
			t.Fatalf("rejected route=%s body=%s", test.route, test.body)
		}
	}
}

func TestUpstreamValidationRejectsMalformedOpenAICompatibleExtensions(t *testing.T) {
	tests := []struct{ route, body string }{
		{"models", `{"object":"list","success":"true","data":[]}`},
		{"models", `{"object":"list","data":[{"id":"gpt-5.5","object":"model","created":1,"owned_by":"newapi","supported_endpoint_types":"openai"}]}`},
		{"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"gpt-5.5","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"completion_tokens_details":{"reasoning_tokens":-1}}}`},
		{"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"qwen3-max","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"weather"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`},
		{"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"message":{"role":"assistant","content":"ok","reasoning_content":1},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`},
	}
	for _, test := range tests {
		if validUpstreamJSON(test.route, []byte(test.body)) {
			t.Fatalf("accepted route=%s body=%s", test.route, test.body)
		}
	}
}

func TestImageResponseValidationRejectsUnknownAndMalformedExtensions(t *testing.T) {
	tests := []string{
		`{"created":1,"data":[{"b64_json":"cG5n"}],"custom":"value"}`,
		`{"created":1,"data":[{"b64_json":"cG5n"}],"background":true}`,
		`{"created":1,"data":[{"b64_json":"cG5n","revised_prompt":1}]}`,
		`{"created":1,"data":[{"url":"https://media.example.test/image.png","b64_json":"cG5n"}]}`,
		`{"created":1,"data":[{"b64_json":"cG5n"}],"usage":{"total_tokens":-1}}`,
		`{"created":1,"data":[{"b64_json":"cG5n"}],"usage":{"custom_tokens":1}}`,
		`{"created":1,"data":[{"b64_json":"cG5n"}],"usage":{"output_tokens_details":{"custom_tokens":1}}}`,
		`{"created":1,"data":[{"b64_json":"cG5n"}],"usage":{"output_tokens_details":{"image_tokens":-1}}}`,
	}
	for _, body := range tests {
		if validUpstreamJSON("images.generations", []byte(body)) {
			t.Fatalf("accepted body=%s", body)
		}
	}
}

func TestModelProxyHandlerAuthenticatesBeforeReadingBody(t *testing.T) {
	for _, body := range []string{"{", strings.Repeat("x", (1<<20)+1)} {
		service := &fakeProxyService{grant: validGrant(t)}
		h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: &http.Client{}})
		request := httptest.NewRequest(http.MethodPost, "/model-api/v1/chat/completions", strings.NewReader(body))
		request.Header["Authorization"] = []string{"Bearer one", "Bearer two"}
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != 401 || service.bearer != "" {
			t.Fatalf("status=%d bearer=%q body=%s", response.Code, service.bearer, response.Body.String())
		}
	}
}

func TestModelsAuthenticatesBeforeChunkedBodyCheck(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: &http.Client{}})
	request := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", strings.NewReader("x"))
	request.ContentLength = -1
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 401 {
		t.Fatalf("unauth status=%d", response.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "/model-api/v1/models", strings.NewReader("x"))
	request.ContentLength = -1
	request.Header.Set("Authorization", "Bearer token")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 400 {
		t.Fatalf("auth status=%d", response.Code)
	}
}

func TestUpstreamStrictValidationRejectsMissingAndWrongTypes(t *testing.T) {
	tests := []struct{ route, body string }{{"models", `{"object":"list"}`}, {"models", `{"object":"list","data":null}`}, {"models", `{"object":"list","data":[{"id":3,"object":"model","created":1,"owned_by":"owner"}]}`}, {"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"allowed","choices":[]}`}, {"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"allowed","choices":[{"index":0,"message":{"role":"assistant","content":[]},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`}, {"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"allowed","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`}, {"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"allowed","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`}, {"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"allowed","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":"1","completion_tokens":1,"total_tokens":2}}`}, {"chat", `{"id":"chatcmpl_x","object":"chat.completion","created":1,"model":"allowed","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`}}
	for _, test := range tests {
		if validUpstreamJSON(test.route, []byte(test.body)) {
			t.Fatalf("accepted route=%s body=%s", test.route, test.body)
		}
	}
}

type fakeProxyObserver struct{ outcomes []string }

func (*fakeProxyObserver) RecordModelProxyAuthRejected()          {}
func (*fakeProxyObserver) RecordModelProxyAdmissionLimited()      {}
func (*fakeProxyObserver) RecordModelProxyFinalizeFailure(string) {}
func (o *fakeProxyObserver) RecordModelProxyUpstream(outcome string, _ time.Duration) {
	o.outcomes = append(o.outcomes, outcome)
}
func TestModelProxyHandlerRejectsMalformedAuthAndStrictPayloads(t *testing.T) {
	for _, tc := range []struct {
		name, auth, body string
		status           int
	}{{"two headers", "Bearer one", `{"model":"allowed","messages":[{"role":"user","content":"x"}],"stream":false}`, 401}, {"extra whitespace", "Bearer  one", `{"model":"allowed","messages":[{"role":"user","content":"x"}],"stream":false}`, 401}, {"missing stream", "Bearer one", `{"model":"allowed","messages":[{"role":"user","content":"x"}]}`, 400}, {"unknown", "Bearer one", `{"model":"allowed","messages":[{"role":"user","content":"x"}],"stream":false,"temperature":0}`, 400}, {"role", "Bearer one", `{"model":"allowed","messages":[{"role":"tool","content":"x"}],"stream":false}`, 400}} {
		t.Run(tc.name, func(t *testing.T) {
			service := &fakeProxyService{grant: validGrant(t)}
			h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: &http.Client{}, AllowedHosts: []string{"api.example.test"}, RequestIDs: rand.Reader})
			req := httptest.NewRequest(http.MethodPost, "/model-api/v1/chat/completions", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", tc.auth)
			if tc.name == "two headers" {
				req.Header.Add("Authorization", "Bearer two")
			}
			res := httptest.NewRecorder()
			h.ServeHTTP(res, req)
			if res.Code != tc.status {
				t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
			}
			if strings.Contains(res.Body.String(), string(service.grant.APIKey)) {
				t.Fatal("secret leaked")
			}
		})
	}
}
func TestModelProxyHandlerMapsUpstreamFailuresAndRoutesExactly(t *testing.T) {
	for _, tc := range []struct {
		upstream, want int
		code           string
	}{{401, 502, "UPSTREAM_AUTHENTICATION_FAILED"}, {403, 502, "UPSTREAM_PERMISSION_DENIED"}, {429, 429, "UPSTREAM_RATE_LIMITED"}, {500, 502, "UPSTREAM_UNAVAILABLE"}} {
		service := &fakeProxyService{grant: validGrant(t)}
		client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: tc.upstream, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"secret":"upstream-body"}`))}, nil
		})}
		h := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}, RequestIDs: rand.Reader})
		req := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
		req.Header.Set("Authorization", "Bearer token")
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != tc.want || !strings.Contains(res.Body.String(), tc.code) || strings.Contains(res.Body.String(), "upstream-body") {
			t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
		}
	}
	h := NewModelProxyHandler(ModelProxyHandlerOptions{})
	res := httptest.NewRecorder()
	h.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/model-api/v1/models/", nil))
	if res.Code != 404 {
		t.Fatalf("route status=%d", res.Code)
	}
}
