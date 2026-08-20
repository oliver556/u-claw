package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestEnforceRequiredReleaseDoesNotSwitchCurrentWhenInstallFails(t *testing.T) {
	manifest := validRuntimeManifest()
	policy := releasePolicyForManifest(manifest)
	accepted := false
	result, err := enforceRequiredRelease(context.Background(), requiredReleaseOptions{
		HostCacheRoot:  t.TempDir(),
		CacheRoot:      t.TempDir(),
		FetchPolicy:    func(context.Context) (ReleasePolicy, error) { return policy, nil },
		FetchManifest:  func(context.Context, ReleasePolicy) (Manifest, error) { return manifest, nil },
		CurrentMatches: func(string, Manifest) (bool, error) { return false, nil },
		InstallRuntime: func(context.Context, ReleasePolicy, Manifest) (CacheResult, error) {
			return CacheResult{}, ErrPackageInvalid
		},
		AcceptCurrent: func(string, Manifest) error { accepted = true; return nil },
	})
	if !errors.Is(err, ErrPackageInvalid) {
		t.Fatalf("returned %v", err)
	}
	if accepted || result.RestartRequired {
		t.Fatalf("accepted=%v result=%#v", accepted, result)
	}
}

func TestEnforceRequiredReleaseSwitchesOnlyAfterVerifiedInstall(t *testing.T) {
	manifest := validRuntimeManifest()
	policy := releasePolicyForManifest(manifest)
	cachePath := filepath.Join(t.TempDir(), runtimeInstallName(manifest))
	steps := []string{}
	result, err := enforceRequiredRelease(context.Background(), requiredReleaseOptions{
		HostCacheRoot: t.TempDir(),
		CacheRoot:     filepath.Dir(cachePath),
		FetchPolicy:   func(context.Context) (ReleasePolicy, error) { steps = append(steps, "policy"); return policy, nil },
		FetchManifest: func(context.Context, ReleasePolicy) (Manifest, error) {
			steps = append(steps, "manifest")
			return manifest, nil
		},
		CurrentMatches: func(string, Manifest) (bool, error) { steps = append(steps, "current"); return false, nil },
		InstallRuntime: func(context.Context, ReleasePolicy, Manifest) (CacheResult, error) {
			steps = append(steps, "install")
			return CacheResult{Path: cachePath, Verification: "full"}, nil
		},
		AcceptCurrent: func(string, Manifest) error { steps = append(steps, "accept"); return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"policy", "manifest", "current", "install", "accept"}
	if len(steps) != len(want) {
		t.Fatalf("steps = %v", steps)
	}
	for index := range want {
		if steps[index] != want[index] {
			t.Fatalf("steps = %v", steps)
		}
	}
	if !result.RestartRequired || result.RuntimePath != cachePath || result.Manifest.ReleaseSequence != manifest.ReleaseSequence {
		t.Fatalf("result = %#v", result)
	}
}

func TestEnforceRequiredReleaseRejectsPolicyManifestIdentityMismatch(t *testing.T) {
	manifest := validRuntimeManifest()
	policy := releasePolicyForManifest(manifest)
	policy.RequiredReleaseSequence++
	installed := false
	_, err := enforceRequiredRelease(context.Background(), requiredReleaseOptions{
		HostCacheRoot:  t.TempDir(),
		CacheRoot:      t.TempDir(),
		FetchPolicy:    func(context.Context) (ReleasePolicy, error) { return policy, nil },
		FetchManifest:  func(context.Context, ReleasePolicy) (Manifest, error) { return manifest, nil },
		CurrentMatches: func(string, Manifest) (bool, error) { return false, nil },
		InstallRuntime: func(context.Context, ReleasePolicy, Manifest) (CacheResult, error) {
			installed = true
			return CacheResult{}, nil
		},
		AcceptCurrent: func(string, Manifest) error { return nil },
	})
	if !errors.Is(err, ErrReleasePolicyInvalid) || installed {
		t.Fatalf("returned %v installed=%v", err, installed)
	}
}

func releasePolicyForManifest(manifest Manifest) ReleasePolicy {
	return ReleasePolicy{
		SchemaVersion: 1, PolicyEpoch: manifest.ReleaseSequence,
		RequiredReleaseSequence: manifest.ReleaseSequence,
		ReleaseID:               manifest.ReleaseID, ContentVersion: manifest.ProductVersion,
		ManifestURL:    "https://cdn.example.test/version.json",
		ManifestSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
}
