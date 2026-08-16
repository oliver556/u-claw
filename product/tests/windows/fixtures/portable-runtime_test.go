package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHoldDurationIsBounded(t *testing.T) {
	for value, want := range map[string]time.Duration{
		"":      100 * time.Millisecond,
		"250":   250 * time.Millisecond,
		"0":     100 * time.Millisecond,
		"-1":    100 * time.Millisecond,
		"30001": 100 * time.Millisecond,
		"bad":   100 * time.Millisecond,
	} {
		t.Setenv("UCLAW_FIXTURE_HOLD_MS", value)
		if got := holdDuration(); got != want {
			t.Fatalf("value %q: got %s, want %s", value, got, want)
		}
	}
}

func TestRunFixtureRequestsOneUpdateRestart(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("UCLAW_DATA_DIR", dataDir)
	t.Setenv("UCLAW_FIXTURE_HOLD_MS", "1")
	t.Setenv("UCLAW_FIXTURE_UPDATE_RESTART_ONCE", "1")
	if code := runFixture(); code != 42 {
		t.Fatalf("first run code = %d, want 42", code)
	}
	if _, err := os.Stat(filepath.Join(dataDir, ".fixture-update-restart-requested")); err != nil {
		t.Fatal(err)
	}
	if code := runFixture(); code != 0 {
		t.Fatalf("second run code = %d, want 0", code)
	}
	markers, err := filepath.Glob(filepath.Join(dataDir, ".fixture-ready-*"))
	if err != nil || len(markers) != 1 {
		t.Fatalf("ready markers = %v, err = %v", markers, err)
	}
}
