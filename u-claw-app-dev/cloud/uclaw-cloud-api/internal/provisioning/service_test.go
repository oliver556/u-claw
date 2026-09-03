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
	found   bool
	findErr error
}

// FindNewAPIAccount returns a preloaded mapping for provisioning idempotency tests.
func (s *memoryAccountStore) FindNewAPIAccount(_ context.Context, _ int64) (Account, bool, error) {
	return s.account, s.found, s.findErr
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
	var tokenUser string
	var tokenPayload newapi.CreateTokenRequest
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
			if req.Group != "streamer" {
				t.Fatalf("create user group = %q, want streamer", req.Group)
			}
			_, _ = w.Write([]byte(`{"success":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"username":"13800138000"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/":
			createdToken = true
			tokenUser = r.Header.Get("New-Api-User")
			if err := json.NewDecoder(r.Body).Decode(&tokenPayload); err != nil {
				t.Fatalf("decode create token: %v", err)
			}
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
		UserGroup:      "streamer",
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
	if tokenUser != "9" || tokenPayload.ExpiresAt != -1 || !tokenPayload.UnlimitedQuota {
		t.Fatalf("token user/header payload = %q %+v", tokenUser, tokenPayload)
	}
	if result.NewAPIUserID != 9 || result.Token != "sk-real-key-value" || result.TokenVersion != 1 {
		t.Fatalf("result = %+v", result)
	}
	if !store.saved || store.account.UClawUserID != 5 || store.account.NewAPIUserID != 9 || store.account.TokenFingerprint == "" {
		t.Fatalf("stored account = %+v saved=%t", store.account, store.saved)
	}
}

func TestProvisionNewAPIContinuesWhenUserAlreadyExists(t *testing.T) {
	var searched bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"success":false,"message":"ERROR: duplicate key value violates unique constraint \"users_username_key\" (SQLSTATE 23505)"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			searched = true
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"username":"13800138000"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/":
			_, _ = w.Write([]byte(`{"success":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/token/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":12,"name":"uclaw-main"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/12/key":
			_, _ = w.Write([]byte(`{"success":true,"data":{"key":"real-key-value"}}`))
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
		PasswordSecret: "test-password-secret",
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	result, err := service.ProvisionNewAPI(context.Background(), activation.ProvisionRequest{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("ProvisionNewAPI() error = %v", err)
	}

	if !searched {
		t.Fatal("existing user was not searched")
	}
	if result.NewAPIUserID != 9 || result.Token != "sk-real-key-value" {
		t.Fatalf("result = %+v", result)
	}
	if !store.saved {
		t.Fatal("mapping was not saved")
	}
}

func TestProvisionNewAPISkipsInitialQuotaWhenMappingAlreadyExists(t *testing.T) {
	var manageCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"success":false,"message":"ERROR: duplicate key value violates unique constraint \"users_username_key\" (SQLSTATE 23505)"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"username":"13800138000"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/":
			_, _ = w.Write([]byte(`{"success":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/token/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":12,"name":"uclaw-main"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/12/key":
			_, _ = w.Write([]byte(`{"success":true,"data":{"key":"real-key-value"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/manage":
			manageCalls++
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
	store := &memoryAccountStore{
		found: true,
		account: Account{
			UClawUserID:    5,
			NewAPIBaseURL:  server.URL + "/v1",
			NewAPIUserID:   9,
			NewAPIUsername: "13800138000",
		},
	}
	service, err := NewService(admin, store, Config{
		ClientBaseURL:  server.URL + "/v1",
		TokenName:      "uclaw-main",
		InitialQuota:   100000,
		PasswordSecret: "test-password-secret",
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	result, err := service.ProvisionNewAPI(context.Background(), activation.ProvisionRequest{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("ProvisionNewAPI() error = %v", err)
	}
	if result.Token != "sk-real-key-value" {
		t.Fatalf("result = %+v", result)
	}
	if manageCalls != 0 {
		t.Fatalf("AddQuota calls = %d, want 0 for an existing New API user", manageCalls)
	}
}

func TestProvisionNewAPIForceRotateUsesFreshTokenNameAndResponseKey(t *testing.T) {
	var searchedToken bool
	var tokenPayload newapi.CreateTokenRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/":
			_, _ = w.Write([]byte(`{"success":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"username":"13800138000"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/":
			if err := json.NewDecoder(r.Body).Decode(&tokenPayload); err != nil {
				t.Fatalf("decode create token: %v", err)
			}
			_, _ = w.Write([]byte(`{"success":true,"token":"fresh-key-value"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/token/search":
			searchedToken = true
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":12,"name":"uclaw-main"}]}}`))
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
		PasswordSecret: "test-password-secret",
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	service.now = func() time.Time { return time.Date(2026, 9, 2, 8, 30, 0, 0, time.UTC) }

	result, err := service.ProvisionNewAPI(context.Background(), activation.ProvisionRequest{
		UserID:           5,
		Phone:            "13800138000",
		ForceRotateToken: true,
	})
	if err != nil {
		t.Fatalf("ProvisionNewAPI() error = %v", err)
	}
	if tokenPayload.Name != "uclaw-main-20260902083000" {
		t.Fatalf("token name = %q", tokenPayload.Name)
	}
	if searchedToken {
		t.Fatal("fresh create-token response key should avoid searching old tokens")
	}
	if result.Token != "sk-fresh-key-value" || result.TokenVersion <= 1 {
		t.Fatalf("result = %+v", result)
	}
	if !store.saved || store.account.TokenFingerprint == "" {
		t.Fatalf("stored account = %+v saved=%t", store.account, store.saved)
	}
}

func TestProvisionNewAPIForceRotateFallsBackToAdminUserWhenSessionLimit(t *testing.T) {
	var tokenAuth string
	var tokenUser string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/":
			_, _ = w.Write([]byte(`{"success":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"username":"13800138000"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"AUTH_SESSION_LIMIT","message":"Conflict","success":false}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/":
			tokenAuth = r.Header.Get("Authorization")
			tokenUser = r.Header.Get("New-Api-User")
			_, _ = w.Write([]byte(`{"success":true,"token":"admin-created-key"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	admin, err := newapi.NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	service, err := NewService(admin, &memoryAccountStore{}, Config{
		ClientBaseURL:  server.URL + "/v1",
		TokenName:      "uclaw-main",
		PasswordSecret: "test-password-secret",
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	result, err := service.ProvisionNewAPI(context.Background(), activation.ProvisionRequest{
		UserID:           5,
		Phone:            "13800138000",
		ForceRotateToken: true,
	})
	if err != nil {
		t.Fatalf("ProvisionNewAPI() error = %v", err)
	}
	if tokenAuth != "Bearer admin-token" || tokenUser != "9" {
		t.Fatalf("token auth=%q user=%q", tokenAuth, tokenUser)
	}
	if result.Token != "sk-admin-created-key" {
		t.Fatalf("result = %+v", result)
	}
}
