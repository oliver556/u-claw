package main

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestAcquireInstanceLockRejectsSecondWriter(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	first, err := AcquireInstanceLock(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := AcquireInstanceLock(dataDir); !errors.Is(err, ErrInstanceRunning) {
		t.Fatalf("second lock returned %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := AcquireInstanceLock(dataDir)
	if err != nil {
		t.Fatalf("lock unavailable after close: %v", err)
	}
	if err := third.Close(); err != nil {
		t.Fatal(err)
	}
}
