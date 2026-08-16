package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestDetectActivationStateClassifiesLicenseArtifacts(t *testing.T) {
	tests := []struct {
		name            string
		writeCredential bool
		writeLicense    bool
		want            ActivationState
	}{
		{name: "both missing", want: ActivationRequired},
		{name: "credential only", writeCredential: true, want: LicenseLocalInvalid},
		{name: "license only", writeLicense: true, want: LicenseLocalInvalid},
		{name: "both present", writeCredential: true, writeLicense: true, want: LicenseGateRequired},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			packageRoot := t.TempDir()
			licenseDir := filepath.Join(packageRoot, "license")
			if test.writeCredential || test.writeLicense {
				if err := os.Mkdir(licenseDir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if test.writeCredential {
				if err := os.WriteFile(filepath.Join(licenseDir, startupCredentialFilename), []byte("invalid credential"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if test.writeLicense {
				if err := os.WriteFile(filepath.Join(licenseDir, licenseFilename), []byte("invalid license"), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			got, err := DetectActivationState(packageRoot)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("state = %q, want %q", got, test.want)
			}
		})
	}
}

func TestDetectActivationStateRejectsUnsafeLicenseDirectory(t *testing.T) {
	packageRoot := t.TempDir()
	if err := os.Symlink(t.TempDir(), filepath.Join(packageRoot, "license")); err != nil {
		t.Fatal(err)
	}

	state, err := DetectActivationState(packageRoot)
	if state != LicenseLocalInvalid || !errors.Is(err, ErrLicenseFileUnsafe) {
		t.Fatalf("state = %q, err = %v", state, err)
	}
}

func TestActivationArtifactsEnableNormalWorkspaceHarness(t *testing.T) {
	packageRoot := os.Getenv("UCLAW_ACTIVATION_HARNESS_PACKAGE_ROOT")
	if packageRoot == "" {
		t.Skip("integration harness only")
	}
	state, err := DetectActivationState(packageRoot)
	if err != nil || state != LicenseGateRequired {
		t.Fatalf("activation state = %q, err = %v", state, err)
	}
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.Paths.PackageRoot = packageRoot
	deps.Paths.DataDir = filepath.Join(packageRoot, "data")
	deps.ProbeDataDirectory = func(packageRootArg, dataDirArg string) error {
		if packageRootArg != packageRoot || dataDirArg != filepath.Join(packageRoot, "data") {
			t.Fatalf("probe paths = %q, %q", packageRootArg, dataDirArg)
		}
		return nil
	}
	deps.AcquireInstanceLock = func(dataDirArg string) (InstanceLock, error) {
		if dataDirArg != filepath.Join(packageRoot, "data") {
			t.Fatalf("lock path = %q", dataDirArg)
		}
		return &fakeInstanceLock{}, nil
	}
	deps.DetectActivationState = DetectActivationState
	publicKey, err := base64.StdEncoding.DecodeString(os.Getenv("UCLAW_ACTIVATION_HARNESS_PUBLIC_KEY"))
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		t.Fatal("integration harness public key is invalid")
	}
	now, err := time.Parse(time.RFC3339, "2026-08-13T12:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	deps.VerifyLicense = func(root, usbRoot string) error {
		return VerifyStartupLicense(licenseVerificationOptions{
			PackageRoot: root,
			USBRoot:     usbRoot,
			Now:         func() time.Time { return now },
			ReadFingerprint: func(string) (usbFingerprint, error) {
				return usbFingerprint{Scheme: "uclaw-usb-v1", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, nil
			},
			TrustedPublicKeys: map[string]ed25519.PublicKey{"activation-key": publicKey},
		})
	}
	deps.ReadManifest = func(path string) (Manifest, error) {
		if path != filepath.Join(packageRoot, "version.json") {
			t.Fatalf("manifest path = %q", path)
		}
		manifest := validRuntimeManifest()
		manifest.Entrypoint = `electron\electron.exe`
		return manifest, nil
	}
	deps.PrepareRuntime = func(_ context.Context, _ string, packageRootArg string, manifest Manifest, extracting func()) (CacheResult, error) {
		if packageRootArg != packageRoot {
			t.Fatalf("runtime package root = %q", packageRootArg)
		}
		extracting()
		return CacheResult{Path: filepath.Join(deps.Paths.CacheRoot, manifest.RuntimeID)}, nil
	}
	deps.FinalizeUpdate = func(packageRootArg string, _ Manifest) error {
		if packageRootArg != packageRoot {
			t.Fatalf("update package root = %q", packageRootArg)
		}
		return nil
	}
	deps.StartProcess = func(spec ProcessSpec) (ChildProcess, error) {
		if !slices.Contains(spec.Args, normalStartupArgument) || slices.Contains(spec.Args, activationStartupArgument) {
			t.Fatalf("normal workspace args = %v", spec.Args)
		}
		t.Log("NORMAL_WORKSPACE_VISIBLE")
		return &fakeChildProcess{}, nil
	}
	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
}
