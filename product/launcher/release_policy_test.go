package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

func signedReleasePolicyFixture(t *testing.T) (ReleasePolicy, ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	policy := ReleasePolicy{
		SchemaVersion:           1,
		PolicyEpoch:             107,
		RequiredReleaseSequence: 107,
		ReleaseID:               "release-107",
		ContentVersion:          "1.5.0",
		Reason:                  "release",
		ManifestURL:             "https://cdn.example.test/releases/107/version.json",
		ManifestSHA256:          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		IssuedAt:                now.Add(-time.Minute).Format(time.RFC3339),
		ExpiresAt:               now.Add(time.Hour).Format(time.RFC3339),
		Signature: ReleasePolicySignature{
			Algorithm: "ed25519",
			KeyID:     "policy-key-1",
		},
	}
	payload, err := releasePolicySigningPayload(policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return policy, publicKey, privateKey
}

func TestVerifyReleasePolicyAuthenticatesFreshExactSequence(t *testing.T) {
	policy, publicKey, _ := signedReleasePolicyFixture(t)
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	if err := VerifyReleasePolicy(policy, now, map[string]ed25519.PublicKey{"policy-key-1": publicKey}, false); err != nil {
		t.Fatal(err)
	}

	for name, mutate := range map[string]func(*ReleasePolicy){
		"signature": func(value *ReleasePolicy) { value.ReleaseID = "release-108" },
		"sequence":  func(value *ReleasePolicy) { value.RequiredReleaseSequence = 0 },
		"epoch":     func(value *ReleasePolicy) { value.PolicyEpoch = 0 },
		"expiry":    func(value *ReleasePolicy) { value.ExpiresAt = now.Format(time.RFC3339) },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := policy
			mutate(&candidate)
			if err := VerifyReleasePolicy(candidate, now, map[string]ed25519.PublicKey{"policy-key-1": publicKey}, false); !errors.Is(err, ErrReleasePolicyInvalid) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestVerifyReleasePolicyRequiresHTTPSOutsideLoopbackFixtures(t *testing.T) {
	policy, publicKey, privateKey := signedReleasePolicyFixture(t)
	policy.ManifestURL = "http://127.0.0.1:8080/version.json"
	payload, err := releasePolicySigningPayload(policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))

	if err := VerifyReleasePolicy(policy, time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC), map[string]ed25519.PublicKey{"policy-key-1": publicKey}, false); !errors.Is(err, ErrReleasePolicyInvalid) {
		t.Fatalf("returned %v", err)
	}
	if err := VerifyReleasePolicy(policy, time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC), map[string]ed25519.PublicKey{"policy-key-1": publicKey}, true); err != nil {
		t.Fatalf("loopback fixture rejected: %v", err)
	}
}
