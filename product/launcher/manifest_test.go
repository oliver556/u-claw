package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func signedRuntimeManifest(t *testing.T, manifest Manifest, keyID string, private ed25519.PrivateKey, signedAt, expiresAt time.Time, sequence uint64) Manifest {
	t.Helper()
	manifest.ReleaseSequence = sequence
	manifest.ReleaseID = fmt.Sprintf("release-%d", sequence)
	manifest.Signature = &ManifestSignature{Algorithm: "ed25519", KeyID: keyID, SignedAt: signedAt.UTC().Format(time.RFC3339), ExpiresAt: expiresAt.UTC().Format(time.RFC3339), Sequence: sequence}
	payload, err := manifestSigningPayload(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))
	return manifest
}

func trustRuntimeTestKey(t *testing.T, keyID string, public ed25519.PublicKey) {
	t.Helper()
	previousKeys, previousRevoked := trustedRuntimeKeys, revokedRuntimeKeyIDs
	encoded, _ := json.Marshal(map[string]string{keyID: base64.StdEncoding.EncodeToString(public)})
	trustedRuntimeKeys, revokedRuntimeKeyIDs = string(encoded), "[]"
	t.Cleanup(func() { trustedRuntimeKeys, revokedRuntimeKeyIDs = previousKeys, previousRevoked })
}

func validRuntimeManifest() Manifest {
	return Manifest{
		SchemaVersion:     1,
		ReleaseID:         "release-42",
		ReleaseSequence:   42,
		ProductVersion:    "0.1.0",
		NodeVersion:       "24.15.0",
		ElectronVersion:   "40.10.6",
		RuntimeVersion:    "2026.7.1-2",
		RuntimeID:         "openclaw-2026.7.1-2-win-x64",
		TargetPlatform:    "win32",
		TargetArch:        "x64",
		RuntimeArchive:    "runtime.pkg",
		RuntimeSHA256:     strings.Repeat("a", 64),
		RuntimeTreeSHA256: strings.Repeat("b", 64),
		RuntimeBytes:      1024,
		UnpackedBytes:     4096,
		FileCount:         8,
		Entrypoint:        `electron\electron.exe`,
		EntryArgs:         []string{"resources/app.asar"},
		CriticalFiles:     []RuntimeFileDigest{{Path: `electron\electron.exe`, Size: 10, SHA256: strings.Repeat("c", 64)}},
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
	manifest.CriticalFiles[0].Path = manifest.Entrypoint
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
		func(value *Manifest) { value.ReleaseID = "bad release" },
		func(value *Manifest) { value.ReleaseSequence = 0 },
		func(value *Manifest) { value.ProductVersion = "" },
		func(value *Manifest) { value.NodeVersion = "" },
		func(value *Manifest) { value.ElectronVersion = "" },
		func(value *Manifest) { value.RuntimeVersion = "bad\nversion" },
		func(value *Manifest) { value.TargetPlatform = "linux" },
		func(value *Manifest) { value.TargetArch = "arm64" },
		func(value *Manifest) { value.RuntimeSHA256 = strings.Repeat("g", 64) },
		func(value *Manifest) { value.RuntimeBytes = 0 },
		func(value *Manifest) { value.UnpackedBytes = -1 },
		func(value *Manifest) { value.FileCount = 0 },
		func(value *Manifest) { value.EntryArgs = []string{"bad\x00argument"} },
		func(value *Manifest) { value.CriticalFiles = nil },
	}
	for index, mutate := range mutations {
		manifest := validRuntimeManifest()
		mutate(&manifest)
		if err := ValidateManifest(manifest); !errors.Is(err, ErrManifestInvalid) {
			t.Fatalf("mutation %d returned %v", index, err)
		}
	}
}

func TestValidateManifestRejectsLauncherOwnedStartupModeArguments(t *testing.T) {
	for _, argument := range []string{
		"--uclaw-startup-mode",
		"--uclaw-startup-mode=activation-only",
		"--uclaw-startup-mode=normal",
		"--uclaw-startup-mode-shadow",
	} {
		manifest := validRuntimeManifest()
		manifest.EntryArgs = []string{"resources/app.asar", argument}
		if err := ValidateManifest(manifest); !errors.Is(err, ErrManifestInvalid) {
			t.Fatalf("argument %q returned %v", argument, err)
		}
	}
}

func TestReadManifestIsStrict(t *testing.T) {
	directory := t.TempDir()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	trustRuntimeTestKey(t, "fixture", public)
	manifest := validRuntimeManifest()
	manifest.RuntimeID = "openclaw-win-x64"
	manifest.RuntimeBytes = 1
	manifest.UnpackedBytes = 1
	manifest.FileCount = 1
	manifest.Entrypoint = "electron.exe"
	manifest.EntryArgs = []string{}
	manifest.CriticalFiles = []RuntimeFileDigest{{Path: "electron.exe", Size: 1, SHA256: strings.Repeat("c", 64)}}
	manifest = signedRuntimeManifest(t, manifest, "fixture", private, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), 7)
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	valid := string(encoded)
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

func TestReadManifestSignatureFailsClosed(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	wrongPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tests := []struct {
		name    string
		build   func(*testing.T) Manifest
		keys    map[string]string
		revoked string
	}{
		{"valid", func(t *testing.T) Manifest {
			return signedRuntimeManifest(t, validRuntimeManifest(), "fixture", private, now.Add(-time.Minute), now.Add(time.Hour), 8)
		}, map[string]string{"fixture": base64.StdEncoding.EncodeToString(public)}, "[]"},
		{"tampered", func(t *testing.T) Manifest {
			value := signedRuntimeManifest(t, validRuntimeManifest(), "fixture", private, now.Add(-time.Minute), now.Add(time.Hour), 8)
			value.RuntimeID = "tampered-win-x64"
			return value
		}, map[string]string{"fixture": base64.StdEncoding.EncodeToString(public)}, "[]"},
		{"wrong-key", func(t *testing.T) Manifest {
			return signedRuntimeManifest(t, validRuntimeManifest(), "fixture", private, now.Add(-time.Minute), now.Add(time.Hour), 8)
		}, map[string]string{"fixture": base64.StdEncoding.EncodeToString(wrongPublic)}, "[]"},
		{"expired", func(t *testing.T) Manifest {
			return signedRuntimeManifest(t, validRuntimeManifest(), "fixture", private, now.Add(-time.Hour), now.Add(-time.Minute), 8)
		}, map[string]string{"fixture": base64.StdEncoding.EncodeToString(public)}, "[]"},
		{"revoked", func(t *testing.T) Manifest {
			return signedRuntimeManifest(t, validRuntimeManifest(), "fixture", private, now.Add(-time.Minute), now.Add(time.Hour), 8)
		}, map[string]string{"fixture": base64.StdEncoding.EncodeToString(public)}, `["fixture"]`},
		{"tampered-key-id", func(t *testing.T) Manifest {
			value := signedRuntimeManifest(t, validRuntimeManifest(), "fixture", private, now.Add(-time.Minute), now.Add(time.Hour), 8)
			value.Signature.KeyID = "other"
			return value
		}, map[string]string{
			"fixture": base64.StdEncoding.EncodeToString(public),
			"other":   base64.StdEncoding.EncodeToString(public),
		}, "[]"},
		{"tampered-expiry", func(t *testing.T) Manifest {
			value := signedRuntimeManifest(t, validRuntimeManifest(), "fixture", private, now.Add(-time.Minute), now.Add(time.Hour), 8)
			value.Signature.ExpiresAt = now.Add(2 * time.Hour).UTC().Format(time.RFC3339)
			return value
		}, map[string]string{"fixture": base64.StdEncoding.EncodeToString(public)}, "[]"},
		{"tampered-sequence", func(t *testing.T) Manifest {
			value := signedRuntimeManifest(t, validRuntimeManifest(), "fixture", private, now.Add(-time.Minute), now.Add(time.Hour), 8)
			value.Signature.Sequence = 9
			return value
		}, map[string]string{"fixture": base64.StdEncoding.EncodeToString(public)}, "[]"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encodedKeys, _ := json.Marshal(test.keys)
			previousKeys, previousRevoked := trustedRuntimeKeys, revokedRuntimeKeyIDs
			trustedRuntimeKeys, revokedRuntimeKeyIDs = string(encodedKeys), test.revoked
			defer func() { trustedRuntimeKeys, revokedRuntimeKeyIDs = previousKeys, previousRevoked }()
			directory := t.TempDir()
			encoded, _ := json.Marshal(test.build(t))
			path := filepath.Join(directory, "version.json")
			if os.WriteFile(path, encoded, 0o600) != nil {
				t.Fatal("write")
			}
			_, readErr := ReadManifest(path)
			if test.name == "valid" && readErr != nil {
				t.Fatalf("valid signature rejected: %v", readErr)
			}
			if test.name != "valid" && !errors.Is(readErr, ErrManifestInvalid) {
				t.Fatalf("expected fail closed, got %v", readErr)
			}
		})
	}
}

func TestManifestSigningPayloadMatchesJavaScriptGolden(t *testing.T) {
	manifest := validRuntimeManifest()
	manifest.ProductVersion = "0.1.0<>&\u2028"
	manifest.RuntimeID = "openclaw-test"
	manifest.RuntimeBytes = 7
	manifest.UnpackedBytes = 9
	manifest.FileCount = 1
	manifest.Entrypoint = "electron/electron.exe"
	manifest.EntryArgs = []string{"<arg>", "line\u2029end"}
	manifest.CriticalFiles = []RuntimeFileDigest{{Path: "electron/electron.exe", Size: 8, SHA256: strings.Repeat("c", 64)}}
	manifest.Signature = &ManifestSignature{
		Algorithm: "ed25519", KeyID: "fixture",
		SignedAt: "2026-08-09T00:00:00.000Z", ExpiresAt: "2027-08-09T00:00:00.000Z",
		Sequence: 42,
	}
	payload, err := manifestSigningPayload(manifest)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	if hex.EncodeToString(digest[:]) != "1d5df2ef301f1e28f55707eaa8a427e3308c2ce8d7a124cfbaac5389db4e9a77" {
		t.Fatalf("payload digest mismatch: %s", hex.EncodeToString(digest[:]))
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

func TestValidatePackageRejectsHardlink(t *testing.T) {
	directory := t.TempDir()
	payload := []byte("runtime")
	outside := filepath.Join(t.TempDir(), "outside.pkg")
	if err := os.WriteFile(outside, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(directory, "runtime.pkg")); err != nil {
		t.Skipf("hardlink unavailable: %v", err)
	}
	digest := sha256.Sum256(payload)
	manifest := validRuntimeManifest()
	manifest.RuntimeBytes = int64(len(payload))
	manifest.RuntimeSHA256 = hex.EncodeToString(digest[:])
	if err := ValidatePackage(directory, manifest); !errors.Is(err, ErrPackageInvalid) {
		t.Fatalf("hardlink returned %v", err)
	}
}
