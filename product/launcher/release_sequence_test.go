package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAcceptRuntimeSequencePersistsAndRejectsDowngrade(t *testing.T) {
	root := t.TempDir()
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	manifest.Signature = &ManifestSignature{Sequence: 10, Value: "accepted-signature"}
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

func TestRuntimeSequenceRejectsDifferentIdentityAtAcceptedSequence(t *testing.T) {
	root := t.TempDir()
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	accepted := validRuntimeManifest()
	accepted.Signature = &ManifestSignature{Sequence: 10, Value: "accepted-signature"}
	if err := AcceptRuntimeSequence(root, accepted); err != nil {
		t.Fatal(err)
	}

	for name, mutate := range map[string]func(*Manifest){
		"different hash":      func(value *Manifest) { value.RuntimeSHA256 = "b" + value.RuntimeSHA256[1:] },
		"different signature": func(value *Manifest) { value.Signature.Value = "other-signature" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := accepted
			candidate.Signature = &ManifestSignature{Sequence: accepted.Signature.Sequence, Value: accepted.Signature.Value}
			mutate(&candidate)
			if err := CheckRuntimeSequence(root, candidate); !errors.Is(err, ErrManifestInvalid) {
				t.Fatalf("same-sequence replacement preflight returned %v", err)
			}
			if err := AcceptRuntimeSequence(root, candidate); !errors.Is(err, ErrManifestInvalid) {
				t.Fatalf("same-sequence replacement acceptance returned %v", err)
			}
		})
	}
}

func TestAcceptRuntimeSequencePersistsRuntimeIdentity(t *testing.T) {
	root := t.TempDir()
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	manifest.Signature = &ManifestSignature{Sequence: 10, Value: "accepted-signature"}
	if err := AcceptRuntimeSequence(root, manifest); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(root, releaseSequenceName))
	if err != nil {
		t.Fatal(err)
	}
	var record updateIdentity
	if err := json.Unmarshal(contents, &record); err != nil {
		t.Fatal(err)
	}
	if record.Sequence != 10 || record.RuntimeSHA256 != manifest.RuntimeSHA256 || record.SignatureValue != manifest.Signature.Value {
		t.Fatalf("persisted identity = %#v", record)
	}
}
