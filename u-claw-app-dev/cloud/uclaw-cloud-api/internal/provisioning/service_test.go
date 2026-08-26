package provisioning

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"uclaw-cloud-api/internal/activation"
	"uclaw-cloud-api/internal/newapi"
)

type memoryAccountStore struct {
	account Account
	saved   bool
}

// SaveNewAPIAccount records the mapping for provisioning unit tests.
func (s *memoryAccountStore) SaveNewAPIAccount(_ context.Context, account Account) error {
	s.account = account
	s.saved = true
	return nil
}

func TestProvisionNewAPICreatesTokenAddsQuotaAndSavesMapping(t *testing.T) {
	var createdUser bool
	var createdToken bool
	var addedQuota bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/":
			createdUser = true
			var req newapi.CreateUserRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode create user: %v", err)
			}
			if req.Username != "13800138000" || req.Password == "" {
				t.Fatalf("create user payload = %+v", req)
			}
			_, _ = w.Write([]byte(`{"success":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"username":"13800138000"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/":
			createdToken = true
			_, _ = w.Write([]byte(`{"success":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/token/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":12,"name":"uclaw-main"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/12/key":
			_, _ = w.Write([]byte(`{"success":true,"data":{"key":"real-key-value"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/manage":
			addedQuota = true
			var req newapi.AddQuotaRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode add quota: %v", err)
			}
			if req.UserID != 9 || req.Action != "add_quota" || req.Value != 100000 {
				t.Fatalf("add quota payload = %+v", req)
			}
			_, _ = w.Write([]byte(`{"success":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	admin, err := newapi.NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	store := &memoryAccountStore{}
	service, err := NewService(admin, store, Config{
		ClientBaseURL:  server.URL + "/v1",
		TokenName:      "uclaw-main",
		InitialQuota:   100000,
		PasswordSecret: "test-password-secret",
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	service.now = func() time.Time { return time.Date(2026, 8, 27, 1, 0, 0, 0, time.UTC) }

	result, err := service.ProvisionNewAPI(context.Background(), activation.ProvisionRequest{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("ProvisionNewAPI() error = %v", err)
	}
	if !createdUser || !createdToken || !addedQuota {
		t.Fatalf("createdUser=%t createdToken=%t addedQuota=%t", createdUser, createdToken, addedQuota)
	}
	if result.NewAPIUserID != 9 || result.Token != "sk-real-key-value" || result.TokenVersion != 1 {
		t.Fatalf("result = %+v", result)
	}
	if !store.saved || store.account.UClawUserID != 5 || store.account.NewAPIUserID != 9 || store.account.TokenFingerprint == "" {
		t.Fatalf("stored account = %+v saved=%t", store.account, store.saved)
	}
}
