package main

import (
	"context"
	"os"
	"os/signal"
	"path/filepath"
	"time"
)

func main() {
	reporter := NewStatusReporter()
	executablePath, err := os.Executable()
	if err != nil {
		reportFailure(reporter, err)
		reporter.Close()
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if err := launcherMain(ctx, executablePath, os.Getenv("LOCALAPPDATA"), reporter); err != nil {
		os.Exit(1)
	}
}

func launcherMain(ctx context.Context, executablePath string, localAppData string, reporter Reporter) error {
	paths, err := ResolvePortablePaths(executablePath, localAppData)
	if err != nil {
		reportFailure(reporter, err)
		reporter.Close()
		return err
	}
	return Run(ctx, launcherDependencies(paths, reporter))
}

func launcherDependencies(paths PortablePaths, reporter Reporter) Dependencies {
	return Dependencies{
		Paths:               paths,
		Reporter:            reporter,
		USBInterval:         500 * time.Millisecond,
		ReadManifest:        ReadManifest,
		ProbeDataDirectory:  ProbeDataDirectory,
		EnsureHostCache:     EnsureHostCacheOwnership,
		AcquireInstanceLock: AcquireInstanceLock,
		PrepareRuntime:      prepareRuntimeForLaunch,
		StartProcess: func(spec ProcessSpec) (ChildProcess, error) {
			return StartManagedProcess(spec)
		},
		MonitorUSB: MonitorUSB,
	}
}

func prepareRuntimeForLaunch(
	ctx context.Context,
	cacheRoot string,
	packageRoot string,
	manifest Manifest,
	extracting func(),
) (CacheResult, error) {
	if !runtimeCacheReusable(cacheRoot, manifest) {
		extracting()
	}
	return EnsureRuntimeCache(ctx, cacheRoot, packageRoot, manifest)
}

func runtimeCacheReusable(cacheRoot string, manifest Manifest) bool {
	root, err := os.OpenRoot(cacheRoot)
	if err != nil {
		return false
	}
	defer root.Close()
	info, err := root.Lstat(manifest.RuntimeID)
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 &&
		runtimeCacheUsable(filepath.Join(cacheRoot, manifest.RuntimeID), manifest)
}
