package modelcatalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"uclaw-cloud-api/internal/newapi"
	"uclaw-cloud-api/internal/provisioning"
)

func TestGetCatalogLogsInAndNormalizesModels(t *testing.T) {
	now := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	secret := "test-password-secret"
	expectedPassword := provisioning.DeriveUserPassword(5, "13800138000", secret)
	var sawLogin bool
	var sawModels bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			sawLogin = true
			var req map[string]string
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode login: %v", err)
			}
			if req["username"] != "13800138000" || req["password"] != expectedPassword {
				t.Fatalf("login payload = %+v", req)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/models":
			sawModels = true
			if r.Header.Get("Authorization") != "Bearer user-access-token" {
				t.Fatalf("models Authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"2":["gpt-image-2"],"1":["gpt-5.5","gpt-5.5","jimeng-video-3-720p","seedance-1.5-pro-1080p-10s"]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	admin, err := newapi.NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	service, err := NewService(admin, Config{
		PasswordSecret: secret,
		ClientBaseURL:  "https://api.example.com/v1/",
		CacheTTL:       time.Minute,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	service.now = func() time.Time { return now }

	catalog, err := service.GetCatalog(context.Background(), Request{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("GetCatalog() error = %v", err)
	}
	if !sawLogin || !sawModels {
		t.Fatalf("sawLogin=%t sawModels=%t", sawLogin, sawModels)
	}
	if catalog.Status != "ok" || catalog.Source != "newapi:/api/user/models" {
		t.Fatalf("catalog status/source = %+v", catalog)
	}
	if catalog.Provider.ID != "newapi" || catalog.Provider.BaseURL != "https://api.example.com/v1" || catalog.Provider.API != "openai-completions" {
		t.Fatalf("provider = %+v", catalog.Provider)
	}
	if len(catalog.Models) != 4 || catalog.Models[0].ID != "gpt-5.5" || catalog.Models[0].Channels[0] != "1" {
		t.Fatalf("models = %+v", catalog.Models)
	}
	if catalog.Models[1].Capabilities[0] != "image" || catalog.Models[2].Capabilities[0] != "video" || catalog.Models[3].Capabilities[0] != "video" {
		t.Fatalf("capabilities = %+v", catalog.Models)
	}
	if catalog.RefreshedAt != "2026-08-29T12:00:00Z" || catalog.Cache.TTLSeconds != 60 || catalog.Cache.Hit {
		t.Fatalf("cache/refreshed = %+v", catalog)
	}
}

func TestGetCatalogReturnsFreshCacheWithinTTL(t *testing.T) {
	var loginCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			loginCalls++
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/models":
			_, _ = w.Write([]byte(`{"success":true,"data":{"1":["gpt-5.5"]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	admin, err := newapi.NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	service, err := NewService(admin, Config{PasswordSecret: "secret", ClientBaseURL: "https://api.example.com/v1", CacheTTL: time.Hour})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	first, err := service.GetCatalog(context.Background(), Request{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("first GetCatalog() error = %v", err)
	}
	second, err := service.GetCatalog(context.Background(), Request{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("second GetCatalog() error = %v", err)
	}
	if loginCalls != 1 {
		t.Fatalf("loginCalls = %d, want 1", loginCalls)
	}
	if first.Cache.Hit || !second.Cache.Hit || second.Cache.Stale {
		t.Fatalf("cache flags first=%+v second=%+v", first.Cache, second.Cache)
	}
}

func TestGetCatalogReturnsStaleCacheAfterRefreshFailure(t *testing.T) {
	var fail bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if fail {
			http.Error(w, "upstream down", http.StatusBadGateway)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/models":
			_, _ = w.Write([]byte(`{"success":true,"data":{"1":["gpt-5.5"]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	admin, err := newapi.NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	service, err := NewService(admin, Config{PasswordSecret: "secret", ClientBaseURL: "https://api.example.com/v1", CacheTTL: time.Nanosecond})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	_, err = service.GetCatalog(context.Background(), Request{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("warm GetCatalog() error = %v", err)
	}

	time.Sleep(time.Millisecond)
	fail = true
	catalog, err := service.GetCatalog(context.Background(), Request{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("stale GetCatalog() error = %v", err)
	}
	if catalog.Status != "stale" || !catalog.Cache.Hit || !catalog.Cache.Stale || len(catalog.Warnings) != 1 {
		t.Fatalf("catalog = %+v", catalog)
	}
	if len(catalog.Models) != 1 || catalog.Models[0].ID != "gpt-5.5" {
		t.Fatalf("models = %+v", catalog.Models)
	}
}

func TestNewServiceRejectsMissingPasswordSecret(t *testing.T) {
	admin, err := newapi.NewClient("http://127.0.0.1:3000", "admin-token", nil)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	_, err = NewService(admin, Config{ClientBaseURL: "https://api.example.com/v1"})
	if err == nil {
		t.Fatal("NewService() error = nil, want password secret error")
	}
}
