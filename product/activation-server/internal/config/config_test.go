package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadFromPreservesConfigurationValues(t *testing.T) {
	directory := t.TempDir()
	pepperFile := writeTestFile(t, directory, "pepper", []byte(strings.Repeat("p", 32)))
	keyFile := writeSigningKey(t, directory)
	values := map[string]string{
		"DATABASE_URL":             " postgres://database.example/uclaw ",
		"ACTIVATION_PEPPER_FILE":   pepperFile,
		"LICENSE_SIGNING_KEY_FILE": keyFile,
		"LISTEN_ADDRESS":           " 127.0.0.1:8080 ",
	}

	got, err := LoadFrom(func(name string) string { return values[name] })
	if err != nil {
		t.Fatal(err)
	}
	if got.DatabaseURL != values["DATABASE_URL"] {
		t.Fatalf("DatabaseURL = %q, want original value %q", got.DatabaseURL, values["DATABASE_URL"])
	}
	if got.ActivationPepperFile != pepperFile || got.LicenseSigningKeyFile != keyFile {
		t.Fatal("secret file paths were not preserved")
	}
	if got.ListenAddress != values["LISTEN_ADDRESS"] {
		t.Fatalf("ListenAddress = %q, want original value %q", got.ListenAddress, values["LISTEN_ADDRESS"])
	}
	if len(got.ActivationPepper) != 32 {
		t.Fatalf("pepper length = %d, want 32", len(got.ActivationPepper))
	}
	if len(got.LicenseSigningKey) != ed25519.PrivateKeySize {
		t.Fatalf("signing key length = %d, want %d", len(got.LicenseSigningKey), ed25519.PrivateKeySize)
	}
}

func TestLoadFromRequiresEveryConfigurationNameWithoutLeakingValues(t *testing.T) {
	directory := t.TempDir()
	values := map[string]string{
		"DATABASE_URL":             "postgres://secret-user:secret-password@database/uclaw",
		"ACTIVATION_PEPPER_FILE":   writeTestFile(t, directory, "required-pepper", []byte(strings.Repeat("p", 32))),
		"LICENSE_SIGNING_KEY_FILE": writeSigningKey(t, directory),
	}

	for _, missingName := range requiredVariables {
		t.Run(missingName, func(t *testing.T) {
			_, err := LoadFrom(func(name string) string {
				if name == missingName {
					return " \t "
				}
				return values[name]
			})
			if err == nil || !strings.Contains(err.Error(), missingName) {
				t.Fatalf("error = %v, want missing configuration name", err)
			}
			for _, secret := range values {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("error leaks configuration value: %q", err)
				}
			}
		})
	}
}

func TestLoadFromRejectsInvalidSecretFilesWithoutLeakingValues(t *testing.T) {
	directory := t.TempDir()
	validPepper := writeTestFile(t, directory, "pepper", []byte(strings.Repeat("p", 32)))
	validKey := writeSigningKey(t, directory)

	tests := []struct {
		name       string
		pepperFile string
		keyFile    string
		wantName   string
	}{
		{name: "pepper is directory", pepperFile: directory, keyFile: validKey, wantName: "ACTIVATION_PEPPER_FILE"},
		{name: "pepper is short", pepperFile: writeTestFile(t, directory, "short-pepper", []byte("short")), keyFile: validKey, wantName: "ACTIVATION_PEPPER_FILE"},
		{name: "key is malformed", pepperFile: validPepper, keyFile: writeTestFile(t, directory, "bad-key", []byte("not-base64")), wantName: "LICENSE_SIGNING_KEY_FILE"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values := map[string]string{
				"DATABASE_URL":             "postgres://secret-user:secret-password@database/uclaw",
				"ACTIVATION_PEPPER_FILE":   test.pepperFile,
				"LICENSE_SIGNING_KEY_FILE": test.keyFile,
			}
			_, err := LoadFrom(func(name string) string { return values[name] })
			if err == nil {
				t.Fatal("LoadFrom() error = nil")
			}
			if !strings.Contains(err.Error(), test.wantName) {
				t.Fatalf("error = %q, want configuration name", err)
			}
			for _, secret := range values {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("error leaks configuration value: %q", err)
				}
			}
		})
	}
}

func writeSigningKey(t *testing.T, directory string) string {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return writeTestFile(t, directory, "signing-key", []byte(base64.RawStdEncoding.EncodeToString(privateKey)))
}

func writeTestFile(t *testing.T, directory string, name string, contents []byte) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
