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
	var gotPayload CreateTokenRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatalf("Decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"token":"secret-token-value"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	var response CreateTokenResponse
	err = client.CreateToken(context.Background(), CreateTokenRequest{Name: "uclaw-main"}, &response)
	if err != nil {
		t.Fatalf("CreateToken() error = %v", err)
	}

	if gotPath != "/api/token/" {
		t.Fatalf("path = %q, want /api/token/", gotPath)
	}
	if gotPayload.Name != "uclaw-main" {
		t.Fatalf("token name = %q", gotPayload.Name)
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
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":3,"name":"uclaw-main"},{"id":4,"name":"other"},{"id":5,"name":"uclaw-main"}]}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "user-token", server.Client())
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
