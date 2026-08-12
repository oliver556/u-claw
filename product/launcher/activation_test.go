package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
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
