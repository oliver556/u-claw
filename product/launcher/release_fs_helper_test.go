package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func releaseFSSigningKey(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyID := "release-fs-test"
	trustRuntimeTestKey(t, keyID, public)
	return keyID, private
}

func signedReleaseFSManifest(t *testing.T, content []byte, sequence uint64, keyID string, private ed25519.PrivateKey) Manifest {
	t.Helper()
	digest := sha256.Sum256(content)
	manifest := validRuntimeManifest()
	manifest.RuntimeBytes = int64(len(content))
	manifest.RuntimeSHA256 = hex.EncodeToString(digest[:])
	return signedRuntimeManifest(t, manifest, keyID, private, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), sequence)
}

func writeReleaseFSManifest(t *testing.T, path string, manifest Manifest) {
	t.Helper()
	content, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(content, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func releaseFSInstallInput(t *testing.T, manifest Manifest, content []byte) io.Reader {
	t.Helper()
	header, err := json.Marshal(secureInstallRequest{SchemaVersion: 1, Manifest: manifest})
	if err != nil {
		t.Fatal(err)
	}
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(header)))
	return io.MultiReader(bytes.NewReader(size[:]), bytes.NewReader(header), bytes.NewReader(content))
}

func TestReleaseFSHelperSecureInstallUsesOneRootHandle(t *testing.T) {
	content := []byte("runtime-v2")
	keyID, private := releaseFSSigningKey(t)
	manifest := signedReleaseFSManifest(t, content, 42, keyID, private)
	parent := t.TempDir()
	root := filepath.Join(parent, ".uclaw")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	original := root + ".original"
	outside := filepath.Join(parent, "outside")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	outsideSentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(outsideSentinel, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	releaseFSAfterOpenRoot = func() {
		if err := os.Rename(root, original); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, root); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { releaseFSAfterOpenRoot = nil })

	if err := runReleaseFSHelper([]string{"secure-install", "--root", root}, releaseFSInstallInput(t, manifest, content), io.Discard); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(original, "runtime.pkg")); err != nil || !bytes.Equal(got, content) {
		t.Fatalf("installed runtime=%q err=%v", got, err)
	}
	if got, err := os.ReadFile(outsideSentinel); err != nil || string(got) != "keep" {
		t.Fatalf("outside sentinel=%q err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(outside, "runtime.pkg")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("outside runtime changed: %v", err)
	}
}

func TestReleaseFSHelperSecureInstallPreservesRollback(t *testing.T) {
	root := t.TempDir()
	keyID, private := releaseFSSigningKey(t)
	oldContent := []byte("runtime-v1")
	oldManifest := signedReleaseFSManifest(t, oldContent, 41, keyID, private)
	if err := os.WriteFile(filepath.Join(root, "runtime.pkg"), oldContent, 0o600); err != nil {
		t.Fatal(err)
	}
	writeReleaseFSManifest(t, filepath.Join(root, "version.json"), oldManifest)

	newContent := []byte("runtime-v2")
	newManifest := signedReleaseFSManifest(t, newContent, 42, keyID, private)
	if err := runReleaseFSHelper([]string{"secure-install", "--root", root}, releaseFSInstallInput(t, newManifest, newContent), io.Discard); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "runtime.pkg.rollback")); !bytes.Equal(got, oldContent) {
		t.Fatalf("rollback runtime=%q", got)
	}
	var transaction updateTransaction
	raw, err := os.ReadFile(filepath.Join(root, updateTransactionName))
	if err != nil || json.Unmarshal(raw, &transaction) != nil || transaction.State != "complete" || transaction.Previous == nil || transaction.Previous.Sequence != 41 {
		t.Fatalf("transaction=%+v err=%v", transaction, err)
	}
}

func TestReleaseFSHelperCleanupRejectsReplacementReparsePoint(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("junction behavior is covered by Windows helper tests")
	}
	root := filepath.Join(t.TempDir(), "U-Claw")
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(root, "runtime")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	releaseFSBeforeQuarantine = func() {
		if err := os.Rename(child, child+".original"); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, child); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { releaseFSBeforeQuarantine = nil })

	err := runReleaseFSHelper([]string{"cleanup-cache", "--root", root, "--child", "runtime"}, bytes.NewReader(nil), io.Discard)
	if !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("replacement returned %v", err)
	}
	if got, err := os.ReadFile(sentinel); err != nil || string(got) != "keep" {
		t.Fatalf("outside sentinel=%q err=%v", got, err)
	}
}

func TestReleaseFSHelperRejectsSymlinkRootAndUnknownChild(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink privilege is environment-dependent on Windows")
	}
	outside := t.TempDir()
	root := filepath.Join(t.TempDir(), "linked-root")
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"cleanup-cache", "--root", root, "--child", "runtime"},
		{"cleanup-cache", "--root", outside, "--child", "../outside"},
	} {
		if err := runReleaseFSHelper(args, bytes.NewReader(nil), io.Discard); err == nil {
			t.Fatalf("unsafe args accepted: %v", args)
		}
	}
}
