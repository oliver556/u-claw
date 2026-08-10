package main

import (
	"context"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"time"
)

func runReleaseFSHelperEntry(
	args []string,
	executablePath string,
	localAppData string,
	input io.Reader,
	output io.Writer,
) error {
	paths, err := ResolvePortablePaths(executablePath, localAppData)
	if err != nil {
		return err
	}
	if err := ProbeDataDirectory(paths.PackageRoot, paths.DataDir); err != nil {
		return err
	}
	if err := verifyProductionStartupLicense(paths.PackageRoot, paths.USBRoot); err != nil {
		return err
	}
	return runReleaseFSHelper(args, input, output)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--release-fs-helper" {
		executablePath, err := os.Executable()
		if err != nil {
			_, _ = os.Stderr.WriteString("release filesystem helper failed\n")
			os.Exit(2)
		}
		if err := runReleaseFSHelperEntry(os.Args[2:], executablePath, os.Getenv("LOCALAPPDATA"), os.Stdin, os.Stdout); err != nil {
			_, _ = os.Stderr.WriteString("release filesystem helper failed\n")
			os.Exit(2)
		}
		return
	}
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
		StartupGrace:        2 * time.Second,
		ProcessStopTimeout:  2 * time.Second,
		ReadManifest:        ReadManifest,
		ProbeDataDirectory:  ProbeDataDirectory,
		VerifyLicense:       verifyProductionStartupLicense,
		EnsureHostCache:     EnsureHostCacheOwnership,
		AcquireInstanceLock: AcquireInstanceLock,
		PrepareRuntime:      prepareRuntimeForLaunch,
		AcquireRuntime:      AcquireRuntimeLease,
		CheckSequence:       CheckRuntimeSequence,
		AcceptSequence:      AcceptRuntimeSequence,
		FinalizeUpdate:      FinalizeUpdateTransaction,
		StartProcess: func(spec ProcessSpec) (ChildProcess, error) {
			return StartManagedProcess(spec)
		},
		MonitorUSB: MonitorUSB,
	}
}

func verifyProductionStartupLicense(packageRoot string, usbRoot string) error {
	keys, err := parseTrustedStartupLicenseKeys(trustedStartupLicenseKeys)
	if err != nil {
		return err
	}
	return VerifyStartupLicense(licenseVerificationOptions{
		PackageRoot:       packageRoot,
		USBRoot:           usbRoot,
		Now:               time.Now,
		ReadFingerprint:   ReadUSBFingerprint,
		TrustedPublicKeys: keys,
	})
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
