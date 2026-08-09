//go:build windows

package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func createJunctionForTest(t *testing.T, junction, target string) {
	t.Helper()
	command := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", junction, target)
	if output, err := command.CombinedOutput(); err != nil {
		t.Skipf("junction unavailable: %v (%s)", err, output)
	}
}

func TestReleaseFSHelperRejectsJunctionRoot(t *testing.T) {
	outside := t.TempDir()
	junction := filepath.Join(t.TempDir(), "cache-junction")
	createJunctionForTest(t, junction, outside)
	if err := runReleaseFSHelper([]string{"cleanup-cache", "--root", junction, "--child", "runtime"}, bytes.NewReader(nil), os.Stdout); !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("junction root returned %v", err)
	}
}

func TestReleaseFSHelperCleanupRejectsChildJunction(t *testing.T) {
	root := filepath.Join(t.TempDir(), "U-Claw")
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	createJunctionForTest(t, filepath.Join(root, "runtime"), outside)
	if err := runReleaseFSHelper([]string{"cleanup-cache", "--root", root, "--child", "runtime"}, bytes.NewReader(nil), os.Stdout); !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("child junction returned %v", err)
	}
	if got, err := os.ReadFile(sentinel); err != nil || string(got) != "keep" {
		t.Fatalf("outside sentinel=%q err=%v", got, err)
	}
}
