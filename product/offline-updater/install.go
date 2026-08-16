package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
)

type ReleaseSummary struct {
	Version         string          `json:"version"`
	Notes           []string        `json:"notes"`
	RuntimeManifest json.RawMessage `json:"runtimeManifest"`
}

type Dependencies struct {
	ExecutablePath func() (string, error)
	CandidateRoots func() ([]string, error)
	RunHelper      func(context.Context, string, string, io.Reader) error
	Confirm        func([]Candidate, ReleaseSummary) (Candidate, bool, error)
	Launch         func(string) error
}

func run(ctx context.Context, deps Dependencies) error {
	if deps.ExecutablePath == nil || deps.CandidateRoots == nil || deps.RunHelper == nil || deps.Confirm == nil || deps.Launch == nil {
		return errors.New("offline updater dependencies are incomplete")
	}
	executablePath, err := deps.ExecutablePath()
	if err != nil {
		return fmt.Errorf("resolve update executable: %w", err)
	}
	payload, err := openPayload(executablePath)
	if err != nil {
		return err
	}
	defer payload.Close()

	var summary ReleaseSummary
	if err := json.Unmarshal(payload.Manifest, &summary); err != nil || summary.Version == "" || len(summary.RuntimeManifest) == 0 {
		return errors.New("update manifest has no valid version")
	}
	var runtimeMetadata struct {
		ProductVersion string `json:"productVersion"`
		TargetPlatform string `json:"targetPlatform"`
		TargetArch     string `json:"targetArch"`
		RuntimeArchive string `json:"runtimeArchive"`
		RuntimeBytes   int64  `json:"runtimeBytes"`
	}
	if json.Unmarshal(summary.RuntimeManifest, &runtimeMetadata) != nil || runtimeMetadata.RuntimeBytes != payload.runtimeLength ||
		runtimeMetadata.ProductVersion != summary.Version || runtimeMetadata.TargetPlatform != "win32" ||
		runtimeMetadata.TargetArch != "x64" || runtimeMetadata.RuntimeArchive != "runtime.pkg" {
		return errors.New("runtime payload does not match release manifest")
	}
	roots, err := deps.CandidateRoots()
	if err != nil {
		return fmt.Errorf("enumerate removable drives: %w", err)
	}
	candidates := discoverCandidates(roots)
	if len(candidates) == 0 {
		return errors.New("no eligible U-Claw drive found")
	}
	selected, confirmed, err := deps.Confirm(candidates, summary)
	if err != nil {
		return fmt.Errorf("confirm update: %w", err)
	}
	if !confirmed {
		return nil
	}
	selected, ok := exactCandidate(candidates, selected)
	if !ok {
		return errors.New("confirmation returned an unknown drive")
	}

	header, err := json.Marshal(struct {
		SchemaVersion int             `json:"schemaVersion"`
		Manifest      json.RawMessage `json:"manifest"`
	}{SchemaVersion: 1, Manifest: summary.RuntimeManifest})
	if err != nil {
		return errors.New("encode secure install request")
	}
	reader := io.MultiReader(uint32Reader(uint32(len(header))), bytes.NewReader(header), payload.Runtime())
	if err := deps.RunHelper(ctx, selected.LauncherPath, selected.DataRoot, reader); err != nil {
		return fmt.Errorf("install update: %w", err)
	}
	if err := deps.Launch(selected.LauncherPath); err != nil {
		return fmt.Errorf("launch U-Claw: %w", err)
	}
	return nil
}

func exactCandidate(candidates []Candidate, selected Candidate) (Candidate, bool) {
	for _, candidate := range candidates {
		if candidate.Root == selected.Root {
			return candidate, true
		}
	}
	return Candidate{}, false
}

func uint32Reader(value uint32) io.Reader {
	buffer := make([]byte, 4)
	binary.BigEndian.PutUint32(buffer, value)
	return bytes.NewReader(buffer)
}

func defaultRunHelper(ctx context.Context, launcher, root string, input io.Reader) error {
	lock, err := acquireInstallLock(root)
	if err != nil {
		return err
	}
	defer lock.Close()
	command := exec.CommandContext(ctx, launcher, "--release-fs-helper", "secure-install", "--root", root)
	command.Stdin = input
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("release helper failed: %w: %s", err, output)
	}
	return nil
}

func defaultLaunch(launcher string) error {
	return exec.Command(launcher).Start()
}
