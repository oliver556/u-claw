package main

import (
	"archive/tar"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func writePackageFixture(t *testing.T) (string, Manifest) {
	t.Helper()
	entries := []archiveEntry{
		{name: "electron", typeflag: tar.TypeDir},
		{name: "electron/electron.exe", body: []byte("executable")},
		{name: "resources/app.asar", body: []byte("application")},
	}
	archive := buildRuntimeArchive(t, entries)
	manifest := manifestForArchive(archive, entries)
	packageRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(packageRoot, manifest.RuntimeArchive), archive, 0o600); err != nil {
		t.Fatal(err)
	}
	return packageRoot, manifest
}

func TestEnsureRuntimeCacheBuildsThenReuses(t *testing.T) {
	packageRoot, manifest := writePackageFixture(t)
	cacheRoot := t.TempDir()
	first, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if first.Reused {
		t.Fatal("first launch reported reused cache")
	}
	markerInfo, err := os.Stat(filepath.Join(first.Path, cacheMarkerName))
	if err != nil {
		t.Fatal(err)
	}

	second, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Reused || second.Path != first.Path {
		t.Fatalf("second result = %#v", second)
	}
	secondMarkerInfo, err := os.Stat(filepath.Join(second.Path, cacheMarkerName))
	if err != nil {
		t.Fatal(err)
	}
	if !secondMarkerInfo.ModTime().Equal(markerInfo.ModTime()) {
		t.Fatal("second launch rewrote cache marker")
	}
}

func TestEnsureRuntimeCacheRebuildsMissingEntrypoint(t *testing.T) {
	packageRoot, manifest := writePackageFixture(t)
	cacheRoot := t.TempDir()
	first, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	entrypoint := filepath.Join(first.Path, filepath.FromSlash("electron/electron.exe"))
	if err := os.Remove(entrypoint); err != nil {
		t.Fatal(err)
	}
	second, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if second.Reused {
		t.Fatal("damaged cache was reused")
	}
	if _, err := os.Stat(entrypoint); err != nil {
		t.Fatalf("entrypoint was not rebuilt: %v", err)
	}
}

func TestEnsureRuntimeCacheRemovesPartialDirectoryAfterCancellation(t *testing.T) {
	packageRoot, manifest := writePackageFixture(t)
	cacheRoot := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := EnsureRuntimeCache(ctx, cacheRoot, packageRoot, manifest); err == nil {
		t.Fatal("cancelled cache preparation succeeded")
	}
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("cache root contains %v", entries)
	}
}

func TestEnsureRuntimeCacheRejectsCorruptPackageBeforeChangingCache(t *testing.T) {
	packageRoot, manifest := writePackageFixture(t)
	cacheRoot := t.TempDir()
	manifest.RuntimeSHA256 = "0" + manifest.RuntimeSHA256[1:]
	if _, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest); err == nil {
		t.Fatal("corrupt package accepted")
	}
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("cache root changed: %v", entries)
	}
}

func TestEnsureRuntimeCacheDoesNotReuseSymlinkedCache(t *testing.T) {
	packageRoot, manifest := writePackageFixture(t)
	cacheRoot := t.TempDir()
	outsideRoot := t.TempDir()
	outsideCache := filepath.Join(outsideRoot, manifest.RuntimeID)
	if err := os.MkdirAll(filepath.Join(outsideCache, "electron"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideCache, "electron", "electron.exe"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeCacheMarker(outsideCache, manifest); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(cacheRoot, manifest.RuntimeID)
	if err := os.Symlink(outsideCache, link); err != nil {
		if runtime.GOOS == "windows" || errors.Is(err, os.ErrPermission) {
			t.Skipf("symlink unavailable: %v", err)
		}
		t.Fatal(err)
	}

	result, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if result.Reused {
		t.Fatal("symlinked cache was reused")
	}
	info, err := os.Lstat(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		t.Fatalf("cache mode = %v", info.Mode())
	}
	outsideContent, err := os.ReadFile(filepath.Join(outsideCache, "electron", "electron.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if string(outsideContent) != "outside" {
		t.Fatalf("outside cache changed to %q", outsideContent)
	}
}
