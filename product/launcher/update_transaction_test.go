package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestFinalizeUpdateTransactionRemovesAcceptedRollback(t *testing.T) {
	packageRoot := t.TempDir()
	manifest := validRuntimeManifest()
	manifest.Signature = &ManifestSignature{Sequence: 42, Value: "fixture-signature"}
	record := updateTransaction{
		SchemaVersion: 1,
		State:         "complete",
		Target: updateIdentity{
			Sequence:       manifest.Signature.Sequence,
			RuntimeSHA256:  manifest.RuntimeSHA256,
			SignatureValue: manifest.Signature.Value,
		},
	}
	contents, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string][]byte{
		updateTransactionName:   contents,
		"runtime.pkg.rollback":  []byte("old runtime"),
		"version.json.rollback": []byte("old manifest"),
	} {
		if err := os.WriteFile(filepath.Join(packageRoot, name), value, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := FinalizeUpdateTransaction(packageRoot, manifest); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{updateTransactionName, "runtime.pkg.rollback", "version.json.rollback"} {
		if _, err := os.Lstat(filepath.Join(packageRoot, name)); !os.IsNotExist(err) {
			t.Fatalf("%s still exists or could not be checked: %v", name, err)
		}
	}
}

func TestFinalizeUpdateTransactionFailsClosedForWrongIdentity(t *testing.T) {
	packageRoot := t.TempDir()
	manifest := validRuntimeManifest()
	manifest.Signature = &ManifestSignature{Sequence: 42, Value: "fixture-signature"}
	record := updateTransaction{
		SchemaVersion: 1,
		State:         "complete",
		Target: updateIdentity{
			Sequence:       manifest.Signature.Sequence,
			RuntimeSHA256:  "0" + manifest.RuntimeSHA256[1:],
			SignatureValue: manifest.Signature.Value,
		},
	}
	contents, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	transactionPath := filepath.Join(packageRoot, updateTransactionName)
	if err := os.WriteFile(transactionPath, contents, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := FinalizeUpdateTransaction(packageRoot, manifest); err == nil {
		t.Fatal("wrong transaction identity was accepted")
	}
	if _, err := os.Lstat(transactionPath); err != nil {
		t.Fatalf("failed transaction was removed: %v", err)
	}
}
