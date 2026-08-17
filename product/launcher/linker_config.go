package main

import (
	"encoding/base64"
	"strings"
	"unicode/utf8"
)

const linkerConfigPrefix = "base64:"

func init() {
	trustedRuntimeKeys = decodeLinkerConfig(trustedRuntimeKeys)
	trustedStartupLicenseKeys = decodeLinkerConfig(trustedStartupLicenseKeys)
	trustedLicenseStatusKeys = decodeLinkerConfig(trustedLicenseStatusKeys)
}

func decodeLinkerConfig(encoded string) string {
	if !strings.HasPrefix(encoded, linkerConfigPrefix) {
		return encoded
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, linkerConfigPrefix))
	if err != nil || !utf8.Valid(decoded) {
		return encoded
	}
	return string(decoded)
}
