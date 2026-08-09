package main

import (
	"errors"
	"testing"
)

func TestAcceptRuntimeSequencePersistsAndRejectsDowngrade(t *testing.T) {
	root := t.TempDir()
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	manifest.Signature = &ManifestSignature{Sequence: 10}
	if err := AcceptRuntimeSequence(root, manifest); err != nil {
		t.Fatal(err)
	}
	if err := AcceptRuntimeSequence(root, manifest); err != nil {
		t.Fatalf("same release should remain launchable: %v", err)
	}
	manifest.Signature.Sequence = 9
	if err := CheckRuntimeSequence(root, manifest); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("downgrade preflight returned %v", err)
	}
	if err := AcceptRuntimeSequence(root, manifest); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("downgrade returned %v", err)
	}
}
