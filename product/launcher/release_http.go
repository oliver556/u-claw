package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var (
	ErrReleasePolicyUnavailable   = errors.New("release policy unavailable")
	ErrReleaseDownloadUnavailable = errors.New("release download unavailable")
)

type releaseHTTPClientOptions struct {
	PolicyEndpoint    string
	AllowLoopbackHTTP bool
	HTTPClient        *http.Client
	TrustedPolicyKeys map[string]ed25519.PublicKey
	Now               func() time.Time
	Timeout           time.Duration
	Paths             PortablePaths
}

type releaseHTTPClient struct {
	policyEndpoint    *url.URL
	allowLoopbackHTTP bool
	httpClient        http.Client
	trustedPolicyKeys map[string]ed25519.PublicKey
	now               func() time.Time
	timeout           time.Duration
	paths             PortablePaths
}

func newReleaseHTTPClient(options releaseHTTPClientOptions) (*releaseHTTPClient, error) {
	endpoint, err := url.Parse(options.PolicyEndpoint)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		!releaseURLSchemeAllowed(endpoint, options.AllowLoopbackHTTP) || len(options.TrustedPolicyKeys) == 0 ||
		!filepath.IsAbs(options.Paths.HostCacheRoot) || !filepath.IsAbs(options.Paths.CacheRoot) {
		return nil, ErrReleasePolicyInvalid
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = 10 * time.Minute
	}
	if timeout < time.Second || timeout > 30*time.Minute {
		return nil, ErrReleasePolicyInvalid
	}
	client := http.Client{}
	if options.HTTPClient != nil {
		client = *options.HTTPClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &releaseHTTPClient{
		policyEndpoint: endpoint, allowLoopbackHTTP: options.AllowLoopbackHTTP,
		httpClient: client, trustedPolicyKeys: options.TrustedPolicyKeys,
		now: now, timeout: timeout, paths: options.Paths,
	}, nil
}

func (client *releaseHTTPClient) Enforce(ctx context.Context, progress func(State)) (requiredReleaseResult, error) {
	progress(StateCheckingVersion)
	return enforceRequiredRelease(ctx, requiredReleaseOptions{
		HostCacheRoot: client.paths.HostCacheRoot,
		CacheRoot:     client.paths.CacheRoot,
		FetchPolicy:   client.fetchPolicy,
		FetchManifest: func(ctx context.Context, policy ReleasePolicy) (Manifest, error) {
			progress(StateVerifyingUpdate)
			return client.fetchManifest(ctx, policy)
		},
		CurrentMatches: CurrentRuntimeMatches,
		InstallRuntime: func(ctx context.Context, policy ReleasePolicy, manifest Manifest) (CacheResult, error) {
			progress(StateDownloadingUpdate)
			return client.installRuntime(ctx, policy, manifest, func() { progress(StateInstallingUpdate) })
		},
		AcceptCurrent: AcceptRuntimeSequence,
	})
}

func (client *releaseHTTPClient) fetchPolicy(ctx context.Context) (ReleasePolicy, error) {
	content, err := client.fetchBytes(ctx, client.policyEndpoint, 64<<10, "application/json")
	if err != nil {
		return ReleasePolicy{}, ErrReleasePolicyUnavailable
	}
	if rejectDuplicateJSONKeys(content) != nil {
		return ReleasePolicy{}, ErrReleasePolicyInvalid
	}
	var policy ReleasePolicy
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&policy) != nil || ensureJSONEnd(decoder) != nil ||
		VerifyReleasePolicy(policy, client.now().UTC(), client.trustedPolicyKeys, client.allowLoopbackHTTP) != nil {
		return ReleasePolicy{}, ErrReleasePolicyInvalid
	}
	return policy, nil
}

func (client *releaseHTTPClient) fetchManifest(ctx context.Context, policy ReleasePolicy) (Manifest, error) {
	manifestURL, err := url.Parse(policy.ManifestURL)
	if err != nil || !releaseURLSchemeAllowed(manifestURL, client.allowLoopbackHTTP) {
		return Manifest{}, ErrReleasePolicyInvalid
	}
	content, err := client.fetchBytes(ctx, manifestURL, maxManifestBytes, "application/json")
	if err != nil {
		return Manifest{}, ErrReleaseDownloadUnavailable
	}
	digest := sha256.Sum256(content)
	if hex.EncodeToString(digest[:]) != strings.ToLower(policy.ManifestSHA256) {
		return Manifest{}, ErrManifestInvalid
	}
	manifest, err := readManifest(bytes.NewReader(content))
	if err != nil || VerifyManifestSignature(manifest, client.now().UTC()) != nil {
		return Manifest{}, ErrManifestInvalid
	}
	return manifest, nil
}

func (client *releaseHTTPClient) installRuntime(ctx context.Context, policy ReleasePolicy, manifest Manifest, installing func()) (CacheResult, error) {
	manifestURL, err := url.Parse(policy.ManifestURL)
	if err != nil {
		return CacheResult{}, ErrReleasePolicyInvalid
	}
	archiveURL := manifestURL.ResolveReference(&url.URL{Path: strings.ReplaceAll(manifest.RuntimeArchive, `\`, "/")})
	if !releaseURLSchemeAllowed(archiveURL, client.allowLoopbackHTTP) {
		return CacheResult{}, ErrReleasePolicyInvalid
	}
	temporaryRoot, err := os.MkdirTemp(filepath.Join(client.paths.HostCacheRoot, "cache", "temp"), "bootstrap-release-")
	if err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	defer os.RemoveAll(temporaryRoot)
	archivePath := filepath.Join(temporaryRoot, filepath.FromSlash(strings.ReplaceAll(manifest.RuntimeArchive, `\`, "/")))
	if err := os.MkdirAll(filepath.Dir(archivePath), 0o700); err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	if err := client.downloadRuntime(ctx, archiveURL, archivePath, manifest); err != nil {
		return CacheResult{}, err
	}
	installing()
	return EnsureRuntimeCache(ctx, client.paths.CacheRoot, temporaryRoot, manifest)
}

func (client *releaseHTTPClient) downloadRuntime(ctx context.Context, source *url.URL, destination string, manifest Manifest) error {
	requestCtx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, source.String(), nil)
	if err != nil {
		return ErrReleaseDownloadUnavailable
	}
	request.Header.Set("Accept", "application/octet-stream")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ErrReleaseDownloadUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return ErrReleaseDownloadUnavailable
	}
	if declared := response.Header.Get("Content-Length"); declared != "" {
		length, err := strconv.ParseInt(declared, 10, 64)
		if err != nil || length != manifest.RuntimeBytes {
			return ErrPackageInvalid
		}
	}
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrCachePreparationFailed
	}
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hasher), io.LimitReader(response.Body, manifest.RuntimeBytes+1))
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil {
		return ErrReleaseDownloadUnavailable
	}
	if syncErr != nil || closeErr != nil {
		return ErrCachePreparationFailed
	}
	if written != manifest.RuntimeBytes || hex.EncodeToString(hasher.Sum(nil)) != strings.ToLower(manifest.RuntimeSHA256) {
		return ErrPackageInvalid
	}
	return nil
}

func (client *releaseHTTPClient) fetchBytes(ctx context.Context, source *url.URL, limit int64, accept string) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, source.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", accept)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, errors.New("unexpected release response")
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json") {
		return nil, errors.New("invalid release response type")
	}
	if declared := response.Header.Get("Content-Length"); declared != "" {
		length, err := strconv.ParseInt(declared, 10, 64)
		if err != nil || length < 0 || length > limit {
			return nil, errors.New("invalid release response length")
		}
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(content)) > limit {
		return nil, errors.New("invalid release response body")
	}
	return content, nil
}
