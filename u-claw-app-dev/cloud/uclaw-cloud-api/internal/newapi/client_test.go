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
