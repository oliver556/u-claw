package newapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HTTPDoer is the seam used by tests and production HTTP clients.
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// Client wraps New API admin endpoints needed by the U-Claw activation flow.
type Client struct {
	baseURL    string
	adminToken string
	httpClient HTTPDoer
}

// NewClient creates a New API admin client with conservative timeout defaults.
func NewClient(baseURL string, adminToken string, httpClient HTTPDoer) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, fmt.Errorf("newapi baseURL is required")
	}
	if strings.TrimSpace(adminToken) == "" {
		return nil, fmt.Errorf("newapi admin token is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{
		baseURL:    baseURL,
		adminToken: strings.TrimSpace(adminToken),
		httpClient: httpClient,
	}, nil
}

// WithAccessToken reuses the same New API management base URL with a different dashboard token.
func (c *Client) WithAccessToken(accessToken string) (*Client, error) {
	return NewClient(c.baseURL, accessToken, c.httpClient)
}

// CreateUser requests a New API user creation. The exact response shape must be verified in Phase 0.
func (c *Client) CreateUser(ctx context.Context, req CreateUserRequest) error {
	return c.postJSON(ctx, "/api/user/", req, nil)
}

// AddQuota credits quota to a New API user through the admin manage endpoint.
func (c *Client) AddQuota(ctx context.Context, req AddQuotaRequest) error {
	req.Action = "add_quota"
	if req.Mode == "" {
		req.Mode = "add"
	}
	req.Value = req.Quota
	return c.postJSON(ctx, "/api/user/manage", req, nil)
}

// SearchUserByUsername finds an exact New API user by username through the admin search route.
func (c *Client) SearchUserByUsername(ctx context.Context, username string) (User, bool, error) {
	var response searchUsersResponse
	if err := c.getJSON(ctx, "/api/user/search?keyword="+url.QueryEscape(username), &response); err != nil {
		return User{}, false, err
	}
	for _, item := range response.Data.Items {
		if item.Username == username {
			return item, true, nil
		}
	}
	return User{}, false, nil
}

// Login authenticates a New API user and returns a dashboard access token.
func (c *Client) Login(ctx context.Context, username string, password string) (LoginResponse, error) {
	var response LoginResponse
	err := c.postJSONWithAuth(ctx, "/api/user/login", map[string]string{
		"username": username,
		"password": password,
	}, &response, false)
	if err != nil {
		return LoginResponse{}, err
	}
	if !response.Success || response.Data.AccessToken == "" {
		return LoginResponse{}, fmt.Errorf("newapi login failed: %s", strings.TrimSpace(response.Message))
	}
	return response, nil
}

// CreateToken requests a user token creation. Phase 0 must verify auth mode and response fields.
func (c *Client) CreateToken(ctx context.Context, req CreateTokenRequest, out *CreateTokenResponse) error {
	if out == nil {
		return c.postJSON(ctx, "/api/token/", req, nil)
	}
	return c.postJSON(ctx, "/api/token/", req, out)
}

// SearchTokenByName finds the newest exact token name visible to the current New API user.
func (c *Client) SearchTokenByName(ctx context.Context, name string) (Token, bool, error) {
	var response searchTokensResponse
	if err := c.getJSON(ctx, "/api/token/search?keyword="+url.QueryEscape(name), &response); err != nil {
		return Token{}, false, err
	}
	var newest Token
	found := false
	for _, item := range response.Data.Items {
		if item.Name != name {
			continue
		}
		if !found || item.ID > newest.ID {
			newest = item
			found = true
		}
	}
	return newest, found, nil
}

// FetchTokenKey retrieves the full API key for a token owned by the authenticated New API user.
func (c *Client) FetchTokenKey(ctx context.Context, tokenID int64) (string, error) {
	var response tokenKeyResponse
	if err := c.postJSON(ctx, fmt.Sprintf("/api/token/%d/key", tokenID), map[string]any{}, &response); err != nil {
		return "", err
	}
	key := strings.TrimSpace(response.Data.Key)
	if key == "" {
		return "", fmt.Errorf("newapi token key response is empty")
	}
	if !strings.HasPrefix(key, "sk-") {
		key = "sk-" + key
	}
	return key, nil
}

// postJSON sends a JSON admin request and decodes the optional JSON response.
func (c *Client) postJSON(ctx context.Context, path string, body any, out any) error {
	return c.postJSONWithAuth(ctx, path, body, out, true)
}

// postJSONWithAuth sends a JSON request and optionally attaches bearer auth.
func (c *Client) postJSONWithAuth(ctx context.Context, path string, body any, out any, attachAuth bool) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal newapi request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build newapi request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	if attachAuth {
		httpReq.Header.Set("Authorization", "Bearer "+c.adminToken)
	}

	return c.doJSON(httpReq, path, out)
}

// getJSON sends an authenticated GET request and decodes the JSON response.
func (c *Client) getJSON(ctx context.Context, path string, out any) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return fmt.Errorf("build newapi request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.adminToken)
	return c.doJSON(httpReq, path, out)
}

// doJSON executes a New API request and decodes the optional response body.
func (c *Client) doJSON(httpReq *http.Request, path string, out any) error {
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("send newapi request: %w", err)
	}
	defer resp.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return fmt.Errorf("read newapi response: %w", readErr)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("newapi %s returned %d: %s", path, resp.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	if out == nil || len(bytes.TrimSpace(responseBody)) == 0 {
		var status apiStatusResponse
		if err := json.Unmarshal(responseBody, &status); err == nil && !status.Success {
			return fmt.Errorf("newapi %s failed: %s", path, strings.TrimSpace(status.Message))
		}
		return nil
	}
	if err := json.Unmarshal(responseBody, out); err != nil {
		return fmt.Errorf("decode newapi response: %w", err)
	}
	if status, ok := apiStatus(out); ok && !status.success {
		return fmt.Errorf("newapi %s failed: %s", path, strings.TrimSpace(status.message))
	}
	return nil
}

type apiStatusFields struct {
	success bool
	message string
}

// apiStatus extracts the common New API success envelope from typed responses.
func apiStatus(out any) (apiStatusFields, bool) {
	switch value := out.(type) {
	case *CreateTokenResponse:
		return apiStatusFields{success: value.Success, message: value.Message}, true
	case *LoginResponse:
		return apiStatusFields{success: value.Success, message: value.Message}, true
	case *searchUsersResponse:
		return apiStatusFields{success: value.Success, message: value.Message}, true
	case *searchTokensResponse:
		return apiStatusFields{success: value.Success, message: value.Message}, true
	case *tokenKeyResponse:
		return apiStatusFields{success: value.Success, message: value.Message}, true
	default:
		return apiStatusFields{}, false
	}
}

// CreateUserRequest is the assumed Phase 0 payload for POST /api/user/.
type CreateUserRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name,omitempty"`
}

// AddQuotaRequest is the verified Phase 0 payload for POST /api/user/manage.
type AddQuotaRequest struct {
	UserID int64  `json:"id"`
	Action string `json:"action"`
	Mode   string `json:"mode"`
	Value  int64  `json:"value"`
	Quota  int64  `json:"-"`
}

// CreateTokenRequest is the assumed Phase 0 payload for POST /api/token/.
type CreateTokenRequest struct {
	Name      string `json:"name"`
	ExpiresAt int64  `json:"expired_time,omitempty"`
}

// CreateTokenResponse captures likely New API token response fields for spike verification.
type CreateTokenResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Token   string `json:"token,omitempty"`
	Key     string `json:"key,omitempty"`
}

// User is the subset of New API user records needed by U-Claw provisioning.
type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

// LoginResponse captures the dashboard access token returned by New API login.
type LoginResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Data    struct {
		AccessToken string `json:"access_token"`
	} `json:"data"`
}

// Token is the subset of New API token records needed for key retrieval.
type Token struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type searchUsersResponse struct {
	Data struct {
		Items []User `json:"items"`
	} `json:"data"`
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}

type searchTokensResponse struct {
	Data struct {
		Items []Token `json:"items"`
	} `json:"data"`
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}

type tokenKeyResponse struct {
	Data struct {
		Key string `json:"key"`
	} `json:"data"`
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}

type apiStatusResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}
