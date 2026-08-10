package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareRuntimeForLaunchReportsOnlyRealExtraction(t *testing.T) {
	packageRoot, manifest := writePackageFixture(t)
	cacheRoot := t.TempDir()
	extractions := 0
	first, err := prepareRuntimeForLaunch(
		context.Background(),
		cacheRoot,
		packageRoot,
		manifest,
		func() { extractions++ },
	)
	if err != nil {
		t.Fatal(err)
	}
	if first.Reused || extractions != 1 {
		t.Fatalf("first reused=%v extractions=%d", first.Reused, extractions)
	}

	second, err := prepareRuntimeForLaunch(
		context.Background(),
		cacheRoot,
		packageRoot,
		manifest,
		func() { extractions++ },
	)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Reused || extractions != 1 || second.Path != first.Path {
		t.Fatalf("second=%#v extractions=%d", second, extractions)
	}
}

func TestLauncherMainRejectsInvalidPortablePaths(t *testing.T) {
	reporter := &recordingReporter{}
	err := launcherMain(context.Background(), "U-Claw.exe", filepath.Join(t.TempDir(), "local"), reporter)
	if err != ErrPortablePathInvalid {
		t.Fatalf("returned %v", err)
	}
	if len(reporter.failures) != 1 || reporter.failures[0][0] != "E_USB_UNAVAILABLE" || !reporter.closed {
		t.Fatalf("failures=%v closed=%v", reporter.failures, reporter.closed)
	}
}

func TestHeadlessStatusReporterSupportsAutomatedFailureChecks(t *testing.T) {
	t.Setenv("UCLAW_LAUNCHER_HEADLESS", "1")
	if !statusReporterHeadless() {
		t.Fatal("headless status mode was not enabled")
	}
	reporter := NewStatusReporter()
	reporter.State(StateCheckingRuntime)
	reporter.Fail("E_PACKAGE_INVALID", "运行时文件校验失败。")
	reporter.Close()
}

func TestLauncherDependenciesWireProductionLicenseGate(t *testing.T) {
	paths := PortablePaths{PackageRoot: filepath.Join(t.TempDir(), ".uclaw"), USBRoot: t.TempDir()}
	dependencies := launcherDependencies(paths, &recordingReporter{})
	if dependencies.VerifyLicense == nil {
		t.Fatal("production license gate is not configured")
	}
}

func TestProductionLicenseLifecycleConfigurationFailsClosed(t *testing.T) {
	originalEndpoint, originalKeys := licenseStatusEndpoint, trustedLicenseStatusKeys
	t.Cleanup(func() {
		licenseStatusEndpoint, trustedLicenseStatusKeys = originalEndpoint, originalKeys
	})
	licenseStatusEndpoint, trustedLicenseStatusKeys = "", "{}"
	if _, _, err := productionLicenseLifecycleConfig(""); !errors.Is(err, ErrLicenseLifecycleConfigAbsent) {
		t.Fatalf("missing configuration returned %v", err)
	}
	trustFixture := newLicenseFixture(t)
	licenseStatusEndpoint = "http://license.example.test/status/"
	trustedLicenseStatusKeys = fmt.Sprintf(
		`{"test-status-key":%q}`,
		base64.StdEncoding.EncodeToString(trustFixture.publicKey),
	)
	if _, _, err := productionLicenseLifecycleConfig(""); !errors.Is(err, ErrLicenseLifecycleConfigAbsent) {
		t.Fatalf("plain HTTP configuration returned %v", err)
	}
}

func TestReleaseFSHelperEntryRejectsMissingLicenseBeforeBody(t *testing.T) {
	trustFixture := newLicenseFixture(t)
	originalTrust := trustedStartupLicenseKeys
	trustedStartupLicenseKeys = fmt.Sprintf(
		`{"test-license-key":%q}`,
		base64.StdEncoding.EncodeToString(trustFixture.publicKey),
	)
	t.Cleanup(func() { trustedStartupLicenseKeys = originalTrust })

	tests := []struct {
		name      string
		configure func(*testing.T, string)
		want      error
	}{
		{"credential", func(t *testing.T, packageRoot string) {
			if err := os.MkdirAll(filepath.Join(packageRoot, "license"), 0o700); err != nil {
				t.Fatal(err)
			}
		}, ErrStartupCredentialMissing},
		{"license", func(t *testing.T, packageRoot string) {
			fixture := newLicenseFixture(t)
			fixture.root = packageRoot
			fixture.sign(t)
			fixture.write(t)
			if err := os.Remove(filepath.Join(packageRoot, "license", licenseFilename)); err != nil {
				t.Fatal(err)
			}
		}, ErrLicenseFileMissing},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			usbRoot := t.TempDir()
			packageRoot := filepath.Join(usbRoot, ".uclaw")
			test.configure(t, packageRoot)
			cacheRoot := t.TempDir()
			child := filepath.Join(cacheRoot, "runtime")
			if err := os.Mkdir(child, 0o700); err != nil {
				t.Fatal(err)
			}
			bodyCalls := 0
			releaseFSAfterOpenRoot = func() { bodyCalls++ }
			t.Cleanup(func() { releaseFSAfterOpenRoot = nil })

			err := runReleaseFSHelperEntry(
				[]string{"cleanup-cache", "--root", cacheRoot, "--child", "runtime"},
				filepath.Join(usbRoot, "U-Claw.exe"), filepath.Join(t.TempDir(), "local"),
				bytes.NewReader(nil), io.Discard,
			)
			if !errors.Is(err, test.want) {
				t.Fatalf("returned %v", err)
			}
			if bodyCalls != 0 {
				t.Fatalf("helper body calls = %d", bodyCalls)
			}
			if info, err := os.Stat(child); err != nil || !info.IsDir() {
				t.Fatalf("cache child changed: %v", err)
			}
		})
	}
}
