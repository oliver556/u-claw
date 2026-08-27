package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateStagingRejectsData(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := validateStaging(root); err == nil {
		t.Fatal("expected data/ rejection")
	}
}

func TestValidateStagingRejectsOpenClawJSON(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "app", "desktop-archive")
	if err := os.MkdirAll(target, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "openclaw.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := validateStaging(root); err == nil {
		t.Fatal("expected openclaw.json rejection")
	}
}

func TestRunPreservesDataAndWritesVersion(t *testing.T) {
	root := t.TempDir()
	staging := filepath.Join(root, "app", ".update-staging", "tx")
	if err := os.MkdirAll(filepath.Join(staging, "app", "desktop-archive"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "UCLAW-PACKAGE-NOTES.txt"), []byte("new"), 0644); err != nil {
		t.Fatal(err)
	}
	dataConfig := filepath.Join(root, "data", ".openclaw", "openclaw.json")
	if err := os.MkdirAll(filepath.Dir(dataConfig), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dataConfig, []byte(`{"key":"keep"}`), 0644); err != nil {
		t.Fatal(err)
	}
	txPath := filepath.Join(root, "app", "update-transaction.json")
	tx := `{"schemaVersion":1,"id":"tx","targetVersion":"9.9.9","releaseId":"v9.9.9","state":"staged","stagingDir":"app/.update-staging/tx","backupDir":"app/.update-backup/tx"}`
	if err := os.MkdirAll(filepath.Dir(txPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(txPath, []byte(tx), 0644); err != nil {
		t.Fatal(err)
	}
	if err := Run(root, txPath, false); err != nil {
		t.Fatal(err)
	}
	kept, err := os.ReadFile(dataConfig)
	if err != nil {
		t.Fatal(err)
	}
	if string(kept) != `{"key":"keep"}` {
		t.Fatalf("data config changed: %s", kept)
	}
	if _, err := os.Stat(filepath.Join(root, "app", "version.json")); err != nil {
		t.Fatal(err)
	}
}
