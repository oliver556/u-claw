package main

import (
	"context"
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
