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

func TestEnsureHostCacheOwnershipCreatesAuditableMarker(t *testing.T) {
	root := filepath.Join(t.TempDir(), "U-Claw")
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	marker, err := os.ReadFile(filepath.Join(root, hostCacheMarkerName))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"schemaVersion":1,"product":"U-Claw","purpose":"rebuildable-cache"}` + "\n"
	if string(marker) != want {
		t.Fatalf("marker = %q", marker)
	}
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatalf("valid marker was not reusable: %v", err)
	}
	for _, path := range []string{filepath.Join(root, "cache"), filepath.Join(root, "cache", "temp")} {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("owned cache directory %q: info=%v err=%v", path, info, err)
		}
	}
}

func TestEnsureHostCacheOwnershipRejectsUnsafeRootsAndForeignMarkers(t *testing.T) {
	for name, root := range map[string]string{
		"relative":        "U-Claw",
		"filesystem-root": filepath.VolumeName(t.TempDir()) + string(os.PathSeparator),
	} {
		t.Run(name, func(t *testing.T) {
			if err := EnsureHostCacheOwnership(root); !errors.Is(err, ErrCachePreparationFailed) {
				t.Fatalf("returned %v", err)
			}
		})
	}
	root := filepath.Join(t.TempDir(), "U-Claw")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, hostCacheMarkerName), []byte(`{"product":"another-app"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureHostCacheOwnership(root); !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("foreign marker returned %v", err)
	}
}

func TestEnsureHostCacheOwnershipRejectsTrailingJson(t *testing.T) {
	root := filepath.Join(t.TempDir(), "U-Claw")
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(root, hostCacheMarkerName)
	marker, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(markerPath, append(marker, []byte("{}\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureHostCacheOwnership(root); !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("trailing JSON returned %v", err)
	}
}

func TestEnsureHostCacheOwnershipRejectsSymlinkedRoot(t *testing.T) {
	outside := t.TempDir()
	root := filepath.Join(t.TempDir(), "U-Claw")
	if err := os.Symlink(outside, root); err != nil {
		if runtime.GOOS == "windows" || errors.Is(err, os.ErrPermission) {
			t.Skipf("symlink unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if err := EnsureHostCacheOwnership(root); !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("symlinked root returned %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, hostCacheMarkerName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("outside marker changed: %v", err)
	}
}

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

func TestEnsureRuntimeCacheRebuildsTamperedCachedContent(t *testing.T) {
	packageRoot, manifest := writePackageFixture(t)
	cacheRoot := t.TempDir()
	first, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(first.Path, filepath.FromSlash("resources/app.asar"))
	if err := os.WriteFile(app, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if second.Reused {
		t.Fatal("tampered cache was reused")
	}
	content, err := os.ReadFile(app)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "application" {
		t.Fatalf("cache content was not restored: %q", content)
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
