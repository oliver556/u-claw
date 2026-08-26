package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const tokenTypeJWT = "JWT"

// TokenManager issues and verifies HMAC-signed access tokens without adding a JWT dependency.
type TokenManager struct {
	secret []byte
	now    func() time.Time
}

// TokenClaims is the small authenticated identity payload used by U-Claw API handlers.
type TokenClaims struct {
	Subject   string `json:"sub"`
	Phone     string `json:"phone"`
	ExpiresAt int64  `json:"exp"`
}

type tokenHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
}

// NewTokenManager builds a signer/verifier around a non-empty shared secret.
func NewTokenManager(secret string) (*TokenManager, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil, fmt.Errorf("token secret is required")
	}
	return &TokenManager{secret: []byte(secret), now: time.Now}, nil
}

// IssueAccessToken creates a short-lived signed token for a verified phone user.
func (m *TokenManager) IssueAccessToken(userID int64, phone string, ttl time.Duration) (string, error) {
	if userID <= 0 {
		return "", fmt.Errorf("user id must be positive")
	}
	if ttl <= 0 {
		return "", fmt.Errorf("token ttl must be positive")
	}
	claims := TokenClaims{
		Subject:   strconv.FormatInt(userID, 10),
		Phone:     phone,
		ExpiresAt: m.now().Add(ttl).Unix(),
	}
	return m.sign(claims)
}

// VerifyAccessToken validates signature and expiry, then returns trusted claims.
func (m *TokenManager) VerifyAccessToken(token string) (TokenClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return TokenClaims{}, fmt.Errorf("token must have three parts")
	}
	unsigned := parts[0] + "." + parts[1]
	expected := m.signature(unsigned)
	if !hmac.Equal([]byte(parts[2]), []byte(expected)) {
		return TokenClaims{}, fmt.Errorf("token signature is invalid")
	}

	var claims TokenClaims
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return TokenClaims{}, fmt.Errorf("decode token payload: %w", err)
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return TokenClaims{}, fmt.Errorf("decode token claims: %w", err)
	}
	if claims.ExpiresAt <= m.now().Unix() {
		return TokenClaims{}, fmt.Errorf("token is expired")
	}
	return claims, nil
}

// sign builds the compact JWT-like token string from trusted claims.
func (m *TokenManager) sign(claims TokenClaims) (string, error) {
	headerJSON, err := json.Marshal(tokenHeader{Algorithm: "HS256", Type: tokenTypeJWT})
	if err != nil {
		return "", fmt.Errorf("marshal token header: %w", err)
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("marshal token claims: %w", err)
	}
	unsigned := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	return unsigned + "." + m.signature(unsigned), nil
}

// signature returns the URL-safe HMAC digest used as the token integrity check.
func (m *TokenManager) signature(unsigned string) string {
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write([]byte(unsigned))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
