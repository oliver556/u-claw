package main

import (
	"crypto/sha256"
	"path/filepath"
	"testing"
)

func TestRuntimeLeaseEntrypointPathRequiresExactCleanPathInsideRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	expected := filepath.Join(root, "bin", "runtime.exe")

	if !runtimeLeaseEntrypointMatches(root, `bin\runtime.exe`, expected, false) {
		t.Fatal("exact manifest entrypoint rejected")
	}
	for _, candidate := range []string{
		root,
		root + string(filepath.Separator) + "bin" + string(filepath.Separator) + ".." + string(filepath.Separator) + "bin" + string(filepath.Separator) + "runtime.exe",
		filepath.Join(filepath.Dir(root), "outside", "runtime.exe"),
		filepath.Join(root, "bin", "other.exe"),
	} {
		if runtimeLeaseEntrypointMatches(root, `bin\runtime.exe`, candidate, false) {
			t.Fatalf("unsafe candidate accepted: %q", candidate)
		}
	}
	if !runtimeLeaseEntrypointMatches(root, `BIN\RUNTIME.EXE`, expected, true) {
		t.Fatal("Windows case-insensitive entrypoint rejected")
	}
}

func TestRuntimeFileIdentityRejectsReplacementOrMutation(t *testing.T) {
	expected := runtimeFileIdentity{
		volumeSerialNumber: 7,
		fileIndexHigh:      11,
		fileIndexLow:       13,
		fileSize:           17,
		lastWriteTime:      19,
	}
	if !expected.matches(expected) {
		t.Fatal("same identity rejected")
	}
	mutations := []runtimeFileIdentity{
		{volumeSerialNumber: 8, fileIndexHigh: 11, fileIndexLow: 13, fileSize: 17, lastWriteTime: 19},
		{volumeSerialNumber: 7, fileIndexHigh: 12, fileIndexLow: 13, fileSize: 17, lastWriteTime: 19},
		{volumeSerialNumber: 7, fileIndexHigh: 11, fileIndexLow: 14, fileSize: 17, lastWriteTime: 19},
		{volumeSerialNumber: 7, fileIndexHigh: 11, fileIndexLow: 13, fileSize: 18, lastWriteTime: 19},
		{volumeSerialNumber: 7, fileIndexHigh: 11, fileIndexLow: 13, fileSize: 17, lastWriteTime: 20},
	}
	for _, current := range mutations {
		if expected.matches(current) {
			t.Fatalf("changed object accepted: %+v", current)
		}
	}
}

func TestRuntimeTreeDigestBindsPathSizeAndContentIndependentOfOrder(t *testing.T) {
	first := sha256.Sum256([]byte("first"))
	second := sha256.Sum256([]byte("second"))
	files := []runtimeTreeFile{
		{path: "z/file.bin", size: 6, digest: second},
		{path: "a/file.bin", size: 5, digest: first},
	}
	expected := runtimeTreeDigest(append([]runtimeTreeFile(nil), files...))
	reversed := []runtimeTreeFile{files[1], files[0]}
	if actual := runtimeTreeDigest(reversed); actual != expected {
		t.Fatalf("record order changed digest: %s != %s", actual, expected)
	}
	changed := append([]runtimeTreeFile(nil), files...)
	changed[0].digest = sha256.Sum256([]byte("altered"))
	if actual := runtimeTreeDigest(changed); actual == expected {
		t.Fatal("content replacement preserved tree digest")
	}
}
