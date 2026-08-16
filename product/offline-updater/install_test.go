package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func releaseFeed(version string) []byte {
	return []byte(`{"version":"` + version + `","notes":["Fix"],"runtimeManifest":{"schemaVersion":1,"productVersion":"` + version + `","targetPlatform":"win32","targetArch":"x64","runtimeArchive":"runtime.pkg","runtimeBytes":7}}`)
}

func TestRunRequiresExplicitConfirmationWithMultipleCandidates(t *testing.T) {
	first := makeCandidateRoot(t)
	second := makeCandidateRoot(t)
	manifest := releaseFeed("2.0.0")
	payloadPath := writePayload(t, []byte("exe"), manifest, []byte("runtime"), payloadMagic, uint32(len(manifest)), 7)
	confirmed := false
	helperCalled := false
	deps := Dependencies{
		ExecutablePath: func() (string, error) { return payloadPath, nil },
		CandidateRoots: func() ([]string, error) { return []string{first, second}, nil },
		Confirm: func(candidates []Candidate, summary ReleaseSummary) (Candidate, bool, error) {
			confirmed = true
			if len(candidates) != 2 || summary.Version != "2.0.0" || len(summary.Notes) != 1 {
				t.Fatalf("confirm args = %#v, %#v", candidates, summary)
			}
			return candidates[1], true, nil
		},
		RunHelper: func(context.Context, string, string, io.Reader) error {
			helperCalled = true
			return nil
		},
		Launch: func(string) error { return nil },
	}
	if err := run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	if !confirmed || !helperCalled {
		t.Fatalf("confirmed=%v helperCalled=%v", confirmed, helperCalled)
	}
}

func TestRunCancellationDoesNotInstall(t *testing.T) {
	root := makeCandidateRoot(t)
	manifest := releaseFeed("2.0.0")
	payloadPath := writePayload(t, []byte("exe"), manifest, []byte("runtime"), payloadMagic, uint32(len(manifest)), 7)
	helperCalled := false
	deps := Dependencies{
		ExecutablePath: func() (string, error) { return payloadPath, nil },
		CandidateRoots: func() ([]string, error) { return []string{root}, nil },
		Confirm:        func([]Candidate, ReleaseSummary) (Candidate, bool, error) { return Candidate{}, false, nil },
		RunHelper:      func(context.Context, string, string, io.Reader) error { helperCalled = true; return nil },
		Launch:         func(string) error { return nil },
	}
	if err := run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	if helperCalled {
		t.Fatal("helper called after cancellation")
	}
}

func TestRunStreamsHelperProtocolWithoutShell(t *testing.T) {
	root := makeCandidateRoot(t)
	manifest := []byte(`{"version":"2.0.0","notes":["Fix"],"runtimeManifest":{"schemaVersion":1,"productVersion":"2.0.0","targetPlatform":"win32","targetArch":"x64","runtimeArchive":"runtime.pkg","runtimeBytes":5}}`)
	runtime := []byte{0, 1, 2, 3, 255}
	payloadPath := writePayload(t, []byte("exe"), manifest, runtime, payloadMagic, uint32(len(manifest)), uint32(len(runtime)))
	deps := Dependencies{
		ExecutablePath: func() (string, error) { return payloadPath, nil },
		CandidateRoots: func() ([]string, error) { return []string{root}, nil },
		Confirm: func(candidates []Candidate, _ ReleaseSummary) (Candidate, bool, error) {
			return candidates[0], true, nil
		},
		RunHelper: func(ctx context.Context, launcher, rootArg string, input io.Reader) error {
			if launcher != filepath.Join(root, "U-Claw.exe") {
				t.Fatalf("launcher = %q", launcher)
			}
			wantRoot, _ := filepath.Abs(filepath.Join(root, ".uclaw"))
			if rootArg != wantRoot {
				t.Fatalf("root = %q, want %q", rootArg, wantRoot)
			}
			got, err := io.ReadAll(input)
			if err != nil {
				t.Fatal(err)
			}
			var want bytes.Buffer
			helperHeader := []byte(`{"schemaVersion":1,"manifest":{"schemaVersion":1,"productVersion":"2.0.0","targetPlatform":"win32","targetArch":"x64","runtimeArchive":"runtime.pkg","runtimeBytes":5}}`)
			_ = binary.Write(&want, binary.BigEndian, uint32(len(helperHeader)))
			want.Write(helperHeader)
			want.Write(runtime)
			if !bytes.Equal(got, want.Bytes()) {
				t.Fatalf("helper input = %v, want %v", got, want.Bytes())
			}
			return nil
		},
		Launch: func(string) error { return nil },
	}
	if err := run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
}

func TestRunPropagatesHelperFailureAndDoesNotLaunch(t *testing.T) {
	root := makeCandidateRoot(t)
	manifest := releaseFeed("2.0.0")
	payloadPath := writePayload(t, []byte("exe"), manifest, []byte("runtime"), payloadMagic, uint32(len(manifest)), 7)
	launchCalled := false
	wantErr := errors.New("helper exited 1")
	deps := Dependencies{
		ExecutablePath: func() (string, error) { return payloadPath, nil },
		CandidateRoots: func() ([]string, error) { return []string{root}, nil },
		Confirm: func(candidates []Candidate, _ ReleaseSummary) (Candidate, bool, error) {
			return candidates[0], true, nil
		},
		RunHelper: func(context.Context, string, string, io.Reader) error { return wantErr },
		Launch:    func(string) error { launchCalled = true; return nil },
	}
	err := run(context.Background(), deps)
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
	if launchCalled {
		t.Fatal("launch called after helper failure")
	}
}

func TestRunLaunchesSelectedLauncherAfterSuccess(t *testing.T) {
	root := makeCandidateRoot(t)
	manifest := releaseFeed("2.0.0")
	payloadPath := writePayload(t, []byte("exe"), manifest, []byte("runtime"), payloadMagic, uint32(len(manifest)), 7)
	launched := ""
	deps := Dependencies{
		ExecutablePath: func() (string, error) { return payloadPath, nil },
		CandidateRoots: func() ([]string, error) { return []string{root}, nil },
		Confirm: func(candidates []Candidate, _ ReleaseSummary) (Candidate, bool, error) {
			return candidates[0], true, nil
		},
		RunHelper: func(context.Context, string, string, io.Reader) error { return nil },
		Launch:    func(path string) error { launched = path; return nil },
	}
	if err := run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "U-Claw.exe"); launched != want {
		t.Fatalf("launched = %q, want %q", launched, want)
	}
}

func TestRunRejectsRuntimeLengthMismatchBeforeHelper(t *testing.T) {
	root := makeCandidateRoot(t)
	manifest := releaseFeed("2.0.0")
	payloadPath := writePayload(t, []byte("exe"), manifest, []byte("runtime-extra"), payloadMagic, uint32(len(manifest)), 13)
	helperCalled := false
	deps := Dependencies{
		ExecutablePath: func() (string, error) { return payloadPath, nil },
		CandidateRoots: func() ([]string, error) { return []string{root}, nil },
		Confirm: func(candidates []Candidate, _ ReleaseSummary) (Candidate, bool, error) {
			return candidates[0], true, nil
		},
		RunHelper: func(context.Context, string, string, io.Reader) error { helperCalled = true; return nil },
		Launch:    func(string) error { return nil },
	}
	if err := run(context.Background(), deps); err == nil {
		t.Fatal("runtime length mismatch unexpectedly succeeded")
	}
	if helperCalled {
		t.Fatal("helper called for mismatched runtime payload")
	}
}

func TestDefaultRunHelperUsesSecureInstallArguments(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows E2E executes the real Launcher helper")
	}
	dir := t.TempDir()
	launcher := filepath.Join(dir, "U-Claw.exe")
	argsPath := filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"" + argsPath + "\"\ncat >/dev/null\n"
	if err := os.WriteFile(launcher, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, ".uclaw")
	if err := defaultRunHelper(context.Background(), launcher, root, bytes.NewReader([]byte("input"))); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "--release-fs-helper\nsecure-install\n--root\n"+root+"\n" {
		t.Fatalf("args = %q", got)
	}
}
