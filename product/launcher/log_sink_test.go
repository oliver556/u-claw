package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLauncherLogSinkAppendsOnlySafeOwnedEvents(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	if err := appendLauncherLog(dataDir, "launcher-started"); err != nil {
		t.Fatal(err)
	}
	if err := appendLauncherLog(dataDir, "runtime-started"); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(dataDir, "diagnostics", "desktop-logs", "uclaw-launcher.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	if !strings.Contains(text, `"event":"launcher-started"`) || !strings.Contains(text, `"event":"runtime-started"`) {
		t.Fatalf("unexpected log: %s", text)
	}
	if strings.Contains(strings.ToLower(text), "token") {
		t.Fatal("launcher log leaked credential-shaped text")
	}
}

func TestLauncherLogSinkRejectsUnknownEvent(t *testing.T) {
	if err := appendLauncherLog(t.TempDir(), "token=secret"); err == nil {
		t.Fatal("expected unknown event rejection")
	}
}

func TestLauncherLogSinkRejectsSymlinkTarget(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	logsDir := filepath.Join(dataDir, "diagnostics", "desktop-logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "external.log")
	if err := os.WriteFile(external, []byte("outside\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(logsDir, "uclaw-launcher.jsonl")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := appendLauncherLog(dataDir, "launcher-started"); err == nil {
		t.Fatal("expected symlink target rejection")
	}
	content, err := os.ReadFile(external)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "outside\n" {
		t.Fatalf("external target changed: %q", content)
	}
}
