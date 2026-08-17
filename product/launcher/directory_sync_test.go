package main

import (
	"os"
	"testing"
)

func TestSyncDirectorySupportsCurrentPlatform(t *testing.T) {
	directory, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if err := syncDirectory(directory); err != nil {
		t.Fatal(err)
	}
}
