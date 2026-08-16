package main

import (
	"os"
	"path/filepath"
	"testing"
)

var requiredCandidateFiles = []string{
	"U-Claw.exe",
	filepath.Join(".uclaw", "version.json"),
	filepath.Join(".uclaw", "data", "license", "license.json"),
	filepath.Join(".uclaw", "data", "license", ".startup-credential.json"),
}

func makeCandidateRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, relative := range requiredCandidateFiles {
		path := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestDiscoverCandidatesRequiresAllRegularFiles(t *testing.T) {
	valid := makeCandidateRoot(t)
	missing := makeCandidateRoot(t)
	if err := os.Remove(filepath.Join(missing, requiredCandidateFiles[1])); err != nil {
		t.Fatal(err)
	}
	nonRegular := makeCandidateRoot(t)
	path := filepath.Join(nonRegular, requiredCandidateFiles[2])
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}

	candidates := discoverCandidates([]string{missing, valid, nonRegular})
	if len(candidates) != 1 || candidates[0].Root != valid {
		t.Fatalf("candidates = %#v, want only %q", candidates, valid)
	}
}

func TestDiscoverCandidatesRejectsSymlinkedRequiredFile(t *testing.T) {
	root := makeCandidateRoot(t)
	path := filepath.Join(root, "U-Claw.exe")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, requiredCandidateFiles[1]), path); err != nil {
		t.Fatal(err)
	}
	if got := discoverCandidates([]string{root}); len(got) != 0 {
		t.Fatalf("candidates = %#v, want none", got)
	}
}
