package releaseauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"time"
)

func TestVerifierRequiresValidFreshProofMatchingRelease(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 21, 1, 5, 0, 0, time.UTC)
	verifier, err := NewVerifier("release-gate-2026-01", publicKey, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	valid := fixtureAuthorization(now)
	signAuthorization(&valid, privateKey)
	expected := ExpectedRelease{
		ReleaseSequence: 42,
		ReleaseID:       "release-42",
		ManifestURL:     "https://cdn.example.test/releases/release-42/runtime-manifest.json",
		ManifestSHA256:  digest("b"),
	}
	if err := verifier.Verify(valid, expected); err != nil {
		t.Fatalf("valid proof rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Authorization)
		resign bool
	}{
		{name: "bad signature", mutate: func(value *Authorization) {
			value.Signature.Value = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
		}},
		{name: "wrong key id", mutate: func(value *Authorization) { value.Signature.KeyID = "other-release-gate" }},
		{name: "wrong sequence", mutate: func(value *Authorization) { value.RequiredReleaseSequence++ }, resign: true},
		{name: "wrong manifest digest", mutate: func(value *Authorization) { value.ManifestSHA256 = digest("c") }, resign: true},
		{name: "wrong runtime digest", mutate: func(value *Authorization) { value.RuntimeSHA256 = digest("c") }, resign: true},
		{name: "cdn bytes mismatch", mutate: func(value *Authorization) {
			record := value.CDNReadback["runtime.pkg"]
			record.Bytes++
			value.CDNReadback["runtime.pkg"] = record
		}, resign: true},
		{name: "expired", mutate: func(value *Authorization) {
			value.IssuedAt = now.Add(-11 * time.Minute).Format(time.RFC3339)
			value.ExpiresAt = now.Format(time.RFC3339)
		}, resign: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			proof := valid
			proof.Artifacts = cloneArtifacts(valid.Artifacts)
			proof.CDNReadback = cloneArtifacts(valid.CDNReadback)
			test.mutate(&proof)
			if test.resign {
				signAuthorization(&proof, privateKey)
			}
			if err := verifier.Verify(proof, expected); err == nil {
				t.Fatal("invalid proof accepted")
			}
		})
	}
}

func fixtureAuthorization(now time.Time) Authorization {
	readback := map[string]Artifact{
		"U-Claw.exe":            {Bytes: 10, SHA256: digest("f"), URL: "https://cdn.example.test/releases/release-42/U-Claw.exe"},
		"inventory.json":        {Bytes: 11, SHA256: digest("a"), URL: "https://cdn.example.test/releases/release-42/inventory.json"},
		"runtime-manifest.json": {Bytes: 12, SHA256: digest("b"), URL: "https://cdn.example.test/releases/release-42/runtime-manifest.json"},
		"runtime-tree.sha256":   {Bytes: 13, SHA256: digest("c"), URL: "https://cdn.example.test/releases/release-42/runtime-tree.sha256"},
		"runtime.pkg":           {Bytes: 14, SHA256: digest("d"), URL: "https://cdn.example.test/releases/release-42/runtime.pkg"},
		"sbom.spdx.json":        {Bytes: 15, SHA256: digest("e"), URL: "https://cdn.example.test/releases/release-42/sbom.spdx.json"},
	}
	artifacts := cloneArtifacts(readback)
	for name, record := range artifacts {
		record.URL = ""
		artifacts[name] = record
	}
	return Authorization{
		SchemaVersion: 1, Allowed: true, Gate: "cdn-readback-complete", ReleaseID: "release-42", RequiredReleaseSequence: 42,
		CommitSHA: digest40("a"), ManifestURL: readback["runtime-manifest.json"].URL, ManifestSHA256: artifacts["runtime-manifest.json"].SHA256,
		RuntimeSHA256: artifacts["runtime.pkg"].SHA256, Artifacts: artifacts, CDNReadback: readback,
		Evidence: Evidence{BuildCompletedAt: now.Add(-5 * time.Minute).Format(time.RFC3339), FinalRuntimeSmokeCompletedAt: now.Add(-4 * time.Minute).Format(time.RFC3339), PromotionsCompletedAt: now.Add(-3 * time.Minute).Format(time.RFC3339), UploadCompletedAt: now.Add(-2 * time.Minute).Format(time.RFC3339), CDNReadbackCompletedAt: now.Add(-time.Minute).Format(time.RFC3339)},
		IssuedAt: now.Add(-30 * time.Second).Format(time.RFC3339), ExpiresAt: now.Add(9*time.Minute + 30*time.Second).Format(time.RFC3339),
		Signature: Signature{Algorithm: "ed25519", KeyID: "release-gate-2026-01"},
	}
}

func signAuthorization(value *Authorization, privateKey ed25519.PrivateKey) {
	value.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, SigningPayload(*value)))
}

func cloneArtifacts(source map[string]Artifact) map[string]Artifact {
	result := make(map[string]Artifact, len(source))
	for name, record := range source {
		result[name] = record
	}
	return result
}

func digest(character string) string   { return repeat(character, 64) }
func digest40(character string) string { return repeat(character, 40) }
func repeat(value string, count int) string {
	result := ""
	for range count {
		result += value
	}
	return result
}
