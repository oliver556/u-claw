package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAcceptRuntimeSequencePersistsAndRejectsDowngrade(t *testing.T) {
	root := t.TempDir()
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	manifest.ReleaseID = "release-10"
	manifest.ReleaseSequence = 10
	manifest.Signature = &ManifestSignature{Sequence: 10, Value: "accepted-signature"}
	if err := AcceptRuntimeSequence(root, manifest); err != nil {
		t.Fatal(err)
	}
	if err := AcceptRuntimeSequence(root, manifest); err != nil {
		t.Fatalf("same release should remain launchable: %v", err)
	}
	manifest.ReleaseID = "release-9"
	manifest.ReleaseSequence = 9
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
	accepted.ReleaseID = "release-10"
	accepted.ReleaseSequence = 10
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
	manifest.ReleaseID = "release-10"
	manifest.ReleaseSequence = 10
	manifest.Signature = &ManifestSignature{Sequence: 10, Value: "accepted-signature"}
	if err := AcceptRuntimeSequence(root, manifest); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(root, releaseSequenceName))
	if err != nil {
		t.Fatal(err)
	}
	var record releaseSequenceRecord
	if err := json.Unmarshal(contents, &record); err != nil {
		t.Fatal(err)
	}
	if record.ReleaseSequence != 10 || record.ReleaseID != manifest.ReleaseID || record.RuntimeTreeSHA256 != manifest.RuntimeTreeSHA256 || record.SignatureValue != manifest.Signature.Value || record.MAC == "" {
		t.Fatalf("persisted identity = %#v", record)
	}
}

func TestInstalledCurrentAuthenticationFailsClosed(t *testing.T) {
	root := t.TempDir()
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	manifest.Signature = &ManifestSignature{Sequence: manifest.ReleaseSequence, Value: "accepted-signature"}
	if err := AcceptRuntimeSequence(root, manifest); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, installedCurrentName)
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record releaseSequenceRecord
	if err := json.Unmarshal(contents, &record); err != nil {
		t.Fatal(err)
	}
	record.ReleaseID = "forged-release"
	forged, _ := json.Marshal(record)
	if err := os.WriteFile(path, forged, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CheckRuntimeSequence(root, manifest); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("forged installed-current returned %v", err)
	}
}

func TestInstalledCurrentRejectsSymlinkReplacement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires privileges on Windows")
	}
	root := t.TempDir()
	if err := EnsureHostCacheOwnership(root); err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	manifest.Signature = &ManifestSignature{Sequence: manifest.ReleaseSequence, Value: "accepted-signature"}
	if err := AcceptRuntimeSequence(root, manifest); err != nil {
		t.Fatal(err)
	}
	current := filepath.Join(root, installedCurrentName)
	backup := filepath.Join(root, "saved-current.json")
	if err := os.Rename(current, backup); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(backup, current); err != nil {
		t.Fatal(err)
	}
	if err := CheckRuntimeSequence(root, manifest); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("symlink installed-current returned %v", err)
	}
}
