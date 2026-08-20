package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestResolvePortablePathsUsesExecutableAndLocalAppData(t *testing.T) {
	usbRoot := filepath.Join(t.TempDir(), "中文 U 盘")
	executable := filepath.Join(usbRoot, "U-Claw.exe")
	localAppData := filepath.Join(t.TempDir(), "Local App Data")
	paths, err := ResolvePortablePaths(executable, localAppData)
	if err != nil {
		t.Fatal(err)
	}
	if paths.USBRoot != usbRoot ||
		paths.PackageRoot != filepath.Join(usbRoot, ".uclaw") ||
		paths.DataDir != filepath.Join(usbRoot, ".uclaw", "data") ||
		paths.CacheRoot != filepath.Join(localAppData, "U-Claw", "runtimes") {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestResolvePortablePathsRejectsRelativeInputs(t *testing.T) {
	for name, inputs := range map[string][2]string{
		"executable": {"U-Claw.exe", t.TempDir()},
		"local-data": {filepath.Join(t.TempDir(), "U-Claw.exe"), "LocalAppData"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ResolvePortablePaths(inputs[0], inputs[1]); !errors.Is(err, ErrPortablePathInvalid) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestResolvePortablePathsChangesWithExecutableRoot(t *testing.T) {
	localAppData := filepath.Join(t.TempDir(), "Local App Data")
	firstRoot := filepath.Join(t.TempDir(), "drive-e")
	secondRoot := filepath.Join(t.TempDir(), "drive-r")
	first, err := ResolvePortablePaths(filepath.Join(firstRoot, "U-Claw.exe"), localAppData)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ResolvePortablePaths(filepath.Join(secondRoot, "U-Claw.exe"), localAppData)
	if err != nil {
		t.Fatal(err)
	}
	if first.DataDir == second.DataDir || first.DataDir != filepath.Join(firstRoot, ".uclaw", "data") || second.DataDir != filepath.Join(secondRoot, ".uclaw", "data") {
		t.Fatalf("drive-relative data paths = %q, %q", first.DataDir, second.DataDir)
	}
	if first.HostCacheRoot != second.HostCacheRoot || first.HostCacheRoot != filepath.Join(localAppData, "U-Claw") {
		t.Fatalf("host cache roots = %q, %q", first.HostCacheRoot, second.HostCacheRoot)
	}
}

func TestProbeDataDirectoryCreatesOnlyDataDirectory(t *testing.T) {
	packageRoot := filepath.Join(t.TempDir(), ".uclaw")
	if err := os.Mkdir(packageRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(packageRoot, "data")
	if err := ProbeDataDirectory(packageRoot, dataDir); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("probe left files: %v", entries)
	}
}

func TestProbeDataDirectoryRejectsSymlinkEscape(t *testing.T) {
	packageRoot := filepath.Join(t.TempDir(), ".uclaw")
	if err := os.Mkdir(packageRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(packageRoot, "data")); err != nil {
		if runtime.GOOS == "windows" || errors.Is(err, os.ErrPermission) {
			t.Skipf("symlink unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if err := ProbeDataDirectory(packageRoot, filepath.Join(packageRoot, "data")); !errors.Is(err, ErrUSBNotWritable) {
		t.Fatalf("returned %v", err)
	}
}

func TestMonitorUSBDetectsDisconnect(t *testing.T) {
	root := filepath.Join(t.TempDir(), "usb")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		result <- MonitorUSB(context.Background(), root, 5*time.Millisecond)
	}()
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, ErrUSBDisconnected) {
			t.Fatalf("returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("disconnect was not detected")
	}
}

func TestMonitorUSBHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := MonitorUSB(ctx, t.TempDir(), time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("returned %v", err)
	}
}
