package newapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// CreateToken requests a user token creation. Phase 0 must verify auth mode and response fields.
func (c *Client) CreateToken(ctx context.Context, req CreateTokenRequest, out *CreateTokenResponse) error {
	return c.postJSON(ctx, "/api/token/", req, out)
}

// postJSON sends a JSON admin request and decodes the optional JSON response.
func (c *Client) postJSON(ctx context.Context, path string, body any, out any) error {
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
	httpReq.Header.Set("Authorization", "Bearer "+c.adminToken)

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
		return nil
	}
	if err := json.Unmarshal(responseBody, out); err != nil {
		return fmt.Errorf("decode newapi response: %w", err)
	}
	return nil
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
