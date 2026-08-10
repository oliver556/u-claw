package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var (
	ErrLicenseStatusAuthentication  = errors.New("license status authentication failed")
	ErrLicenseStatusResponseInvalid = errors.New("license status response invalid")
)

type licenseStatusHTTPClientOptions struct {
	Endpoint          string
	AllowLoopbackHTTP bool
	HTTPClient        *http.Client
	Timeout           time.Duration
	MaxResponseBytes  int64
}

func newLicenseStatusHTTPClient(options licenseStatusHTTPClientOptions) (func(verifiedLicenseMaterial) (licenseStatusResponse, error), error) {
	endpoint, err := url.Parse(options.Endpoint)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, ErrLicenseLifecycleConfigAbsent
	}
	host := strings.ToLower(endpoint.Hostname())
	loopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && options.AllowLoopbackHTTP && loopback) {
		return nil, ErrLicenseLifecycleConfigAbsent
	}
	if !strings.HasSuffix(endpoint.Path, "/") {
		endpoint.Path += "/"
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	if timeout < 0 || timeout > time.Minute {
		return nil, ErrLicenseLifecycleConfigAbsent
	}
	maxBytes := options.MaxResponseBytes
	if maxBytes == 0 {
		maxBytes = 256 << 10
	}
	if maxBytes < 1 || maxBytes > 4<<20 {
		return nil, ErrLicenseLifecycleConfigAbsent
	}
	client := http.Client{}
	if options.HTTPClient != nil {
		client = *options.HTTPClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	return func(material verifiedLicenseMaterial) (licenseStatusResponse, error) {
		if !validLicenseIdentifier(material.LicenseID) || material.StartupSecret == "" {
			return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
		}
		requestURL, err := url.Parse(endpoint.String() + url.PathEscape(material.LicenseID))
		if err != nil {
			return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
		if err != nil {
			return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Authorization", "Bearer "+material.StartupSecret)
		response, err := client.Do(request)
		if err != nil {
			var networkError net.Error
			if errors.As(err, &networkError) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				return licenseStatusResponse{}, ErrLicenseStatusUnavailable
			}
			return licenseStatusResponse{}, ErrLicenseStatusUnavailable
		}
		defer response.Body.Close()
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return licenseStatusResponse{}, ErrLicenseStatusAuthentication
		}
		if response.StatusCode >= 500 && response.StatusCode <= 599 {
			return licenseStatusResponse{}, ErrLicenseStatusUnavailable
		}
		if response.StatusCode < 200 || response.StatusCode > 299 {
			return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
		}
		mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if err != nil || (mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json")) {
			return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
		}
		if declared := response.Header.Get("Content-Length"); declared != "" {
			length, err := strconv.ParseInt(declared, 10, 64)
			if err != nil || length < 0 || length > maxBytes {
				return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
			}
		}
		content, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
		if err != nil || int64(len(content)) > maxBytes || rejectDuplicateJSONKeys(content) != nil {
			return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
		}
		var result licenseStatusResponse
		decoder := json.NewDecoder(bytes.NewReader(content))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&result); err != nil || ensureJSONEnd(decoder) != nil {
			return licenseStatusResponse{}, ErrLicenseStatusResponseInvalid
		}
		return result, nil
	}, nil
}
