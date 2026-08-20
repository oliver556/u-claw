package main

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
	if err := os.Remove(filepath.Join(packageRoot, manifest.RuntimeArchive)); err != nil {
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

func TestEnsureRuntimeCacheAuditsAndBlocksMissingEntrypoint(t *testing.T) {
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
	audits := 0
	previousAudit := runtimeFullAudit
	runtimeFullAudit = func(path string) (string, error) { audits++; return previousAudit(path) }
	t.Cleanup(func() { runtimeFullAudit = previousAudit })
	if _, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest); !errors.Is(err, ErrRuntimeAuditFailed) {
		t.Fatalf("damaged runtime returned %v", err)
	}
	if audits != 1 {
		t.Fatalf("full audits = %d", audits)
	}
}

func TestEnsureRuntimeCacheAuditsAndBlocksTamperedCriticalContent(t *testing.T) {
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
	if _, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest); !errors.Is(err, ErrRuntimeAuditFailed) {
		t.Fatalf("tampered runtime returned %v", err)
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

func TestFailedUpdatePreservesPreviouslyInstalledRuntime(t *testing.T) {
	for _, name := range []string{"space", "extraction"} {
		t.Run(name, func(t *testing.T) {
			packageRoot, current := writePackageFixture(t)
			cacheRoot := t.TempDir()
			installed, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, current)
			if err != nil {
				t.Fatal(err)
			}
			candidate := current
			candidate.ReleaseSequence++
			candidate.ReleaseID = "release-43"
			if name == "space" {
				previous := runtimeInstallSpaceAvailable
				runtimeInstallSpaceAvailable = func(string, uint64) bool { return false }
				t.Cleanup(func() { runtimeInstallSpaceAvailable = previous })
			} else {
				payload := []byte("not a gzip archive")
				digest := sha256.Sum256(payload)
				candidate.RuntimeBytes = int64(len(payload))
				candidate.RuntimeSHA256 = hex.EncodeToString(digest[:])
				if err := os.WriteFile(filepath.Join(packageRoot, candidate.RuntimeArchive), payload, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, candidate); err == nil {
				t.Fatal("failed update succeeded")
			}
			if _, err := os.Stat(installed.Path); err != nil {
				t.Fatalf("previous runtime changed: %v", err)
			}
		})
	}
}

func TestReleaseInstallKeepsOtherContentAddressedRuntimesAndCurrentOnFailure(t *testing.T) {
	packageRoot, current := writePackageFixture(t)
	hostRoot := filepath.Join(t.TempDir(), "U-Claw")
	if err := EnsureHostCacheOwnership(hostRoot); err != nil {
		t.Fatal(err)
	}
	cacheRoot := filepath.Join(hostRoot, "runtimes")
	current.Signature = &ManifestSignature{Algorithm: "ed25519", KeyID: "fixture", Sequence: current.ReleaseSequence, Value: "current-signature"}
	first, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, current)
	if err != nil {
		t.Fatal(err)
	}
	if err := AcceptRuntimeSequence(hostRoot, current); err != nil {
		t.Fatal(err)
	}

	next := current
	next.ReleaseID = "release-43"
	next.ReleaseSequence = 43
	next.Signature = &ManifestSignature{Algorithm: "ed25519", KeyID: "fixture", Sequence: 43, Value: "next-signature"}
	second, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, next)
	if err != nil {
		t.Fatal(err)
	}
	if first.Path == second.Path {
		t.Fatal("distinct release reused same install directory")
	}
	for _, path := range []string{first.Path, second.Path} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("runtime missing after parallel install: %v", err)
		}
	}

	failed := next
	failed.ReleaseID = "release-44"
	failed.ReleaseSequence = 44
	failed.Signature = &ManifestSignature{Algorithm: "ed25519", KeyID: "fixture", Sequence: 44, Value: "failed-signature"}
	failed.RuntimeSHA256 = strings.Repeat("0", 64)
	if _, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, failed); err == nil {
		t.Fatal("corrupt update succeeded")
	}
	contents, err := os.ReadFile(filepath.Join(hostRoot, installedCurrentName))
	if err != nil {
		t.Fatal(err)
	}
	var record releaseSequenceRecord
	if err := json.Unmarshal(contents, &record); err != nil {
		t.Fatal(err)
	}
	if record.ReleaseSequence != current.ReleaseSequence || record.ReleaseID != current.ReleaseID {
		t.Fatalf("installed-current changed on failed install: %#v", record)
	}
}

func TestEnsureRuntimeCacheDoesNotReuseSymlinkedCache(t *testing.T) {
	packageRoot, manifest := writePackageFixture(t)
	cacheRoot := t.TempDir()
	outsideRoot := t.TempDir()
	outsideCache := filepath.Join(outsideRoot, runtimeInstallName(manifest))
	if err := os.MkdirAll(filepath.Join(outsideCache, "electron"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideCache, "electron", "electron.exe"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeCacheMarker(outsideCache, manifest); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(cacheRoot, runtimeInstallName(manifest))
	if err := os.Symlink(outsideCache, link); err != nil {
		if runtime.GOOS == "windows" || errors.Is(err, os.ErrPermission) {
			t.Skipf("symlink unavailable: %v", err)
		}
		t.Fatal(err)
	}

	if _, err := EnsureRuntimeCache(context.Background(), cacheRoot, packageRoot, manifest); !errors.Is(err, ErrRuntimeAuditFailed) {
		t.Fatalf("symlinked runtime returned %v", err)
	}
	outsideContent, err := os.ReadFile(filepath.Join(outsideCache, "electron", "electron.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if string(outsideContent) != "outside" {
		t.Fatalf("outside cache changed to %q", outsideContent)
	}
}
