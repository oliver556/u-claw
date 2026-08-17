//go:build licensefixture

package main

import (
	"encoding/base64"
	"strings"
)

const fixtureLinkerConfigPrefix = "base64:"

func init() {
	trustedRuntimeKeys = decodeFixtureLinkerConfig(trustedRuntimeKeys)
	trustedStartupLicenseKeys = decodeFixtureLinkerConfig(trustedStartupLicenseKeys)
	trustedLicenseStatusKeys = decodeFixtureLinkerConfig(trustedLicenseStatusKeys)
}

func decodeFixtureLinkerConfig(encoded string) string {
	if !strings.HasPrefix(encoded, fixtureLinkerConfigPrefix) {
		return encoded
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, fixtureLinkerConfigPrefix))
	if err != nil {
		return encoded
	}
	return string(decoded)
}
