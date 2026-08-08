package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func validManifest() Manifest {
	return Manifest{
		RuntimeID: "openclaw-2026.7.1-2-win-x64",
		Archive:   `packages\runtime.pkg`,
		SHA256:    strings.Repeat("a", 64),
	}
}

func TestValidateManifest(t *testing.T) {
	manifest := validManifest()
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}

	manifest.SHA256 = strings.Repeat("A", 64)
	if err := ValidateManifest(manifest); err != nil {
		t.Fatalf("uppercase SHA-256 should be accepted: %v", err)
	}
}

func TestRejectsInvalidRuntimeIDs(t *testing.T) {
	for _, runtimeID := range []string{"", " openclaw", "openclaw/win", "openclaw:win", "openclaw win", "运行时"} {
		t.Run(runtimeID, func(t *testing.T) {
			manifest := validManifest()
			manifest.RuntimeID = runtimeID
			if err := ValidateManifest(manifest); err == nil {
				t.Fatalf("accepted runtimeId %q", runtimeID)
			}
		})
	}
}

func TestRejectsUnsafeWindowsArchivePaths(t *testing.T) {
	paths := []string{
		"",
		`/runtime.pkg`,
		`\runtime.pkg`,
		`C:\runtime.pkg`,
		`C:runtime.pkg`,
		`\\server\share\runtime.pkg`,
		`\\?\C:\runtime.pkg`,
		`\\.\C:\runtime.pkg`,
		`../runtime.pkg`,
		`..\runtime.pkg`,
		`packages/../runtime.pkg`,
		`packages\..\runtime.pkg`,
		`packages/\runtime.pkg`,
		`runtime.pkg:payload`,
		"runtime.pkg\x00payload",
	}

	for _, archive := range paths {
		t.Run(strings.ReplaceAll(archive, `\`, `_`), func(t *testing.T) {
			manifest := validManifest()
			manifest.Archive = archive
			if err := ValidateManifest(manifest); err == nil {
				t.Fatalf("accepted archive %q", archive)
			}
		})
	}
}

func TestRejectsMalformedSHA256(t *testing.T) {
	for _, value := range []string{"", "abc", strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("g", 64)} {
		manifest := validManifest()
		manifest.SHA256 = value
		if err := ValidateManifest(manifest); err == nil {
			t.Fatalf("accepted SHA-256 %q", value)
		}
	}
}

func TestValidatePackageUsesArchiveContent(t *testing.T) {
	dir := t.TempDir()
	archiveDir := filepath.Join(dir, "packages")
	if err := os.Mkdir(archiveDir, 0o700); err != nil {
		t.Fatal(err)
	}
	payload := []byte("payload")
	if err := os.WriteFile(filepath.Join(archiveDir, "runtime.pkg"), payload, 0o600); err != nil {
		t.Fatal(err)
	}

	digest := sha256.Sum256(payload)
	manifest := validManifest()
	manifest.SHA256 = strings.ToUpper(hex.EncodeToString(digest[:]))
	if err := ValidatePackage(dir, manifest); err != nil {
		t.Fatalf("valid package rejected: %v", err)
	}

	manifest.SHA256 = strings.Repeat("0", 64)
	if err := ValidatePackage(dir, manifest); err == nil {
		t.Fatal("expected archive hash mismatch")
	}
}

func TestCLIRealProcessSuccessAndPathRedaction(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "launcher")
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	build := exec.Command("go", "build", "-o", executable, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}

	packageDir := t.TempDir()
	payload := []byte("cli payload")
	if err := os.WriteFile(filepath.Join(packageDir, "runtime.pkg"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	manifest := Manifest{
		RuntimeID: "openclaw-win-x64",
		Archive:   "runtime.pkg",
		SHA256:    hex.EncodeToString(digest[:]),
	}
	manifestPath := filepath.Join(packageDir, "manifest.json")
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, manifestJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(executable, "--manifest", manifestPath)
	stdout, err := command.Output()
	if err != nil {
		t.Fatalf("valid CLI invocation failed: %v", err)
	}
	if got, want := string(stdout), "{\"status\":\"ready\",\"candidate\":\"go\"}\n"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}

	secretDir := filepath.Join(t.TempDir(), "private-absolute-path")
	missingManifest := filepath.Join(secretDir, "secret-manifest.json")
	command = exec.Command(executable, "--manifest", missingManifest)
	stdout, err = command.Output()
	if err == nil {
		t.Fatal("missing manifest should fail")
	}
	if len(stdout) != 0 {
		t.Fatalf("failure stdout = %q", stdout)
	}
	exitError, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("error type = %T", err)
	}
	stderr := string(exitError.Stderr)
	if stderr != "E_MANIFEST_READ\n" {
		t.Fatalf("stderr = %q", stderr)
	}
	for _, secret := range []string{secretDir, missingManifest, "secret-manifest.json"} {
		if strings.Contains(stderr, secret) {
			t.Fatalf("stderr leaked %q: %q", secret, stderr)
		}
	}

	assertCLIError(t, executable, nil, "E_ARGUMENTS", "")

	secret := filepath.Join(packageDir, "manifest-content-secret")
	malformed := []byte(`{"runtimeId":"` + secret)
	if err := os.WriteFile(manifestPath, malformed, 0o600); err != nil {
		t.Fatal(err)
	}
	assertCLIError(t, executable, []string{"--manifest", manifestPath}, "E_MANIFEST_JSON", secret)

	trailingJSON := append(append([]byte(nil), manifestJSON...), []byte(` {}`)...)
	if err := os.WriteFile(manifestPath, trailingJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	assertCLIError(t, executable, []string{"--manifest", manifestPath}, "E_MANIFEST_JSON", string(trailingJSON))

	invalidManifest := manifest
	invalidManifest.RuntimeID = secret
	writeManifest(t, manifestPath, invalidManifest)
	assertCLIError(t, executable, []string{"--manifest", manifestPath}, "E_MANIFEST_INVALID", secret)

	invalidManifest = manifest
	invalidManifest.SHA256 = strings.Repeat("0", 64)
	writeManifest(t, manifestPath, invalidManifest)
	assertCLIError(t, executable, []string{"--manifest", manifestPath}, "E_PACKAGE_INVALID", secret)
}

func writeManifest(t *testing.T, path string, manifest Manifest) {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertCLIError(t *testing.T, executable string, args []string, code, secret string) {
	t.Helper()
	command := exec.Command(executable, args...)
	stdout, err := command.Output()
	if err == nil {
		t.Fatalf("%s case should fail", code)
	}
	if len(stdout) != 0 {
		t.Fatalf("%s stdout = %q", code, stdout)
	}
	exitError, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("%s error type = %T", code, err)
	}
	if got, want := string(exitError.Stderr), code+"\n"; got != want {
		t.Fatalf("stderr = %q, want %q", got, want)
	}
	if secret != "" && strings.Contains(string(exitError.Stderr), secret) {
		t.Fatalf("%s stderr leaked %q", code, secret)
	}
}
