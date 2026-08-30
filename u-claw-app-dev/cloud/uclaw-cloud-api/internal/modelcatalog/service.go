package modelcatalog

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"uclaw-cloud-api/internal/newapi"
	"uclaw-cloud-api/internal/provisioning"
)

// Config controls how Bavi-box reads and caches New API model permissions.
type Config struct {
	PasswordSecret string
	ClientBaseURL  string
	CacheTTL       time.Duration
}

// NewAPIClient is the subset of the New API client required by the catalog read path.
type NewAPIClient interface {
	Login(ctx context.Context, username string, password string) (newapi.LoginResponse, error)
	WithAccessToken(accessToken string, userID ...int64) (*newapi.Client, error)
}

// Service reads user-visible New API model permissions and normalizes them for desktop config.
type Service struct {
	admin NewAPIClient
	cfg   Config
	now   func() time.Time
	mu    sync.Mutex
	cache map[string]cacheEntry
}

// Request identifies the authenticated Bavi-box user whose model catalog should be read.
type Request struct {
	UserID int64
	Phone  string
}

// Catalog is the stable client payload for New API model discovery.
type Catalog struct {
	Status      string       `json:"status"`
	Source      string       `json:"source"`
	Provider    Provider     `json:"provider"`
	Models      []Model      `json:"models"`
	Warnings    []string     `json:"warnings,omitempty"`
	RefreshedAt string       `json:"refreshedAt"`
	Cache       CacheDetails `json:"cache"`
}

// Provider describes the OpenClaw provider that should receive catalog models.
type Provider struct {
	ID      string `json:"id"`
	BaseURL string `json:"baseUrl"`
	API     string `json:"api"`
}

// Model is one New API model entry normalized for OpenClaw provider config.
type Model struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Channels     []string `json:"channels,omitempty"`
	Capabilities []string `json:"capabilities"`
}

// CacheDetails exposes whether a returned catalog is live or stale without leaking credentials.
type CacheDetails struct {
	Hit        bool   `json:"hit"`
	Stale      bool   `json:"stale"`
	TTLSeconds int64  `json:"ttlSeconds"`
	Message    string `json:"message,omitempty"`
}

type cacheEntry struct {
	catalog Catalog
	expires time.Time
}

// NewService creates a New API model catalog service.
func NewService(admin NewAPIClient, cfg Config) (*Service, error) {
	if admin == nil {
		return nil, fmt.Errorf("newapi client is required")
	}
	if strings.TrimSpace(cfg.PasswordSecret) == "" {
		return nil, fmt.Errorf("newapi user password secret is required")
	}
	cfg.ClientBaseURL = strings.TrimRight(strings.TrimSpace(cfg.ClientBaseURL), "/")
	if cfg.ClientBaseURL == "" {
		return nil, fmt.Errorf("newapi client base url is required")
	}
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 10 * time.Minute
	}
	return &Service{admin: admin, cfg: cfg, now: time.Now, cache: map[string]cacheEntry{}}, nil
}

// GetCatalog logs in as the activated New API user and returns a normalized model catalog.
func (s *Service) GetCatalog(ctx context.Context, req Request) (Catalog, error) {
	phone := strings.TrimSpace(req.Phone)
	if req.UserID <= 0 {
		return Catalog{}, fmt.Errorf("uclaw user id is required")
	}
	if phone == "" {
		return Catalog{}, fmt.Errorf("phone is required")
	}

	cacheKey := fmt.Sprintf("%d:%s", req.UserID, phone)
	if cached, ok := s.cached(cacheKey); ok {
		return cached, nil
	}

	catalog, err := s.fetchCatalog(ctx, req.UserID, phone)
	if err != nil {
		if stale, ok := s.stale(cacheKey, err); ok {
			return stale, nil
		}
		return Catalog{}, err
	}
	s.remember(cacheKey, catalog)
	return catalog, nil
}

// fetchCatalog performs the live New API calls for one user.
func (s *Service) fetchCatalog(ctx context.Context, userID int64, phone string) (Catalog, error) {
	password := provisioning.DeriveUserPassword(userID, phone, s.cfg.PasswordSecret)
	login, err := s.admin.Login(ctx, phone, password)
	if err != nil {
		return Catalog{}, err
	}
	userClient, err := s.admin.WithAccessToken(login.Data.AccessToken)
	if err != nil {
		return Catalog{}, err
	}
	models, err := userClient.ListUserModels(ctx)
	if err != nil {
		return Catalog{}, err
	}
	return s.buildCatalog(models, false, ""), nil
}

// buildCatalog folds New API's channel map into unique, sorted model records.
func (s *Service) buildCatalog(models newapi.UserModels, stale bool, message string) Catalog {
	byName := map[string]*Model{}
	for channelID, names := range models {
		for _, rawName := range names {
			name := strings.TrimSpace(rawName)
			if name == "" {
				continue
			}
			item := byName[name]
			if item == nil {
				item = &Model{
					ID:           name,
					Name:         name,
					Capabilities: classifyCapabilities(name),
				}
				byName[name] = item
			}
			channel := strings.TrimSpace(channelID)
			if channel != "" && !contains(item.Channels, channel) {
				item.Channels = append(item.Channels, channel)
			}
		}
	}

	normalized := make([]Model, 0, len(byName))
	for _, item := range byName {
		sort.Strings(item.Channels)
		normalized = append(normalized, *item)
	}
	sort.Slice(normalized, func(i, j int) bool {
		return normalized[i].ID < normalized[j].ID
	})

	status := "ok"
	warnings := []string(nil)
	if stale {
		status = "stale"
		if message != "" {
			warnings = append(warnings, message)
		}
	}

	return Catalog{
		Status: status,
		Source: "newapi:/api/user/models",
		Provider: Provider{
			ID:      "newapi",
			BaseURL: s.cfg.ClientBaseURL,
			API:     "openai-completions",
		},
		Models:      normalized,
		Warnings:    warnings,
		RefreshedAt: s.now().UTC().Format(time.RFC3339),
		Cache: CacheDetails{
			Hit:        stale,
			Stale:      stale,
			TTLSeconds: int64(s.cfg.CacheTTL.Seconds()),
			Message:    message,
		},
	}
}

// cached returns a fresh cached catalog when the TTL has not expired.
func (s *Service) cached(key string) (Catalog, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.cache[key]
	if !ok || !s.now().Before(entry.expires) {
		return Catalog{}, false
	}
	catalog := entry.catalog
	catalog.Cache.Hit = true
	catalog.Cache.Stale = false
	catalog.Cache.Message = ""
	return catalog, true
}

// stale returns the last successful catalog when New API is temporarily unavailable.
func (s *Service) stale(key string, cause error) (Catalog, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.cache[key]
	if !ok {
		return Catalog{}, false
	}
	message := fmt.Sprintf("New API model catalog refresh failed; showing last successful catalog: %s", cause.Error())
	catalog := entry.catalog
	catalog.Status = "stale"
	catalog.Warnings = []string{message}
	catalog.Cache.Hit = true
	catalog.Cache.Stale = true
	catalog.Cache.Message = message
	return catalog, true
}

// remember stores the latest successful live catalog for later stale fallback.
func (s *Service) remember(key string, catalog Catalog) {
	s.mu.Lock()
	defer s.mu.Unlock()
	catalog.Cache.Hit = false
	catalog.Cache.Stale = false
	catalog.Cache.Message = ""
	s.cache[key] = cacheEntry{catalog: catalog, expires: s.now().Add(s.cfg.CacheTTL)}
}

// classifyCapabilities marks likely OpenClaw capability buckets from model naming conventions.
func classifyCapabilities(model string) []string {
	lower := strings.ToLower(model)
	switch {
	case strings.Contains(lower, "video") || strings.Contains(lower, "jimeng") || strings.Contains(lower, "kling") || strings.Contains(lower, "runway") || strings.Contains(lower, "seedance"):
		return []string{"video"}
	case strings.Contains(lower, "image") || strings.Contains(lower, "dall") || strings.Contains(lower, "flux") || strings.Contains(lower, "midjourney"):
		return []string{"image"}
	default:
		return []string{"text"}
	}
}

// contains reports whether a string slice already includes value.
func contains(values []string, value string) bool {
	for _, existing := range values {
		if existing == value {
			return true
		}
	}
	return false
}
