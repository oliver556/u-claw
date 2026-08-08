package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

	manifest.Archive = `packages/runtime package_1-2.pkg`
	if err := ValidateManifest(manifest); err != nil {
		t.Fatalf("safe ASCII archive path should be accepted: %v", err)
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
		`runtime.pkg.`,
		`runtime.pkg `,
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

func TestRejectsWindowsInvalidFilenameCharacters(t *testing.T) {
	for _, character := range []string{"<", ">", `"`, "|", "?", "*"} {
		manifest := validManifest()
		manifest.Archive = "packages/runtime" + character + ".pkg"
		if err := ValidateManifest(manifest); err == nil {
			t.Fatalf("accepted Windows filename character %q", character)
		}
	}
}

func TestRejectsASCIIControlCharacters(t *testing.T) {
	controls := make([]byte, 0, 33)
	for value := byte(0); value <= 31; value++ {
		controls = append(controls, value)
	}
	controls = append(controls, 127)

	for _, control := range controls {
		manifest := validManifest()
		manifest.Archive = "packages/runtime" + string(rune(control)) + ".pkg"
		if err := ValidateManifest(manifest); err == nil {
			t.Fatalf("accepted ASCII control character 0x%02x", control)
		}
	}
}

func TestRejectsWindowsDeviceNamesCaseInsensitively(t *testing.T) {
	archives := []string{
		"CON",
		"con.txt",
		"packages/NuL.pkg",
		"aux",
		"PrN.log",
		"COM1",
		"com9.bin",
		"LPT1",
		"lPt9.archive.tar",
		"packages/CON .txt",
		"packages/NUL.txt. ",
	}

	for _, archive := range archives {
		manifest := validManifest()
		manifest.Archive = archive
		if err := ValidateManifest(manifest); err == nil {
			t.Fatalf("accepted Windows device name %q", archive)
		}
	}
}

func TestRejectsUnicodeDOSDeviceAliases(t *testing.T) {
	for _, archive := range []string{"COM¹", "com².txt", "packages/Com³.pkg", "LPT¹", "lpt².txt", "packages/LpT³.pkg"} {
		manifest := validManifest()
		manifest.Archive = archive
		if err := ValidateManifest(manifest); err == nil {
			t.Fatalf("accepted Unicode DOS device alias %q", archive)
		}
	}
}

func TestRejectsConsoleDeviceNames(t *testing.T) {
	for _, archive := range []string{"CONIN$", "conin$.txt", "CONOUT$", "packages/conout$.pkg"} {
		manifest := validManifest()
		manifest.Archive = archive
		if err := ValidateManifest(manifest); err == nil {
			t.Fatalf("accepted console device name %q", archive)
		}
	}
}

func TestAllowsNonDeviceBasenames(t *testing.T) {
	for _, archive := range []string{"console.pkg", "com0.pkg", "com10.pkg", "lpt0", "lpt10", "auxiliary"} {
		manifest := validManifest()
		manifest.Archive = archive
		if err := ValidateManifest(manifest); err != nil {
			t.Fatalf("rejected non-device basename %q: %v", archive, err)
		}
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

func TestValidatePackageAllowsUnicodeBaseDirectory(t *testing.T) {
	baseDir := filepath.Join(t.TempDir(), "中文 路径")
	if err := os.Mkdir(baseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	payload := []byte("unicode base directory")
	if err := os.WriteFile(filepath.Join(baseDir, "runtime.pkg"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	manifest := Manifest{
		RuntimeID: "openclaw-win-x64",
		Archive:   "runtime.pkg",
		SHA256:    hex.EncodeToString(digest[:]),
	}
	if err := ValidatePackage(baseDir, manifest); err != nil {
		t.Fatalf("Unicode base directory rejected: %v", err)
	}
}

func TestValidatePackageRejectsSymlinkEscape(t *testing.T) {
	baseDir := t.TempDir()
	outsideDir := t.TempDir()
	payload := []byte("outside payload")
	outsideArchive := filepath.Join(outsideDir, "runtime.pkg")
	if err := os.WriteFile(outsideArchive, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	linkPath := filepath.Join(baseDir, "runtime.pkg")
	if err := os.Symlink(outsideArchive, linkPath); err != nil {
		if runtime.GOOS == "windows" || errors.Is(err, os.ErrPermission) {
			t.Skipf("symlink creation unavailable on this OS or without permission: %v", err)
		}
		t.Fatalf("create symlink: %v", err)
	}

	digest := sha256.Sum256(payload)
	manifest := Manifest{
		RuntimeID: "openclaw-win-x64",
		Archive:   "runtime.pkg",
		SHA256:    hex.EncodeToString(digest[:]),
	}
	if err := ValidatePackage(baseDir, manifest); err == nil {
		t.Fatal("accepted archive symlink escaping base directory")
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

	packageDir := filepath.Join(t.TempDir(), "中文 路径")
	if err := os.Mkdir(packageDir, 0o700); err != nil {
		t.Fatal(err)
	}
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

	for _, archive := range []string{"bad?.pkg", "CON.txt", "COM¹.pkg", "CONOUT$.pkg"} {
		invalidManifest = manifest
		invalidManifest.Archive = archive
		writeManifest(t, manifestPath, invalidManifest)
		assertCLIError(t, executable, []string{"--manifest", manifestPath}, "E_MANIFEST_INVALID", archive)
	}
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
