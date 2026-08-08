//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

func TestValidatePackageRejectsWindowsDirectoryLinkEscape(t *testing.T) {
	baseDir := t.TempDir()
	outsideDir := t.TempDir()
	payload := []byte("outside Windows payload")
	if err := os.WriteFile(filepath.Join(outsideDir, "runtime.pkg"), payload, 0o600); err != nil {
		t.Fatal(err)
	}

	linkPath := filepath.Join(baseDir, "packages")
	createWindowsDirectoryLink(t, linkPath, outsideDir)
	t.Cleanup(func() { _ = os.Remove(linkPath) })

	digest := sha256.Sum256(payload)
	manifest := Manifest{
		RuntimeID: "openclaw-win-x64",
		Archive:   `packages\runtime.pkg`,
		SHA256:    hex.EncodeToString(digest[:]),
	}
	if err := ValidatePackage(baseDir, manifest); err == nil {
		t.Fatal("accepted Windows directory link escaping base directory")
	}
}

func createWindowsDirectoryLink(t *testing.T, linkPath, targetPath string) {
	t.Helper()
	junctionOutput, junctionErr := exec.Command("cmd", "/c", "mklink", "/J", linkPath, targetPath).CombinedOutput()
	if junctionErr == nil {
		return
	}

	symlinkErr := os.Symlink(targetPath, linkPath)
	if symlinkErr == nil {
		return
	}
	if errors.Is(symlinkErr, os.ErrPermission) ||
		errors.Is(symlinkErr, syscall.ERROR_PRIVILEGE_NOT_HELD) ||
		errors.Is(symlinkErr, syscall.Errno(50)) {
		t.Skipf("Windows junction and symlink unavailable: junction=%v (%s), symlink=%v", junctionErr, junctionOutput, symlinkErr)
	}
	t.Fatalf("create Windows junction or symlink: junction=%v (%s), symlink=%v", junctionErr, junctionOutput, symlinkErr)
}
