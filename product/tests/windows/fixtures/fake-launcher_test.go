package main

import (
	"testing"
	"time"
)

func TestTimingDelayUsesSevenDistinctNearestRankSamples(t *testing.T) {
	expected := map[int]time.Duration{
		10: 0,
		11: 0,
		12: 0,
		13: 300 * time.Millisecond,
		14: 900 * time.Millisecond,
		15: 900 * time.Millisecond,
		16: 2 * time.Second,
	}
	for invocation := 1; invocation <= 18; invocation++ {
		want := expected[invocation]
		if got := timingDelay(invocation); got != want {
			t.Fatalf("invocation %d: got %s, want %s", invocation, got, want)
		}
	}
}
