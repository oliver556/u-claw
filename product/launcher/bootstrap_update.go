package main

import (
	"context"
	"path/filepath"
)

type requiredReleaseResult struct {
	Manifest        Manifest
	RuntimePath     string
	RestartRequired bool
}

type requiredReleaseOptions struct {
	HostCacheRoot  string
	CacheRoot      string
	FetchPolicy    func(context.Context) (ReleasePolicy, error)
	FetchManifest  func(context.Context, ReleasePolicy) (Manifest, error)
	CurrentMatches func(string, Manifest) (bool, error)
	InstallRuntime func(context.Context, ReleasePolicy, Manifest) (CacheResult, error)
	AcceptCurrent  func(string, Manifest) error
}

func enforceRequiredRelease(ctx context.Context, options requiredReleaseOptions) (requiredReleaseResult, error) {
	if options.FetchPolicy == nil || options.FetchManifest == nil || options.CurrentMatches == nil ||
		options.InstallRuntime == nil || options.AcceptCurrent == nil ||
		!filepath.IsAbs(options.HostCacheRoot) || !filepath.IsAbs(options.CacheRoot) {
		return requiredReleaseResult{}, ErrReleasePolicyInvalid
	}
	policy, err := options.FetchPolicy(ctx)
	if err != nil {
		return requiredReleaseResult{}, err
	}
	manifest, err := options.FetchManifest(ctx, policy)
	if err != nil {
		return requiredReleaseResult{}, err
	}
	if manifest.ReleaseSequence != policy.RequiredReleaseSequence || manifest.ReleaseID != policy.ReleaseID ||
		manifest.ProductVersion != policy.ContentVersion {
		return requiredReleaseResult{}, ErrReleasePolicyInvalid
	}
	matches, err := options.CurrentMatches(options.HostCacheRoot, manifest)
	if err != nil {
		return requiredReleaseResult{}, err
	}
	if matches {
		return requiredReleaseResult{
			Manifest: manifest, RuntimePath: filepath.Join(options.CacheRoot, runtimeInstallName(manifest)),
		}, nil
	}
	cache, err := options.InstallRuntime(ctx, policy, manifest)
	if err != nil {
		return requiredReleaseResult{}, err
	}
	if cache.Path != filepath.Join(options.CacheRoot, runtimeInstallName(manifest)) {
		return requiredReleaseResult{}, ErrCachePreparationFailed
	}
	if err := options.AcceptCurrent(options.HostCacheRoot, manifest); err != nil {
		return requiredReleaseResult{}, err
	}
	return requiredReleaseResult{Manifest: manifest, RuntimePath: cache.Path, RestartRequired: true}, nil
}

func CurrentRuntimeMatches(cacheRoot string, manifest Manifest) (bool, error) {
	record, root, _, err := readRuntimeSequence(cacheRoot)
	if root != nil {
		_ = root.Close()
	}
	if err != nil {
		return false, err
	}
	if record.ReleaseSequence == 0 {
		return false, nil
	}
	if !sameRuntimeSequenceIdentity(record, manifest) {
		return false, nil
	}
	cachePath := filepath.Join(cacheRoot, "runtimes", runtimeInstallName(manifest))
	if !runtimeCacheUsable(cachePath, manifest) {
		return false, ErrRuntimeAuditFailed
	}
	return true, nil
}
