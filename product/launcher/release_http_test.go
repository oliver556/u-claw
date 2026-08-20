package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReleaseHTTPClientInstallsSignedRequiredReleaseWithoutTouchingPortableData(t *testing.T) {
	packageFixture, manifest := writePackageFixture(t)
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	runtimePublic, runtimePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest = signedRuntimeManifest(t, manifest, "runtime-key-1", runtimePrivate, now.Add(-time.Minute), now.Add(time.Hour), 107)
	trustRuntimeTestKey(t, "runtime-key-1", runtimePublic)
	manifestContent, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestDigest := sha256.Sum256(manifestContent)
	archiveContent, err := os.ReadFile(filepath.Join(packageFixture, manifest.RuntimeArchive))
	if err != nil {
		t.Fatal(err)
	}

	policyPublic, policyPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var policy ReleasePolicy
	archiveRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/policy":
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(policy)
		case "/releases/version.json":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write(manifestContent)
		case "/releases/runtime.pkg":
			archiveRequests++
			response.Header().Set("Content-Type", "application/octet-stream")
			_, _ = response.Write(archiveContent)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	policy = ReleasePolicy{
		SchemaVersion: 1, PolicyEpoch: 107, RequiredReleaseSequence: 107,
		ReleaseID: manifest.ReleaseID, ContentVersion: manifest.ProductVersion, Reason: "release",
		ManifestURL: server.URL + "/releases/version.json", ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
		Signature: ReleasePolicySignature{Algorithm: "ed25519", KeyID: "policy-key-1"},
	}
	payload, err := releasePolicySigningPayload(policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(policyPrivate, payload))

	usbRoot := t.TempDir()
	packageRoot := filepath.Join(usbRoot, ".uclaw")
	dataRoot := filepath.Join(packageRoot, "data")
	for path, content := range map[string]string{
		filepath.Join(dataRoot, "workspace", "memory.md"):          "workspace-stays",
		filepath.Join(packageRoot, "license", "license.json"):      "license-stays",
		filepath.Join(packageRoot, "license", "device-token.json"): "device-token-stays",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	hostRoot := filepath.Join(t.TempDir(), "U-Claw")
	if err := EnsureHostCacheOwnership(hostRoot); err != nil {
		t.Fatal(err)
	}
	paths := PortablePaths{
		USBRoot: usbRoot, PackageRoot: packageRoot, DataDir: dataRoot,
		HostCacheRoot: hostRoot, CacheRoot: filepath.Join(hostRoot, "runtimes"),
	}
	client, err := newReleaseHTTPClient(releaseHTTPClientOptions{
		PolicyEndpoint: server.URL + "/policy", AllowLoopbackHTTP: true,
		HTTPClient: server.Client(), TrustedPolicyKeys: map[string]ed25519.PublicKey{"policy-key-1": policyPublic},
		Now: func() time.Time { return now }, Timeout: 5 * time.Second, Paths: paths,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Enforce(context.Background(), func(State) {})
	if err != nil {
		t.Fatal(err)
	}
	if !result.RestartRequired || archiveRequests != 1 {
		t.Fatalf("result=%#v archiveRequests=%d", result, archiveRequests)
	}
	for path, want := range map[string]string{
		filepath.Join(dataRoot, "workspace", "memory.md"):          "workspace-stays",
		filepath.Join(packageRoot, "license", "license.json"):      "license-stays",
		filepath.Join(packageRoot, "license", "device-token.json"): "device-token-stays",
	} {
		content, err := os.ReadFile(path)
		if err != nil || string(content) != want {
			t.Fatalf("portable file %q = %q, %v", path, content, err)
		}
	}
	second, err := client.Enforce(context.Background(), func(State) {})
	if err != nil {
		t.Fatal(err)
	}
	if second.RestartRequired || archiveRequests != 1 {
		t.Fatalf("second=%#v archiveRequests=%d", second, archiveRequests)
	}
}
