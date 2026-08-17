package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDecodeLinkerConfig(t *testing.T) {
	raw := `{"test-key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	encoded := "base64:" + base64.StdEncoding.EncodeToString([]byte(raw))
	if got := decodeLinkerConfig(encoded); got != raw {
		t.Fatalf("decoded linker config mismatch")
	}
	if got := decodeLinkerConfig(raw); got != raw {
		t.Fatalf("raw JSON linker config lost backward compatibility")
	}
	for _, invalid := range []string{"base64:not-base64", "base64:" + base64.StdEncoding.EncodeToString([]byte{0xff})} {
		if got := decodeLinkerConfig(invalid); got != invalid {
			t.Fatalf("invalid linker config must remain fail-closed input")
		}
	}
}

func TestLinkedTrustConfiguration(t *testing.T) {
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
				"%s trust configuration is invalid (bytes=%d, prefixed=%t, json=%t)",
				name,
				len(encoded),
				strings.HasPrefix(encoded, "base64:"),
				json.Valid([]byte(encoded)),
			)
		}
	}
}
