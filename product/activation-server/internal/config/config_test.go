package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadFromPreservesConfigurationValues(t *testing.T) {
	directory := t.TempDir()
	pepperFile := writeTestFile(t, directory, "pepper", []byte(strings.Repeat("p", 32)))
	keyFile := writeSigningKey(t, directory)
	kekFile := writeTestFile(t, directory, "kek", []byte(strings.Repeat("k", 32)))
	tokenKeyFile := writeTestFile(t, directory, "token-key", []byte(strings.Repeat("t", 32)))
	operatorsFile := writeTestFile(t, directory, "admin-operators.json", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`))
	values := map[string]string{
		"DATABASE_URL":             " postgres://database.example/uclaw ",
		"ACTIVATION_PEPPER_FILE":   pepperFile,
		"LICENSE_SIGNING_KEY_FILE": keyFile,
		"STATUS_SIGNING_KEY_FILE":  keyFile,
		"LICENSE_KEY_ID":           "license-key-001",
		"STATUS_KEY_ID":            "status-key-001",
		"KMS_PROVIDER":             "external-kms",
		"KMS_KEY_VERSION":          "kms-v1",
		"KMS_KEK_FILE":             kekFile,
		"TOKEN_SIGNING_KEY_FILE":   tokenKeyFile,
		"ADMIN_OPERATORS_FILE":     operatorsFile,
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
	if got.KMSKEKFile != kekFile || string(got.KMSKEK) != strings.Repeat("k", 32) {
		t.Fatal("KEK file was not loaded")
	}
	if got.TokenSigningKeyFile != tokenKeyFile || string(got.TokenSigningKey) != strings.Repeat("t", 32) {
		t.Fatal("token signing key was not loaded")
	}
	if got.AdminOperatorsFile != operatorsFile || len(got.AdminOperators) != 1 {
		t.Fatal("admin operators were not loaded")
	}
}

func TestLoadFromRequiresEveryConfigurationNameWithoutLeakingValues(t *testing.T) {
	directory := t.TempDir()
	values := map[string]string{
		"DATABASE_URL":             "postgres://secret-user:secret-password@database/uclaw",
		"ACTIVATION_PEPPER_FILE":   writeTestFile(t, directory, "required-pepper", []byte(strings.Repeat("p", 32))),
		"LICENSE_SIGNING_KEY_FILE": writeSigningKey(t, directory),
		"STATUS_SIGNING_KEY_FILE":  writeSigningKey(t, directory),
		"LICENSE_KEY_ID":           "license-key-001",
		"STATUS_KEY_ID":            "status-key-001",
		"KMS_PROVIDER":             "external-kms",
		"KMS_KEY_VERSION":          "kms-v1",
		"KMS_KEK_FILE":             writeTestFile(t, directory, "required-kek", []byte(strings.Repeat("k", 32))),
		"TOKEN_SIGNING_KEY_FILE":   writeTestFile(t, directory, "required-token-key", []byte(strings.Repeat("t", 32))),
		"ADMIN_OPERATORS_FILE":     writeTestFile(t, directory, "required-admin-operators", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`)),
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
				"STATUS_SIGNING_KEY_FILE":  validKey,
				"LICENSE_KEY_ID":           "license-key-001",
				"STATUS_KEY_ID":            "status-key-001",
				"KMS_PROVIDER":             "external-kms",
				"KMS_KEY_VERSION":          "kms-v1",
				"KMS_KEK_FILE":             writeTestFile(t, directory, "valid-kek", []byte(strings.Repeat("k", 32))),
				"TOKEN_SIGNING_KEY_FILE":   writeTestFile(t, directory, "valid-token-key", []byte(strings.Repeat("t", 32))),
				"ADMIN_OPERATORS_FILE":     writeTestFile(t, directory, "valid-admin-operators", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`)),
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

func TestLoadFromAcceptsOnlyExplicitKEKFormats(t *testing.T) {
	directory := t.TempDir()
	keyFile := writeSigningKey(t, directory)
	baseValues := map[string]string{
		"DATABASE_URL":             "postgres://database/uclaw",
		"ACTIVATION_PEPPER_FILE":   writeTestFile(t, directory, "pepper", []byte(strings.Repeat("p", 32))),
		"LICENSE_SIGNING_KEY_FILE": keyFile,
		"STATUS_SIGNING_KEY_FILE":  keyFile,
		"LICENSE_KEY_ID":           "license-key-001",
		"STATUS_KEY_ID":            "status-key-001",
		"KMS_PROVIDER":             "local-kek-v1",
		"KMS_KEY_VERSION":          "kms-v1",
		"TOKEN_SIGNING_KEY_FILE":   writeTestFile(t, directory, "token-key", []byte(strings.Repeat("t", 32))),
		"ADMIN_OPERATORS_FILE":     writeTestFile(t, directory, "admin-operators", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`)),
	}
	for name, contents := range map[string][]byte{
		"raw":    []byte(strings.Repeat("r", 32)),
		"base64": []byte("base64:" + base64.RawStdEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))),
	} {
		t.Run(name, func(t *testing.T) {
			values := maps.Clone(baseValues)
			values["KMS_KEK_FILE"] = writeTestFile(t, directory, "kek-"+name, contents)
			if _, err := LoadFrom(func(key string) string { return values[key] }); err != nil {
				t.Fatal(err)
			}
		})
	}
	for name, contents := range map[string][]byte{
		"implicit base64": []byte(base64.RawStdEncoding.EncodeToString([]byte(strings.Repeat("x", 32)))),
		"short raw":       []byte(strings.Repeat("x", 31)),
	} {
		t.Run(name, func(t *testing.T) {
			values := maps.Clone(baseValues)
			values["KMS_KEK_FILE"] = writeTestFile(t, directory, "bad-kek-"+name, contents)
			if _, err := LoadFrom(func(key string) string { return values[key] }); err == nil || !strings.Contains(err.Error(), "KMS_KEK_FILE") {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestLoadAdminOperatorsRejectsDuplicateCredentialDigest(t *testing.T) {
	directory := t.TempDir()
	digest := strings.Repeat("a", 64)
	path := writeTestFile(t, directory, "duplicate-operators.json", []byte(`{"operator_one":"`+digest+`","operator_two":"`+digest+`"}`))
	if _, err := loadAdminOperators(path); err == nil {
		t.Fatal("duplicate credential digest accepted")
	}
}

func TestReadRegularFileRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := writeTestFile(t, directory, "target", []byte(strings.Repeat("s", 32)))
	path := filepath.Join(directory, "secret-link")
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}

	if _, err := readRegularFile(path, 32, maximumPepperBytes); err == nil {
		t.Fatal("symlink secret file accepted")
	}
}

func TestReadRegularFileRequiresOwnerOnlyPermissions(t *testing.T) {
	for _, test := range []struct {
		mode    os.FileMode
		wantErr bool
	}{
		{mode: 0o400},
		{mode: 0o600},
		{mode: 0o644, wantErr: true},
		{mode: 0o660, wantErr: true},
	} {
		t.Run(test.mode.String(), func(t *testing.T) {
			path := writeTestFile(t, t.TempDir(), "secret", []byte(strings.Repeat("s", 32)))
			if err := os.Chmod(path, test.mode); err != nil {
				t.Fatal(err)
			}

			_, err := readRegularFile(path, 32, maximumPepperBytes)
			if (err != nil) != test.wantErr {
				t.Fatalf("readRegularFile() error = %v, wantErr %t", err, test.wantErr)
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
