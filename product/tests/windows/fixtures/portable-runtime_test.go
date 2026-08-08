package main

import (
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
