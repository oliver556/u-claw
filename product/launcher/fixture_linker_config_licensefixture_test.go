//go:build licensefixture

package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDecodeFixtureLinkerConfig(t *testing.T) {
	raw := `{"test-key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	encoded := "base64:" + base64.StdEncoding.EncodeToString([]byte(raw))
	if got := decodeFixtureLinkerConfig(encoded); got != raw {
		t.Fatalf("decoded fixture linker config mismatch")
	}
}

func TestFixtureLinkedTrustConfiguration(t *testing.T) {
	if os.Getenv("UCLAW_TEST_LINKED_TRUST_CONFIG") != "1" {
		t.Skip("linker integration only")
	}
	for name, encoded := range map[string]string{
		"runtime":         trustedRuntimeKeys,
		"startup-license": trustedStartupLicenseKeys,
		"status-license":  trustedLicenseStatusKeys,
	} {
		if _, err := parseTrustedStartupLicenseKeys(encoded); err != nil {
			t.Fatalf(
				"%s fixture trust configuration is invalid (bytes=%d, prefixed=%t, json=%t)",
				name,
				len(encoded),
				strings.HasPrefix(encoded, fixtureLinkerConfigPrefix),
				json.Valid([]byte(encoded)),
			)
		}
	}
}
