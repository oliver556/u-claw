package activation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type updateCredentialFileIssuer struct {
	path string
}

type updateCredentialFilePayload struct {
	SchemaVersion                  string   `json:"schemaVersion"`
	UpdateCheckURL                 string   `json:"updateCheckUrl"`
	DeviceID                       string   `json:"deviceId"`
	DeviceToken                    string   `json:"deviceToken"`
	PlatformKeys                   []string `json:"platformKeys"`
	AllowedActivationIDs           []string `json:"allowedActivationIds"`
	AllowedPrincipals              []string `json:"allowedPrincipals"`
	AllowedUSBFingerprintSummaries []string `json:"allowedUsbFingerprintSummaries"`
	ExpiresAt                      string   `json:"expiresAt"`
}

// NewUpdateCredentialFileIssuer loads a constrained hard-update credential from a root-only JSON file.
func NewUpdateCredentialFileIssuer(path string) (UpdateCredentialIssuer, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("update credential file path is required")
	}
	return &updateCredentialFileIssuer{path: path}, nil
}

// IssueUpdateCredential returns the credential only when file constraints match this activation.
func (i *updateCredentialFileIssuer) IssueUpdateCredential(_ context.Context, req UpdateCredentialRequest) (UpdateCredential, error) {
	raw, err := os.ReadFile(i.path)
	if err != nil {
		return UpdateCredential{}, fmt.Errorf("read update credential file: %w", err)
	}
	var payload updateCredentialFilePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return UpdateCredential{}, fmt.Errorf("decode update credential file: %w", err)
	}
	return payload.toCredential(req)
}

// toCredential validates file constraints before exposing the raw device token.
func (p updateCredentialFilePayload) toCredential(req UpdateCredentialRequest) (UpdateCredential, error) {
	if !p.hasBindingConstraint() {
		return UpdateCredential{}, fmt.Errorf("update credential file must define at least one allowed activation binding")
	}
	if !matchesAny(p.AllowedActivationIDs, req.ActivationID, false) ||
		!matchesAny(p.AllowedPrincipals, req.Principal, true) ||
		!matchesAny(p.AllowedUSBFingerprintSummaries, req.USBFingerprintSummary, false) {
		return UpdateCredential{}, ErrUpdateCredentialNotAvailable
	}
	if strings.TrimSpace(p.ExpiresAt) != "" {
		expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(p.ExpiresAt))
		if err != nil {
			return UpdateCredential{}, fmt.Errorf("parse update credential expiresAt: %w", err)
		}
		if !req.IssuedAt.Before(expiresAt) {
			return UpdateCredential{}, ErrUpdateCredentialNotAvailable
		}
	}
	schemaVersion := strings.TrimSpace(p.SchemaVersion)
	if schemaVersion == "" {
		schemaVersion = "uclaw.update-credential.v1"
	}
	updateCheckURL := strings.TrimRight(strings.TrimSpace(p.UpdateCheckURL), "/")
	if err := validateHTTPSURL(updateCheckURL); err != nil {
		return UpdateCredential{}, err
	}
	deviceID := strings.TrimSpace(p.DeviceID)
	deviceToken := strings.TrimSpace(p.DeviceToken)
	if deviceID == "" || deviceToken == "" {
		return UpdateCredential{}, fmt.Errorf("update credential file missing deviceId or deviceToken")
	}
	platformKeys := normalizePlatformKeys(p.PlatformKeys)
	if len(platformKeys) == 0 {
		platformKeys = []string{"win32-x64", "darwin-arm64", "darwin-x64"}
	}
	return UpdateCredential{
		SchemaVersion:  schemaVersion,
		UpdateCheckURL: updateCheckURL,
		DeviceID:       deviceID,
		DeviceToken:    deviceToken,
		PlatformKeys:   platformKeys,
		IssuedAt:       req.IssuedAt.UTC().Format(time.RFC3339),
	}, nil
}

// hasBindingConstraint prevents an acceptance file from becoming a global token source.
func (p updateCredentialFilePayload) hasBindingConstraint() bool {
	return len(p.AllowedActivationIDs) > 0 ||
		len(p.AllowedPrincipals) > 0 ||
		len(p.AllowedUSBFingerprintSummaries) > 0
}

// matchesAny treats empty constraint lists as wildcards for composable bindings.
func matchesAny(candidates []string, value string, caseInsensitive bool) bool {
	if len(candidates) == 0 {
		return true
	}
	value = strings.TrimSpace(value)
	if caseInsensitive {
		value = strings.ToUpper(value)
	}
	for _, candidate := range candidates {
		next := strings.TrimSpace(candidate)
		if caseInsensitive {
			next = strings.ToUpper(next)
		}
		if next != "" && next == value {
			return true
		}
	}
	return false
}

// normalizePlatformKeys keeps the client-facing platform list stable and duplicate-free.
func normalizePlatformKeys(values []string) []string {
	seen := make(map[string]bool, len(values))
	var out []string
	for _, value := range values {
		next := strings.TrimSpace(value)
		if next == "" || seen[next] {
			continue
		}
		seen[next] = true
		out = append(out, next)
	}
	return out
}

// validateHTTPSURL keeps hard-update checks on the production HTTPS control plane.
func validateHTTPSURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("update credential file updateCheckUrl must be https")
	}
	return nil
}
