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
	operatorsFile := writeTestFile(t, directory, "admin-operators.json", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`))
	values := map[string]string{
		"DATABASE_URL":                      " postgres://database.example/uclaw ",
		"ACTIVATION_PEPPER_FILE":            pepperFile,
		"LICENSE_SIGNING_KEY_FILE":          keyFile,
		"STATUS_SIGNING_KEY_FILE":           keyFile,
		"LICENSE_KEY_ID":                    "license-key-001",
		"STATUS_KEY_ID":                     "status-key-001",
		"KMS_PROVIDER":                      "external-kms",
		"KMS_KEY_VERSION":                   "kms-v1",
		"KMS_KEK_FILE":                      kekFile,
		"ADMIN_OPERATORS_FILE":              operatorsFile,
		"ADMIN_SECRET_FINGERPRINT_KEY_FILE": writeTestFile(t, directory, "fingerprint-key", []byte(strings.Repeat("f", 32))),
		"NEW_API_ALLOWED_HOSTS":             "api.example.test",
		"PUBLIC_MODEL_ENDPOINT":             "https://activation.example/model-api/",
		"LISTEN_ADDRESS":                    " 127.0.0.1:8080 ",
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
	if got.PublicModelEndpoint != "https://activation.example/model-api/" {
		t.Fatalf("public model endpoint=%q", got.PublicModelEndpoint)
	}
	if got.AdminOperatorsFile != operatorsFile || len(got.AdminOperators) != 1 {
		t.Fatal("admin operators were not loaded")
	}
}

func TestLoadFromRequiresEveryConfigurationNameWithoutLeakingValues(t *testing.T) {
	directory := t.TempDir()
	values := map[string]string{
		"DATABASE_URL":                      "postgres://secret-user:secret-password@database/uclaw",
		"ACTIVATION_PEPPER_FILE":            writeTestFile(t, directory, "required-pepper", []byte(strings.Repeat("p", 32))),
		"LICENSE_SIGNING_KEY_FILE":          writeSigningKey(t, directory),
		"STATUS_SIGNING_KEY_FILE":           writeSigningKey(t, directory),
		"LICENSE_KEY_ID":                    "license-key-001",
		"STATUS_KEY_ID":                     "status-key-001",
		"KMS_PROVIDER":                      "external-kms",
		"KMS_KEY_VERSION":                   "kms-v1",
		"KMS_KEK_FILE":                      writeTestFile(t, directory, "required-kek", []byte(strings.Repeat("k", 32))),
		"ADMIN_OPERATORS_FILE":              writeTestFile(t, directory, "required-admin-operators", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`)),
		"ADMIN_SECRET_FINGERPRINT_KEY_FILE": writeTestFile(t, directory, "required-fingerprint-key", []byte(strings.Repeat("f", 32))),
		"NEW_API_ALLOWED_HOSTS":             "api.example.test",
		"PUBLIC_MODEL_ENDPOINT":             "https://activation.example/model-api/",
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

func TestValidPublicModelEndpointMatchesSafeProxyContract(t *testing.T) {
	for _, endpoint := range []string{
		"https://activation.example/model-api/",
		"https://192.0.2.10/model-api/",
	} {
		if !validPublicModelEndpoint(endpoint) {
			t.Fatalf("valid endpoint rejected: %q", endpoint)
		}
	}
	for _, endpoint := range []string{
		"https://activation.example/model-api%2F",
		"https://activation.example/model-api/?",
		"https://activation.example/model-api/#",
	} {
		if validPublicModelEndpoint(endpoint) {
			t.Fatalf("unsafe endpoint accepted: %q", endpoint)
		}
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
				"DATABASE_URL":                      "postgres://secret-user:secret-password@database/uclaw",
				"ACTIVATION_PEPPER_FILE":            test.pepperFile,
				"LICENSE_SIGNING_KEY_FILE":          test.keyFile,
				"STATUS_SIGNING_KEY_FILE":           validKey,
				"LICENSE_KEY_ID":                    "license-key-001",
				"STATUS_KEY_ID":                     "status-key-001",
				"KMS_PROVIDER":                      "external-kms",
				"KMS_KEY_VERSION":                   "kms-v1",
				"KMS_KEK_FILE":                      writeTestFile(t, directory, "valid-kek", []byte(strings.Repeat("k", 32))),
				"ADMIN_OPERATORS_FILE":              writeTestFile(t, directory, "valid-admin-operators", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`)),
				"ADMIN_SECRET_FINGERPRINT_KEY_FILE": writeTestFile(t, directory, "valid-fingerprint-key", []byte(strings.Repeat("f", 32))),
				"NEW_API_ALLOWED_HOSTS":             "api.example.test",
				"PUBLIC_MODEL_ENDPOINT":             "https://activation.example/model-api/",
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
		"DATABASE_URL":                      "postgres://database/uclaw",
		"ACTIVATION_PEPPER_FILE":            writeTestFile(t, directory, "pepper", []byte(strings.Repeat("p", 32))),
		"LICENSE_SIGNING_KEY_FILE":          keyFile,
		"STATUS_SIGNING_KEY_FILE":           keyFile,
		"LICENSE_KEY_ID":                    "license-key-001",
		"STATUS_KEY_ID":                     "status-key-001",
		"KMS_PROVIDER":                      "local-kek-v1",
		"KMS_KEY_VERSION":                   "kms-v1",
		"ADMIN_OPERATORS_FILE":              writeTestFile(t, directory, "admin-operators", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`)),
		"ADMIN_SECRET_FINGERPRINT_KEY_FILE": writeTestFile(t, directory, "fingerprint-key-base", []byte(strings.Repeat("f", 32))),
		"NEW_API_ALLOWED_HOSTS":             "api.example.test",
		"PUBLIC_MODEL_ENDPOINT":             "https://activation.example/model-api/",
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

func TestReadRegularFileRejectsHardlink(t *testing.T) {
	directory := t.TempDir()
	target := writeTestFile(t, directory, "target-hardlink", []byte(strings.Repeat("h", 32)))
	link := filepath.Join(directory, "secret-hardlink")
	if err := os.Link(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readRegularFile(link, 32, maximumPepperBytes); err == nil {
		t.Fatal("hardlinked secret file accepted")
	}
}

func TestParseAllowedNewAPIHostsRejectsUnsafeOrNonCanonicalValues(t *testing.T) {
	hosts, err := parseAllowedNewAPIHosts("api.example.test,models.example.test")
	if err != nil || len(hosts) != 2 || hosts[0] != "api.example.test" {
		t.Fatalf("hosts=%v err=%v", hosts, err)
	}
	for _, value := range []string{"", "localhost", "127.0.0.1", "10.0.0.1", "[::1]", "API.Example.Test", "api.example.test:443", "*.example.test", "api.example.test,api.example.test"} {
		if _, err = parseAllowedNewAPIHosts(value); err == nil {
			t.Fatalf("unsafe allowlist accepted: %q", value)
		}
	}
}

func TestLoadFromRequiresIndependentAdminFingerprintSecret(t *testing.T) {
	directory := t.TempDir()
	signing := writeSigningKey(t, directory)
	pepper := writeTestFile(t, directory, "separate-pepper", []byte(strings.Repeat("p", 32)))
	kek := writeTestFile(t, directory, "separate-kek", []byte(strings.Repeat("k", 32)))
	fingerprint := writeTestFile(t, directory, "separate-fingerprint", []byte(strings.Repeat("f", 32)))
	base := map[string]string{"DATABASE_URL": "postgres://database/uclaw", "ACTIVATION_PEPPER_FILE": pepper, "LICENSE_SIGNING_KEY_FILE": signing, "STATUS_SIGNING_KEY_FILE": signing, "LICENSE_KEY_ID": "license-key-001", "STATUS_KEY_ID": "status-key-001", "KMS_PROVIDER": "local-kek-v1", "KMS_KEY_VERSION": "kms-v1", "KMS_KEK_FILE": kek, "ADMIN_OPERATORS_FILE": writeTestFile(t, directory, "separate-operators", []byte(`{"operator_fixture":"`+strings.Repeat("1", 64)+`"}`)), "ADMIN_SECRET_FINGERPRINT_KEY_FILE": fingerprint, "NEW_API_ALLOWED_HOSTS": "api.example.test", "PUBLIC_MODEL_ENDPOINT": "https://activation.example/model-api/"}
	if _, err := LoadFrom(func(name string) string { return base[name] }); err != nil {
		t.Fatalf("independent secret rejected: %v", err)
	}
	for _, test := range []struct{ name, path string }{{"same path pepper", pepper}, {"same bytes pepper", writeTestFile(t, directory, "fingerprint-equals-pepper", []byte(strings.Repeat("p", 32)))}, {"same bytes kek", writeTestFile(t, directory, "fingerprint-equals-kek", []byte(strings.Repeat("k", 32)))}} {
		t.Run(test.name, func(t *testing.T) {
			values := maps.Clone(base)
			values["ADMIN_SECRET_FINGERPRINT_KEY_FILE"] = test.path
			_, err := LoadFrom(func(name string) string { return values[name] })
			if err == nil || !strings.Contains(err.Error(), "ADMIN_SECRET_FINGERPRINT_KEY_FILE") {
				t.Fatalf("error=%v", err)
			}
			for _, sensitive := range []string{test.path, string([]byte(strings.Repeat("p", 32))), string([]byte(strings.Repeat("k", 32)))} {
				if strings.Contains(err.Error(), sensitive) {
					t.Fatalf("error leaked secret/path: %v", err)
				}
			}
		})
	}
}

func TestProductionExamplesUsePublicModelEndpointAndIsolatedGateways(t *testing.T) {
	environment, err := os.ReadFile(filepath.Join("..", "..", "deploy", "config.example.env"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(environment), "PUBLIC_MODEL_ENDPOINT=https://license.yiyong.me/model-api/") {
		t.Fatal("production example does not advertise the public model endpoint")
	}

	contents, err := os.ReadFile(filepath.Join("..", "..", "deploy", "compose.production.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	compose := string(contents)
	for _, required := range []string{
		"caddy-edge:",
		"license.yiyong.me",
		"121.41.89.103",
		"handle /model-api/*",
		"handle /v1/*",
		"handle /health/ready",
		"handle /internal/*",
		"handle /metrics",
		"127.0.0.1:8444:8444",
		`{"username", body.username, 30}`,
		`{"usb", body.usbFingerprint.sha256, 30}`,
	} {
		if !strings.Contains(compose, required) {
			t.Errorf("production compose missing %q", required)
		}
	}
	if strings.Contains(compose, `- "443:8443"`) {
		t.Fatal("OpenResty public gateway must not publish TLS directly")
	}
}

func TestProductionEdgeAuthenticatesTrustedProxyHopWithDedicatedMTLS(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "deploy", "compose.production.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	compose := string(contents)
	for _, required := range []string{
		"EDGE_UPSTREAM_SERVER_CERTIFICATE_FILE",
		"EDGE_UPSTREAM_SERVER_PRIVATE_KEY_FILE",
		"EDGE_UPSTREAM_CLIENT_CERTIFICATE_FILE",
		"EDGE_UPSTREAM_CLIENT_PRIVATE_KEY_FILE",
		"EDGE_UPSTREAM_CLIENT_CA_FILE",
		"EDGE_UPSTREAM_SERVER_CA_FILE",
		"ssl_verify_client on",
		`if ($$ssl_client_verify != SUCCESS) { return 403; }`,
		"ssl_client_certificate /run/secrets/edge_upstream_client_ca",
		"tls_server_name public-gateway",
		"tls_client_auth /run/secrets/edge_upstream_client_certificate /run/secrets/edge_upstream_client_private_key",
		"tls_trusted_ca_certs /run/secrets/edge_upstream_server_ca",
		"https://public-gateway:8443",
	} {
		if !strings.Contains(compose, required) {
			t.Errorf("production edge mTLS config missing %q", required)
		}
	}
	if strings.Contains(compose, "tls_insecure_skip_verify") {
		t.Fatal("production edge disables upstream TLS verification")
	}
	for _, source := range []string{"edge_upstream_server_certificate", "edge_upstream_server_private_key", "edge_upstream_client_certificate", "edge_upstream_client_private_key", "edge_upstream_client_ca", "edge_upstream_server_ca"} {
		fragment := "source: " + source + ", target: /run/secrets/" + source + ", uid: \"0\", gid: \"0\", mode: 0400"
		if !strings.Contains(compose, fragment) {
			t.Errorf("edge mTLS secret not owner-read-only: %s", source)
		}
	}
}

func TestProductionGatewayStartupAndReadinessAreExecutable(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "deploy", "compose.production.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	compose := string(contents)
	publicConfig := composeSection(t, compose, "  public_gateway:\n", "  caddy_edge:\n")
	if strings.Contains(publicConfig, " resolve;") {
		t.Fatal("OpenResty upstream uses unsupported runtime resolve parameter")
	}
	if !strings.Contains(publicConfig, "client_body_temp_path /tmp/client_body_temp 1 2;") {
		t.Fatal("OpenResty request bodies do not use writable tmpfs")
	}

	activationAnchor := composeSection(t, compose, "x-activation-app:", "\nservices:")
	for _, required := range []string{`test: ["CMD", "/activation-server", "--healthcheck"]`, "interval: 10s", "timeout: 3s"} {
		if !strings.Contains(activationAnchor, required) {
			t.Errorf("activation healthcheck missing %q", required)
		}
	}
	publicService := composeSection(t, compose, "  public-gateway:\n", "\n  # Caddy obtains")
	for _, required := range []string{"condition: service_healthy", `test: ["CMD-SHELL", "openresty -t && kill -0 1"]`} {
		if !strings.Contains(publicService, required) {
			t.Errorf("public gateway readiness missing %q", required)
		}
	}
	caddyService := composeSection(t, compose, "  caddy-edge:\n", "\n  # Loopback binding")
	if !strings.Contains(caddyService, "condition: service_healthy") {
		t.Fatal("Caddy does not wait for healthy public gateway")
	}
}

func composeSection(t *testing.T, source, start, end string) string {
	t.Helper()
	startAt := strings.Index(source, start)
	if startAt < 0 {
		t.Fatalf("compose section start missing %q", start)
	}
	endAt := strings.Index(source[startAt+len(start):], end)
	if endAt < 0 {
		t.Fatalf("compose section end missing %q", end)
	}
	return source[startAt : startAt+len(start)+endAt]
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
