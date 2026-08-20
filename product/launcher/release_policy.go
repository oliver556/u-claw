package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"
)

var ErrReleasePolicyInvalid = errors.New("release policy invalid")

type ReleasePolicy struct {
	SchemaVersion           int                    `json:"schemaVersion"`
	PolicyEpoch             uint64                 `json:"policyEpoch"`
	RequiredReleaseSequence uint64                 `json:"requiredReleaseSequence"`
	ReleaseID               string                 `json:"releaseId"`
	ContentVersion          string                 `json:"contentVersion"`
	Reason                  string                 `json:"reason"`
	ManifestURL             string                 `json:"manifestUrl"`
	ManifestSHA256          string                 `json:"manifestSha256"`
	IssuedAt                string                 `json:"issuedAt"`
	ExpiresAt               string                 `json:"expiresAt"`
	Signature               ReleasePolicySignature `json:"signature"`
}

type ReleasePolicySignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

func releasePolicySigningPayload(policy ReleasePolicy) ([]byte, error) {
	value := []any{
		"uclaw-release-policy-v1", policy.SchemaVersion, policy.PolicyEpoch,
		policy.RequiredReleaseSequence, policy.ReleaseID, policy.ContentVersion,
		policy.Reason, policy.ManifestURL, strings.ToLower(policy.ManifestSHA256),
		policy.IssuedAt, policy.ExpiresAt, policy.Signature.Algorithm, policy.Signature.KeyID,
	}
	var output strings.Builder
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, ErrReleasePolicyInvalid
	}
	payload := strings.TrimSuffix(output.String(), "\n")
	payload = strings.ReplaceAll(payload, `\u2028`, " ")
	payload = strings.ReplaceAll(payload, `\u2029`, " ")
	return []byte(payload), nil
}

func VerifyReleasePolicy(
	policy ReleasePolicy,
	now time.Time,
	trustedKeys map[string]ed25519.PublicKey,
	allowLoopbackHTTP bool,
) error {
	if policy.SchemaVersion != 1 || policy.PolicyEpoch == 0 || policy.PolicyEpoch > uint64(maxSafeJSONInteger) ||
		policy.RequiredReleaseSequence == 0 || policy.RequiredReleaseSequence > uint64(maxSafeJSONInteger) ||
		!runtimeIDPattern.MatchString(policy.ReleaseID) || !isSafeVersion(policy.ContentVersion) ||
		!runtimeIDPattern.MatchString(policy.Reason) || !sha256Pattern.MatchString(policy.ManifestSHA256) ||
		policy.Signature.Algorithm != "ed25519" || !runtimeIDPattern.MatchString(policy.Signature.KeyID) {
		return ErrReleasePolicyInvalid
	}
	manifestURL, err := url.Parse(policy.ManifestURL)
	if err != nil || manifestURL.User != nil || manifestURL.Host == "" || manifestURL.RawQuery != "" || manifestURL.Fragment != "" ||
		!releaseURLSchemeAllowed(manifestURL, allowLoopbackHTTP) {
		return ErrReleasePolicyInvalid
	}
	issuedAt, issuedErr := time.Parse(time.RFC3339, policy.IssuedAt)
	expiresAt, expiresErr := time.Parse(time.RFC3339, policy.ExpiresAt)
	if issuedErr != nil || expiresErr != nil || issuedAt.After(now.UTC().Add(5*time.Minute)) ||
		!expiresAt.After(now.UTC()) || !expiresAt.After(issuedAt) {
		return ErrReleasePolicyInvalid
	}
	publicKey, ok := trustedKeys[policy.Signature.KeyID]
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return ErrReleasePolicyInvalid
	}
	signature, err := base64.StdEncoding.DecodeString(policy.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return ErrReleasePolicyInvalid
	}
	payload, err := releasePolicySigningPayload(policy)
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		return ErrReleasePolicyInvalid
	}
	return nil
}

func releaseURLSchemeAllowed(value *url.URL, allowLoopbackHTTP bool) bool {
	if value.Scheme == "https" {
		return true
	}
	if value.Scheme != "http" || !allowLoopbackHTTP {
		return false
	}
	host := strings.ToLower(value.Hostname())
	return host == "localhost" || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
}
