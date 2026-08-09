//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

const errorSharingViolation syscall.Errno = 32

func runtimeLeaseWindowsFixture(t *testing.T) (string, string, Manifest) {
	t.Helper()
	root := t.TempDir()
	entrypoint := filepath.Join(root, "bin", "runtime.exe")
	if err := os.Mkdir(filepath.Dir(entrypoint), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entrypoint, []byte("trusted runtime"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data.bin"), []byte("trusted data"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := runtimeTreeDigestAt(root)
	if err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	manifest.Entrypoint = `bin\runtime.exe`
	manifest.RuntimeTreeSHA256 = digest
	return root, entrypoint, manifest
}

func TestRuntimeLeaseBlocksOverwriteAndReplacement(t *testing.T) {
	root, entrypoint, manifest := runtimeLeaseWindowsFixture(t)
	lease, err := AcquireRuntimeLease(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()

	if err := os.WriteFile(entrypoint, []byte("altered runtime"), 0o600); !errors.Is(err, errorSharingViolation) {
		t.Fatalf("overwrite returned %v", err)
	}
	replacement := filepath.Join(root, "replacement.exe")
	if err := os.WriteFile(replacement, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, entrypoint); !errors.Is(err, errorSharingViolation) {
		t.Fatalf("replacement returned %v", err)
	}
	if err := lease.VerifyEntrypoint(entrypoint); err != nil {
		t.Fatalf("held entrypoint rejected: %v", err)
	}
}

func TestRuntimeLeaseRejectsEntrypointIdentityMismatch(t *testing.T) {
	root, entrypoint, manifest := runtimeLeaseWindowsFixture(t)
	lease, err := AcquireRuntimeLease(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	windowsLease := lease.(*windowsRuntimeLease)
	windowsLease.entrypointIdentity.fileIndexLow++
	if err := lease.VerifyEntrypoint(entrypoint); !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("identity mismatch returned %v", err)
	}
}

func TestRuntimeLeaseRejectsReparsePoint(t *testing.T) {
	root, _, manifest := runtimeLeaseWindowsFixture(t)
	target := filepath.Join(root, "target.bin")
	if err := os.WriteFile(target, []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked.bin")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	file, information, err := openRuntimeLeasePath(link)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if information.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT == 0 || runtimeLeaseFileValid(information) {
		t.Fatalf("reparse attributes accepted: 0x%x", information.FileAttributes)
	}
	if _, err := AcquireRuntimeLease(root, manifest); !errors.Is(err, ErrPackageInvalid) {
		t.Fatalf("reparse point returned %v", err)
	}
}
