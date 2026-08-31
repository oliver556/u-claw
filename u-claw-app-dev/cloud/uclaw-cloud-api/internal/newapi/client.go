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
	"sync"
	"time"
)

// HTTPDoer is the seam used by tests and production HTTP clients.
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// Client wraps New API admin endpoints needed by the Bavi-box activation flow.
type Client struct {
	baseURL              string
	adminToken           string
	adminRefreshUsername string
	adminRefreshPassword string
	httpClient           HTTPDoer
	userID               int64
	tokenMu              sync.RWMutex
	refreshMu            sync.Mutex
}

// Option customizes New API client behavior without changing existing call sites.
type Option func(*Client)

// WithAdminCredentials enables one-shot admin token refresh after a 401 response.
func WithAdminCredentials(username string, password string) Option {
	return func(c *Client) {
		c.adminRefreshUsername = strings.TrimSpace(username)
		c.adminRefreshPassword = strings.TrimSpace(password)
	}
}

// WithUserID adds New API's dashboard user header for user-scoped token APIs.
func WithUserID(userID int64) Option {
	return func(c *Client) {
		c.userID = userID
	}
}

// NewClient creates a New API admin client with conservative timeout defaults.
func NewClient(baseURL string, adminToken string, httpClient HTTPDoer, options ...Option) (*Client, error) {
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
	client := &Client{
		baseURL:    baseURL,
		adminToken: strings.TrimSpace(adminToken),
		httpClient: httpClient,
	}
	for _, option := range options {
		if option != nil {
			option(client)
		}
	}
	return client, nil
}

// WithAccessToken reuses the same New API management base URL with a different dashboard token.
func (c *Client) WithAccessToken(accessToken string, userID ...int64) (*Client, error) {
	var options []Option
	if len(userID) > 0 && userID[0] > 0 {
		options = append(options, WithUserID(userID[0]))
	}
	return NewClient(c.baseURL, accessToken, c.httpClient, options...)
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

// GetUser returns a New API user record through the admin detail endpoint.
func (c *Client) GetUser(ctx context.Context, userID int64) (SelfUser, error) {
	if userID <= 0 {
		return SelfUser{}, fmt.Errorf("newapi user id is required")
	}
	var response selfUserResponse
	if err := c.getJSON(ctx, fmt.Sprintf("/api/user/%d", userID), &response); err != nil {
		return SelfUser{}, err
	}
	if response.Data.ID <= 0 {
		return SelfUser{}, fmt.Errorf("newapi user response has no user id")
	}
	return response.Data, nil
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

// GetSelf returns the authenticated New API dashboard user profile and quota counters.
func (c *Client) GetSelf(ctx context.Context) (SelfUser, error) {
	var response selfUserResponse
	if err := c.getJSON(ctx, "/api/user/self", &response); err != nil {
		return SelfUser{}, err
	}
	if response.Data.ID <= 0 {
		return SelfUser{}, fmt.Errorf("newapi self response has no user id")
	}
	return response.Data, nil
}

// ListLogsByUsername returns recent New API logs for one user through the admin log endpoint.
func (c *Client) ListLogsByUsername(ctx context.Context, username string, page int, pageSize int) (SelfLogsPage, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return SelfLogsPage{}, fmt.Errorf("newapi username is required")
	}
	if page < 0 {
		page = 0
	}
	if pageSize <= 0 {
		pageSize = 50
	}
	var response selfLogsResponse
	path := fmt.Sprintf("/api/log/?p=%d&page_size=%d&username=%s", page, pageSize, url.QueryEscape(username))
	if err := c.getJSON(ctx, path, &response); err != nil {
		return SelfLogsPage{}, err
	}
	return response.Data, nil
}

// ListSelfLogs returns recent logs visible to the authenticated New API dashboard user.
func (c *Client) ListSelfLogs(ctx context.Context, page int, pageSize int) (SelfLogsPage, error) {
	if page < 0 {
		page = 0
	}
	if pageSize <= 0 {
		pageSize = 50
	}
	var response selfLogsResponse
	path := fmt.Sprintf("/api/log/self?p=%d&page_size=%d", page, pageSize)
	if err := c.getJSON(ctx, path, &response); err != nil {
		return SelfLogsPage{}, err
	}
	return response.Data, nil
}

// ListUserModels returns the model permissions visible to the authenticated New API user.
func (c *Client) ListUserModels(ctx context.Context) (UserModels, error) {
	var response userModelsResponse
	if err := c.getJSON(ctx, "/api/user/models", &response); err != nil {
		return UserModels{}, err
	}
	models, err := response.UserModels()
	if err != nil {
		return UserModels{}, err
	}
	return models, nil
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
		httpReq.Header.Set("Authorization", "Bearer "+c.adminTokenSnapshot())
	}

	return c.doJSON(httpReq, path, out, attachAuth)
}

// getJSON sends an authenticated GET request and decodes the JSON response.
func (c *Client) getJSON(ctx context.Context, path string, out any) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return fmt.Errorf("build newapi request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.adminTokenSnapshot())
	return c.doJSON(httpReq, path, out, true)
}

// doJSON executes a New API request and decodes the optional response body.
func (c *Client) doJSON(httpReq *http.Request, path string, out any, attachAuth bool) error {
	bodyBytes, err := drainRequestBody(httpReq)
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, usedToken, err := c.cloneRequest(httpReq, bodyBytes, attachAuth)
		if err != nil {
			return err
		}
		err = c.doJSONOnce(req, path, out)
		if err == nil {
			return nil
		}
		lastErr = err
		if !isUnauthorizedNewAPIError(err) || !attachAuth || attempt > 0 || !c.canRefreshAdminToken() {
			return err
		}
		if refreshErr := c.refreshAdminToken(httpReq.Context(), usedToken); refreshErr != nil {
			return refreshErr
		}
	}
	return lastErr
}

// doJSONOnce sends a single HTTP request and decodes its response.
func (c *Client) doJSONOnce(httpReq *http.Request, path string, out any) error {
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

// drainRequestBody snapshots the request body so a refreshed-token retry can resend it.
func drainRequestBody(httpReq *http.Request) ([]byte, error) {
	if httpReq.Body == nil {
		return nil, nil
	}
	bodyBytes, err := io.ReadAll(httpReq.Body)
	if err != nil {
		return nil, fmt.Errorf("read newapi request body: %w", err)
	}
	_ = httpReq.Body.Close()
	httpReq.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	return bodyBytes, nil
}

// cloneRequest recreates a request and attaches the latest token under lock.
func (c *Client) cloneRequest(httpReq *http.Request, bodyBytes []byte, attachAuth bool) (*http.Request, string, error) {
	var body io.Reader
	if bodyBytes != nil {
		body = bytes.NewReader(bodyBytes)
	}
	req, err := http.NewRequestWithContext(httpReq.Context(), httpReq.Method, httpReq.URL.String(), body)
	if err != nil {
		return nil, "", fmt.Errorf("build newapi request: %w", err)
	}
	req.Header = httpReq.Header.Clone()
	usedToken := ""
	if attachAuth {
		usedToken = c.adminTokenSnapshot()
		req.Header.Set("Authorization", "Bearer "+usedToken)
	}
	if c.userID > 0 {
		req.Header.Set("New-Api-User", fmt.Sprintf("%d", c.userID))
	}
	return req, usedToken, nil
}

// adminTokenSnapshot returns the current token without exposing mutation races.
func (c *Client) adminTokenSnapshot() string {
	c.tokenMu.RLock()
	defer c.tokenMu.RUnlock()
	return c.adminToken
}

// canRefreshAdminToken reports whether refresh credentials were configured.
func (c *Client) canRefreshAdminToken() bool {
	return c.adminRefreshUsername != "" && c.adminRefreshPassword != ""
}

// refreshAdminToken logs in once and swaps the in-memory admin token before retrying.
func (c *Client) refreshAdminToken(ctx context.Context, staleToken string) error {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()

	if current := c.adminTokenSnapshot(); current != staleToken {
		return nil
	}
	login, err := c.Login(ctx, c.adminRefreshUsername, c.adminRefreshPassword)
	if err != nil {
		return fmt.Errorf("refresh newapi admin token: %w", err)
	}
	token := strings.TrimSpace(login.Data.AccessToken)
	if token == "" {
		return fmt.Errorf("refresh newapi admin token: empty access token")
	}
	c.tokenMu.Lock()
	c.adminToken = token
	c.tokenMu.Unlock()
	return nil
}

// isUnauthorizedNewAPIError identifies responses where refreshing the admin token is useful.
func isUnauthorizedNewAPIError(err error) bool {
	return err != nil && strings.Contains(err.Error(), " returned 401:")
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
	case *selfUserResponse:
		return apiStatusFields{success: value.Success, message: value.Message}, true
	case *selfLogsResponse:
		return apiStatusFields{success: value.Success, message: value.Message}, true
	case *userModelsResponse:
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
	Name                 string `json:"name"`
	ExpiresAt            int64  `json:"expired_time,omitempty"`
	RemainQuota          int64  `json:"remain_quota,omitempty"`
	UnlimitedQuota       bool   `json:"unlimited_quota"`
	ModelLimitsEnabled   bool   `json:"model_limits_enabled"`
	CrossGroupRetry      bool   `json:"cross_group_retry"`
	SkipModelNameMapping bool   `json:"skip_model_name_mapping"`
}

// CreateTokenResponse captures likely New API token response fields for spike verification.
type CreateTokenResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Token   string `json:"token,omitempty"`
	Key     string `json:"key,omitempty"`
}

// User is the subset of New API user records needed by Bavi-box provisioning.
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

// SelfUser is the subset of /api/user/self used by Bavi-box usage cards.
type SelfUser struct {
	ID           int64  `json:"id"`
	Username     string `json:"username"`
	Quota        int64  `json:"quota"`
	UsedQuota    int64  `json:"used_quota"`
	RequestCount int64  `json:"request_count"`
}

// LogItem is one New API account log/usage row.
type LogItem struct {
	ID               int64  `json:"id"`
	UserID           int64  `json:"user_id"`
	CreatedAt        int64  `json:"created_at"`
	Type             int    `json:"type"`
	Content          string `json:"content"`
	Username         string `json:"username"`
	TokenName        string `json:"token_name"`
	ModelName        string `json:"model_name"`
	Quota            int64  `json:"quota"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	UseTime          int64  `json:"use_time"`
	Channel          int64  `json:"channel"`
	ChannelName      string `json:"channel_name"`
	TokenID          int64  `json:"token_id"`
	Group            string `json:"group"`
	RequestID        string `json:"request_id"`
}

// SelfLogsPage captures New API's paged self-log response.
type SelfLogsPage struct {
	Page     int       `json:"page"`
	PageSize int       `json:"page_size"`
	Total    int       `json:"total"`
	Items    []LogItem `json:"items"`
}

// UserModels maps New API channel IDs to the model names granted to the user.
type UserModels map[string][]string

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

type selfUserResponse struct {
	Data    SelfUser `json:"data"`
	Success bool     `json:"success"`
	Message string   `json:"message,omitempty"`
}

type selfLogsResponse struct {
	Data    SelfLogsPage `json:"data"`
	Success bool         `json:"success"`
	Message string       `json:"message,omitempty"`
}

type userModelsResponse struct {
	Data    json.RawMessage `json:"data"`
	Success bool            `json:"success"`
	Message string          `json:"message,omitempty"`
}

// UserModels decodes New API's model-permission envelope while tolerating common deployments.
func (r userModelsResponse) UserModels() (UserModels, error) {
	if len(bytes.TrimSpace(r.Data)) == 0 || string(bytes.TrimSpace(r.Data)) == "null" {
		return UserModels{}, nil
	}

	var channelMap map[string][]string
	if err := json.Unmarshal(r.Data, &channelMap); err == nil {
		return normalizeUserModels(channelMap), nil
	}

	var flatList []string
	if err := json.Unmarshal(r.Data, &flatList); err == nil {
		return normalizeUserModels(map[string][]string{"": flatList}), nil
	}

	var wrapped struct {
		Models []string `json:"models"`
	}
	if err := json.Unmarshal(r.Data, &wrapped); err == nil && wrapped.Models != nil {
		return normalizeUserModels(map[string][]string{"": wrapped.Models}), nil
	}

	return UserModels{}, fmt.Errorf("decode newapi user models: unsupported data shape")
}

// normalizeUserModels trims duplicate model names without inventing channel permissions.
func normalizeUserModels(input map[string][]string) UserModels {
	output := UserModels{}
	for channelID, models := range input {
		channel := strings.TrimSpace(channelID)
		seen := map[string]bool{}
		for _, model := range models {
			name := strings.TrimSpace(model)
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			output[channel] = append(output[channel], name)
		}
		if len(output[channel]) == 0 {
			delete(output, channel)
		}
	}
	return output
}

type apiStatusResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}
