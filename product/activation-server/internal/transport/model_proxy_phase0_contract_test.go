package transport

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type phase0FlushRecorder struct {
	*httptest.ResponseRecorder
	flushes int
}

func (recorder *phase0FlushRecorder) Flush() {
	recorder.flushes++
	recorder.ResponseRecorder.Flush()
}

func TestPhase0TextChatRelaysRealMultiFrameSSE(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), `"stream":true`) {
			t.Fatalf("upstream request is not streaming: %s", body)
		}
		stream := strings.Join([]string{
			`data: {"id":"chatcmpl_contract","object":"chat.completion.chunk","created":1,"model":"allowed","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}`,
			"",
			`data: {"id":"chatcmpl_contract","object":"chat.completion.chunk","created":1,"model":"allowed","choices":[{"index":0,"delta":{"content":" second"},"finish_reason":null}]}`,
			"",
			`data: {"id":"chatcmpl_contract","object":"chat.completion.chunk","created":1,"model":"allowed","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
			"",
			"data: [DONE]",
			"",
		}, "\n")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader(stream)),
		}, nil
	})}
	handler := NewModelProxyHandler(ModelProxyHandlerOptions{
		Service: service, Client: client, AllowedHosts: []string{"api.example.test"},
	})
	request := contractJSONRequest("/model-api/v1/chat/completions", `{"model":"allowed","messages":[{"role":"user","content":"hello"}],"stream":true}`)
	response := &phase0FlushRecorder{ResponseRecorder: httptest.NewRecorder()}

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content-type=%q", got)
	}
	if frames := strings.Count(response.Body.String(), "data: "); frames < 4 {
		t.Fatalf("want multiple SSE frames plus [DONE], got %d: %s", frames, response.Body.String())
	}
	if response.flushes < 2 {
		t.Fatalf("want SSE flushed incrementally, flushes=%d", response.flushes)
	}
}

func TestPhase0ToolCallingRelaysToolDeltas(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{`"tools"`, `"tool_choice":"auto"`, `"stream":true`} {
			if !strings.Contains(string(body), field) {
				t.Fatalf("missing %s in upstream body: %s", field, body)
			}
		}
		stream := "data: {\"id\":\"chatcmpl_tool\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"allowed\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\"}}]},\"finish_reason\":null}]}\n\n" +
			"data: {\"id\":\"chatcmpl_tool\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"allowed\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"Shanghai\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n" +
			"data: [DONE]\n\n"
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(stream))}, nil
	})}
	handler := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
	request := contractJSONRequest("/model-api/v1/chat/completions", `{"model":"allowed","messages":[{"role":"user","content":"weather"}],"stream":true,"tools":[{"type":"function","function":{"name":"weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"auto"}`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || strings.Count(response.Body.String(), `"tool_calls"`) < 2 || !strings.Contains(response.Body.String(), "data: [DONE]") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPhase0ImageGenerationContract(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/images/generations" || request.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("path=%s content-type=%s", request.URL.Path, request.Header.Get("Content-Type"))
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{`"model":"allowed"`, `"prompt":"red panda"`} {
			if !strings.Contains(string(body), field) {
				t.Fatalf("missing %s in body: %s", field, body)
			}
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"created":1,"data":[{"url":"https://media.example.test/generated.png"}]}`))}, nil
	})}
	handler := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
	request := contractJSONRequest("/model-api/v1/images/generations", `{"model":"allowed","prompt":"red panda","size":"1024x1024"}`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "generated.png") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPhase0ImageEditForwardsRestrictedMultipartReferences(t *testing.T) {
	service := &fakeProxyService{grant: validGrant(t)}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/images/edits" {
			t.Fatalf("path=%s", request.URL.Path)
		}
		if err := request.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		if request.FormValue("prompt") != "add a hat" || request.FormValue("model") != "allowed" {
			t.Fatalf("form=%v", request.MultipartForm.Value)
		}
		if len(request.MultipartForm.Value) != 2 || len(request.MultipartForm.File) != 1 || len(request.MultipartForm.File["image[]"]) != 1 {
			t.Fatalf("unrestricted multipart forwarded: values=%v files=%v", request.MultipartForm.Value, request.MultipartForm.File)
		}
		image := request.MultipartForm.File["image[]"][0]
		if image.Filename != "reference.png" || image.Size != int64(len("png-reference")) {
			t.Fatalf("image=%+v", image)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"created":1,"data":[{"url":"https://media.example.test/edited.png"}]}`))}, nil
	})}
	handler := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	_ = form.WriteField("model", "allowed")
	_ = form.WriteField("prompt", "add a hat")
	file, err := form.CreateFormFile("image[]", "reference.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("png-reference"))
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/model-api/v1/images/edits", body)
	request.Header.Set("Authorization", "Bearer device-token")
	request.Header.Set("Content-Type", form.FormDataContentType())
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "edited.png") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPhase0ModelsCatalogIsGlobalAndDynamic(t *testing.T) {
	upstreamModels := `{"object":"list","data":[{"id":"deepseek-chat","object":"model","created":1,"owned_by":"newapi"},{"id":"qwen-plus","object":"model","created":1,"owned_by":"newapi"},{"id":"doubao-pro","object":"model","created":1,"owned_by":"newapi"}]}`
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/models" {
			t.Fatalf("path=%s", request.URL.Path)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(upstreamModels))}, nil
	})}

	responses := make([]string, 0, 2)
	for _, legacyDeviceModels := range [][]string{{"deepseek-chat"}, {"qwen-plus"}} {
		grant := validGrant(t)
		grant.Authorization.AllowedModels = legacyDeviceModels
		service := &fakeProxyService{grant: grant}
		handler := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
		request := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
		request.Header.Set("Authorization", "Bearer device-token")
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		responses = append(responses, response.Body.String())
	}
	if responses[0] != responses[1] {
		t.Fatalf("catalog differs by device: first=%s second=%s", responses[0], responses[1])
	}
	for _, model := range []string{"deepseek-chat", "qwen-plus", "doubao-pro"} {
		if !strings.Contains(responses[0], model) {
			t.Fatalf("dynamic global model %q missing: %s", model, responses[0])
		}
	}
}

func TestPhase0ProxyErrorsAreDistinctAndSecretSafe(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		transport  error
		wantStatus int
		wantCode   string
	}{
		{name: "upstream 401", status: 401, body: `{"error":{"code":"invalid_api_key","message":"bad key"}}`, wantStatus: 502, wantCode: "UPSTREAM_AUTHENTICATION_FAILED"},
		{name: "upstream 403", status: 403, body: `{"error":{"code":"permission_denied","message":"forbidden"}}`, wantStatus: 502, wantCode: "UPSTREAM_PERMISSION_DENIED"},
		{name: "rate limited", status: 429, body: `{"error":{"code":"rate_limit_exceeded","message":"slow down"}}`, wantStatus: 429, wantCode: "UPSTREAM_RATE_LIMITED"},
		{name: "balance insufficient", status: 429, body: `{"error":{"code":"insufficient_quota","message":"balance exhausted"}}`, wantStatus: 402, wantCode: "BALANCE_INSUFFICIENT"},
		{name: "upstream 5xx", status: 503, body: `{"error":{"code":"overloaded","message":"retry"}}`, wantStatus: 502, wantCode: "UPSTREAM_UNAVAILABLE"},
		{name: "timeout", transport: context.DeadlineExceeded, wantStatus: 504, wantCode: "UPSTREAM_TIMEOUT"},
		{name: "model missing", status: 404, body: `{"error":{"code":"model_not_found","message":"missing"}}`, wantStatus: 404, wantCode: "MODEL_NOT_FOUND"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeProxyService{grant: validGrant(t)}
			apiKey := string(service.grant.APIKey)
			deviceToken := `uclaw_dt_` + strings.Repeat("D", 43)
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				if test.transport != nil {
					return nil, test.transport
				}
				secretBody := strings.TrimSuffix(test.body, "}") + `,"debug":"Authorization: Bearer ` + apiKey + ` ` + deviceToken + `"}`
				return &http.Response{StatusCode: test.status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(secretBody))}, nil
			})}
			handler := NewModelProxyHandler(ModelProxyHandlerOptions{Service: service, Client: client, AllowedHosts: []string{"api.example.test"}})
			request := httptest.NewRequest(http.MethodGet, "/model-api/v1/models", nil)
			request.Header.Set("Authorization", "Bearer "+deviceToken)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			content := response.Body.String()
			if response.Code != test.wantStatus || !strings.Contains(content, test.wantCode) {
				t.Fatalf("status=%d want=%d code=%s body=%s", response.Code, test.wantStatus, test.wantCode, content)
			}
			for _, secret := range []string{apiKey, "Authorization: Bearer", deviceToken} {
				if strings.Contains(content, secret) {
					t.Fatalf("secret %q leaked: %s", secret, content)
				}
			}
		})
	}
}

func contractJSONRequest(route, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer device-token")
	request.Header.Set("Content-Type", "application/json")
	return request
}
