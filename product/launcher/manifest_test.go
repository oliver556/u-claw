package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func validRuntimeManifest() Manifest {
	return Manifest{
		SchemaVersion:  1,
		ProductVersion: "0.1.0",
		RuntimeVersion: "2026.7.1-2",
		RuntimeID:      "openclaw-2026.7.1-2-win-x64",
		RuntimeArchive: "runtime.pkg",
		RuntimeSHA256:  strings.Repeat("a", 64),
		RuntimeBytes:   1024,
		UnpackedBytes:  4096,
		FileCount:      8,
		Entrypoint:     `electron\electron.exe`,
		EntryArgs:      []string{"resources/app.asar"},
	}
}

func TestValidateManifestAcceptsFrozenContract(t *testing.T) {
	manifest := validRuntimeManifest()
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
	manifest.RuntimeSHA256 = strings.Repeat("A", 64)
	manifest.RuntimeArchive = "资源/runtime package.pkg"
	manifest.Entrypoint = "node_modules/@scope/package/客户端.exe"
	if err := ValidateManifest(manifest); err != nil {
		t.Fatalf("valid Unicode relative paths rejected: %v", err)
	}
}

func TestValidateManifestRejectsInvalidRuntimeIDs(t *testing.T) {
	for _, runtimeID := range []string{"", " openclaw", "openclaw/win", "openclaw:win", "openclaw win", "运行时"} {
		manifest := validRuntimeManifest()
		manifest.RuntimeID = runtimeID
		if err := ValidateManifest(manifest); !errors.Is(err, ErrManifestInvalid) {
			t.Fatalf("runtimeId %q returned %v", runtimeID, err)
		}
	}
}

func TestValidateManifestRejectsUnsafeWindowsPaths(t *testing.T) {
	paths := []string{
		"", `/runtime.pkg`, `\runtime.pkg`, `C:\runtime.pkg`, `C:runtime.pkg`,
		`\\server\share\runtime.pkg`, `../runtime.pkg`, `..\runtime.pkg`,
		`packages/../runtime.pkg`, `runtime.pkg:payload`, "runtime.pkg\x00payload",
		`runtime.pkg.`, `runtime.pkg `, `CON`, `packages/nul.txt`, `COM1.log`,
		`lpt9`, `CONIN$.txt`, `packages/com¹.bin`,
	}
	for _, field := range []string{"archive", "entrypoint"} {
		for _, value := range paths {
			manifest := validRuntimeManifest()
			if field == "archive" {
				manifest.RuntimeArchive = value
			} else {
				manifest.Entrypoint = value
			}
			if err := ValidateManifest(manifest); !errors.Is(err, ErrManifestInvalid) {
				t.Fatalf("%s path %q returned %v", field, value, err)
			}
		}
	}
}

func TestValidateManifestRejectsMalformedBounds(t *testing.T) {
	mutations := []func(*Manifest){
		func(value *Manifest) { value.SchemaVersion = 2 },
		func(value *Manifest) { value.ProductVersion = "" },
		func(value *Manifest) { value.RuntimeVersion = "bad\nversion" },
		func(value *Manifest) { value.RuntimeSHA256 = strings.Repeat("g", 64) },
		func(value *Manifest) { value.RuntimeBytes = 0 },
		func(value *Manifest) { value.UnpackedBytes = -1 },
		func(value *Manifest) { value.FileCount = 0 },
		func(value *Manifest) { value.EntryArgs = []string{"bad\x00argument"} },
	}
	for index, mutate := range mutations {
		manifest := validRuntimeManifest()
		mutate(&manifest)
		if err := ValidateManifest(manifest); !errors.Is(err, ErrManifestInvalid) {
			t.Fatalf("mutation %d returned %v", index, err)
		}
	}
}

func TestReadManifestIsStrict(t *testing.T) {
	directory := t.TempDir()
	valid := `{
		"schemaVersion":1,
		"productVersion":"0.1.0",
		"runtimeVersion":"2026.7.1-2",
		"runtimeId":"openclaw-win-x64",
		"runtimeArchive":"runtime.pkg",
		"runtimeSha256":"` + strings.Repeat("a", 64) + `",
		"runtimeBytes":1,
		"unpackedBytes":1,
		"fileCount":1,
		"entrypoint":"electron.exe",
		"entryArgs":[]
	}`
	path := filepath.Join(directory, "version.json")
	if err := os.WriteFile(path, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadManifest(path); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	for name, suffix := range map[string]string{
		"unknown-field": strings.Replace(valid, `"entryArgs":[]`, `"entryArgs":[],"unknown":true`, 1),
		"trailing-json": valid + `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(suffix), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := ReadManifest(path); !errors.Is(err, ErrManifestInvalid) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestValidatePackageChecksSizeAndDigest(t *testing.T) {
	directory := t.TempDir()
	payload := []byte("runtime payload")
	if err := os.WriteFile(filepath.Join(directory, "runtime.pkg"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	manifest := validRuntimeManifest()
	manifest.RuntimeBytes = int64(len(payload))
	manifest.RuntimeSHA256 = strings.ToUpper(hex.EncodeToString(digest[:]))
	if err := ValidatePackage(directory, manifest); err != nil {
		t.Fatalf("valid package rejected: %v", err)
	}

	manifest.RuntimeBytes++
	if err := ValidatePackage(directory, manifest); !errors.Is(err, ErrPackageInvalid) {
		t.Fatalf("size mismatch returned %v", err)
	}
	manifest.RuntimeBytes--
	manifest.RuntimeSHA256 = strings.Repeat("0", 64)
	if err := ValidatePackage(directory, manifest); !errors.Is(err, ErrPackageInvalid) {
		t.Fatalf("digest mismatch returned %v", err)
	}
}

func TestValidatePackageAllowsUnicodeBaseDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "中文 路径")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	payload := []byte("payload")
	if err := os.WriteFile(filepath.Join(directory, "runtime.pkg"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	manifest := validRuntimeManifest()
	manifest.RuntimeBytes = int64(len(payload))
	manifest.RuntimeSHA256 = hex.EncodeToString(digest[:])
	if err := ValidatePackage(directory, manifest); err != nil {
		t.Fatal(err)
	}
}

func TestValidatePackageRejectsSymlinkEscape(t *testing.T) {
	directory := t.TempDir()
	payload := []byte("outside payload")
	outside := filepath.Join(t.TempDir(), "runtime.pkg")
	if err := os.WriteFile(outside, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(directory, "runtime.pkg")); err != nil {
		if runtime.GOOS == "windows" || errors.Is(err, os.ErrPermission) {
			t.Skipf("symlink unavailable: %v", err)
		}
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	manifest := validRuntimeManifest()
	manifest.RuntimeBytes = int64(len(payload))
	manifest.RuntimeSHA256 = hex.EncodeToString(digest[:])
	if err := ValidatePackage(directory, manifest); !errors.Is(err, ErrPackageInvalid) {
		t.Fatalf("symlink package returned %v", err)
	}
}
