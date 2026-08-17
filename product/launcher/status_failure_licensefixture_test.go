//go:build licensefixture

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHeadlessFixtureRecordsFailureCodeOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "failure-code")
	t.Setenv("UCLAW_LAUNCHER_FAILURE_CODE_FILE", path)
	headlessStatusReporter{}.Fail("E_PACKAGE_INVALID", "must not be recorded")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "E_PACKAGE_INVALID\n" {
		t.Fatalf("failure code = %q", content)
	}
}
