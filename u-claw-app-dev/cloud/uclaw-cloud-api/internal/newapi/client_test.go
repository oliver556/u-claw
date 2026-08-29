package newapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateUserSendsAdminJSONRequest(t *testing.T) {
	var gotPath string
	var gotAuth string
	var gotPayload CreateUserRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatalf("Decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL+"/", "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	err = client.CreateUser(context.Background(), CreateUserRequest{
		Username:    "13800138000",
		Password:    "random-password",
		DisplayName: "13800138000",
	})
	if err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}

	if gotPath != "/api/user/" {
		t.Fatalf("path = %q, want /api/user/", gotPath)
	}
	if gotAuth != "Bearer admin-token" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotPayload.Username != "13800138000" || gotPayload.Password != "random-password" {
		t.Fatalf("payload = %+v", gotPayload)
	}
}

func TestAddQuotaReturnsStatusError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "quota failed", http.StatusBadGateway)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	err = client.AddQuota(context.Background(), AddQuotaRequest{UserID: 42, Quota: 1000})
	if err == nil {
		t.Fatal("AddQuota() error = nil, want status error")
	}
}

func TestCreateUserRejectsBusinessFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":false,"message":"invalid password"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	err = client.CreateUser(context.Background(), CreateUserRequest{Username: "13800138000", Password: "bad"})
	if err == nil {
		t.Fatal("CreateUser() error = nil, want business failure")
	}
}

func TestAddQuotaSendsManageActionPayload(t *testing.T) {
	var gotPayload AddQuotaRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatalf("Decode request body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	err = client.AddQuota(context.Background(), AddQuotaRequest{UserID: 42, Quota: 1000})
	if err != nil {
		t.Fatalf("AddQuota() error = %v", err)
	}

	if gotPayload.UserID != 42 || gotPayload.Action != "add_quota" || gotPayload.Mode != "add" || gotPayload.Value != 1000 {
		t.Fatalf("payload = %+v", gotPayload)
	}
}

func TestCreateTokenDecodesTokenPresence(t *testing.T) {
	var gotPath string
	var gotUser string
	var gotPayload CreateTokenRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotUser = r.Header.Get("New-Api-User")
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatalf("Decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"token":"secret-token-value"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "admin-token", server.Client(), WithUserID(9))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	var response CreateTokenResponse
	err = client.CreateToken(context.Background(), CreateTokenRequest{Name: "uclaw-main", ExpiresAt: -1, UnlimitedQuota: true}, &response)
	if err != nil {
		t.Fatalf("CreateToken() error = %v", err)
	}

	if gotPath != "/api/token/" {
		t.Fatalf("path = %q, want /api/token/", gotPath)
	}
	if gotPayload.Name != "uclaw-main" {
		t.Fatalf("token name = %q", gotPayload.Name)
	}
	if gotUser != "9" {
		t.Fatalf("New-Api-User = %q, want 9", gotUser)
	}
	if gotPayload.ExpiresAt != -1 || !gotPayload.UnlimitedQuota {
		t.Fatalf("token lifetime/quota payload = %+v", gotPayload)
	}
	if !response.Success || response.Token == "" {
		t.Fatalf("response = %+v", response)
	}
}

func TestSearchUserByUsernameFindsExactMatch(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":7,"username":"13800138000"}]}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	user, ok, err := client.SearchUserByUsername(context.Background(), "13800138000")
	if err != nil {
		t.Fatalf("SearchUserByUsername() error = %v", err)
	}
	if !ok || user.ID != 7 {
		t.Fatalf("user = %+v ok = %t", user, ok)
	}
	if gotPath != "/api/user/search?keyword=13800138000" {
		t.Fatalf("path = %q", gotPath)
	}
}

func TestAdminRequestRefreshesTokenAndRetriesOnce(t *testing.T) {
	var loginCalls int
	var searchCalls int
	var searchAuth []string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			searchCalls++
			searchAuth = append(searchAuth, r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "application/json")
			if searchCalls == 1 {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"code":"AUTH_TOKEN_EXPIRED","message":"Unauthorized","success":false}`))
				return
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":7,"username":"13800138000"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			loginCalls++
			if gotAuth := r.Header.Get("Authorization"); gotAuth != "" {
				t.Fatalf("login Authorization = %q, want empty", gotAuth)
			}
			var payload map[string]string
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("Decode login request body: %v", err)
			}
			if payload["username"] != "admin" || payload["password"] != "password" {
				t.Fatalf("login payload = %+v", payload)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"fresh-token"}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "expired-token", server.Client(), WithAdminCredentials("admin", "password"))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	user, ok, err := client.SearchUserByUsername(context.Background(), "13800138000")
	if err != nil {
		t.Fatalf("SearchUserByUsername() error = %v", err)
	}
	if !ok || user.ID != 7 {
		t.Fatalf("user = %+v ok = %t", user, ok)
	}
	if loginCalls != 1 || searchCalls != 2 {
		t.Fatalf("loginCalls = %d searchCalls = %d", loginCalls, searchCalls)
	}
	if searchAuth[0] != "Bearer expired-token" || searchAuth[1] != "Bearer fresh-token" {
		t.Fatalf("search auth = %+v", searchAuth)
	}
}

func TestAdminRequestKeepsUnauthorizedErrorWithoutRefreshCredentials(t *testing.T) {
	var searchCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		searchCalls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"AUTH_TOKEN_EXPIRED","message":"Unauthorized","success":false}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "expired-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	_, _, err = client.SearchUserByUsername(context.Background(), "13800138000")
	if err == nil {
		t.Fatal("SearchUserByUsername() error = nil, want unauthorized")
	}
	if searchCalls != 1 {
		t.Fatalf("searchCalls = %d, want 1", searchCalls)
	}
}

func TestLoginReturnsAccessTokenWithoutBearer(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	result, err := client.Login(context.Background(), "13800138000", "password")
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if gotAuth != "" {
		t.Fatalf("Authorization = %q, want empty", gotAuth)
	}
	if result.Data.AccessToken != "user-access-token" {
		t.Fatalf("access token = %q", result.Data.AccessToken)
	}
}

func TestSearchTokenByNameFindsNewestExactName(t *testing.T) {
	var gotUser string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser = r.Header.Get("New-Api-User")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":3,"name":"uclaw-main"},{"id":4,"name":"other"},{"id":5,"name":"uclaw-main"}]}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "user-token", server.Client(), WithUserID(9))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	token, ok, err := client.SearchTokenByName(context.Background(), "uclaw-main")
	if err != nil {
		t.Fatalf("SearchTokenByName() error = %v", err)
	}
	if !ok || token.ID != 5 {
		t.Fatalf("token = %+v ok = %t", token, ok)
	}
	if gotUser != "9" {
		t.Fatalf("New-Api-User = %q, want 9", gotUser)
	}
}

func TestFetchTokenKeyAddsOpenAIStylePrefix(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/token/7/key" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"key":"real-key-value"}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "user-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	key, err := client.FetchTokenKey(context.Background(), 7)
	if err != nil {
		t.Fatalf("FetchTokenKey() error = %v", err)
	}
	if key != "sk-real-key-value" {
		t.Fatalf("key = %q", key)
	}
}

func TestGetSelfReturnsQuotaCounters(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/api/user/self" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"id":26,"username":"13800138000","quota":12345,"used_quota":678,"request_count":9}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "user-access-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	user, err := client.GetSelf(context.Background())
	if err != nil {
		t.Fatalf("GetSelf() error = %v", err)
	}
	if gotAuth != "Bearer user-access-token" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if user.ID != 26 || user.Quota != 12345 || user.UsedQuota != 678 || user.RequestCount != 9 {
		t.Fatalf("user = %+v", user)
	}
}

func TestListSelfLogsReturnsPagedItems(t *testing.T) {
	var gotURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"page":1,"page_size":2,"total":1,"items":[{"id":1,"created_at":1787762761,"model_name":"gpt-5.5","quota":42,"prompt_tokens":10,"completion_tokens":5,"request_id":"req_1"}]}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "user-access-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	page, err := client.ListSelfLogs(context.Background(), 0, 2)
	if err != nil {
		t.Fatalf("ListSelfLogs() error = %v", err)
	}
	if gotURL != "/api/log/self?p=0&page_size=2" {
		t.Fatalf("url = %q", gotURL)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].Quota != 42 {
		t.Fatalf("page = %+v", page)
	}
}

func TestListUserModelsParsesChannelMap(t *testing.T) {
	var gotAuth string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"1":["gpt-5.5","gpt-5.5",""],"2":["gpt-image-2"]}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "user-access-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	models, err := client.ListUserModels(context.Background())
	if err != nil {
		t.Fatalf("ListUserModels() error = %v", err)
	}
	if gotPath != "/api/user/models" {
		t.Fatalf("path = %q, want /api/user/models", gotPath)
	}
	if gotAuth != "Bearer user-access-token" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if len(models["1"]) != 1 || models["1"][0] != "gpt-5.5" || len(models["2"]) != 1 || models["2"][0] != "gpt-image-2" {
		t.Fatalf("models = %+v", models)
	}
}
