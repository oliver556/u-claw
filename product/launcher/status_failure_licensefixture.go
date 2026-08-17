//go:build licensefixture

package main

import (
	"os"
	"regexp"
)

var fixtureFailureCodePattern = regexp.MustCompile(`^E_[A-Z0-9_]{1,62}$`)

func recordHeadlessFailure(code string) {
	path := os.Getenv("UCLAW_LAUNCHER_FAILURE_CODE_FILE")
	if path == "" || !fixtureFailureCodePattern.MatchString(code) {
		return
	}
	_ = os.WriteFile(path, []byte(code+"\n"), 0o600)
}
