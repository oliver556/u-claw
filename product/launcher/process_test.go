package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestActivationProcessSpecUsesRestrictedStartupMode(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	paths := PortablePaths{
		DataDir:       filepath.Join(t.TempDir(), "data"),
		HostCacheRoot: filepath.Join(t.TempDir(), "host-cache"),
	}
	manifest := validRuntimeManifest()
	manifest.Entrypoint = `electron\electron.exe`
	manifest.EntryArgs = []string{"resources/app.asar"}
	lease := processTestLease(root)

	fingerprint := usbFingerprint{Scheme: "uclaw-usb-v1", SHA256: strings.Repeat("a", 64)}
	spec := ActivationProcessSpec(paths, manifest, lease, fingerprint)

	wantEntrypoint := filepath.Join(root, "electron", "electron.exe")
	if spec.Path != wantEntrypoint || spec.Dir != filepath.Dir(wantEntrypoint) || spec.Lease != lease {
		t.Fatalf("process spec = %#v", spec)
	}
	wantArgs := []string{"resources/app.asar", "--uclaw-startup-mode=activation-only"}
	if !reflect.DeepEqual(spec.Args, wantArgs) {
		t.Fatalf("args = %v", spec.Args)
	}
	for _, entry := range spec.Env {
		if strings.HasPrefix(entry, "OPENCLAW_") {
			t.Fatalf("activation environment contains %q", entry)
		}
	}
	wantEnv := []string{
		"TEMP=" + filepath.Join(paths.HostCacheRoot, "cache", "temp"),
		"TMP=" + filepath.Join(paths.HostCacheRoot, "cache", "temp"),
		"UCLAW_CACHE_DIR=" + filepath.Join(paths.HostCacheRoot, "cache"),
		"UCLAW_DATA_DIR=" + paths.DataDir,
		"UCLAW_PACKAGE_ROOT=" + paths.PackageRoot,
		"UCLAW_USB_FINGERPRINT_SCHEME=uclaw-usb-v1",
		"UCLAW_USB_FINGERPRINT_SHA256=" + strings.Repeat("a", 64),
		"UCLAW_CLIENT_VERSION=" + manifest.ProductVersion,
		"UCLAW_RUNTIME_DIR=" + root,
	}
	if !reflect.DeepEqual(spec.Env, wantEnv) {
		t.Fatalf("environment = %v", spec.Env)
	}
	if !reflect.DeepEqual(spec.EnvRemovePrefixes, []string{"OPENCLAW_", "UCLAW_USB_FINGERPRINT_", "UCLAW_CLIENT_VERSION", "UCLAW_PACKAGE_ROOT"}) {
		t.Fatalf("environment removal prefixes = %v", spec.EnvRemovePrefixes)
	}
}

func TestManagedActivationProcessRemovesInheritedOpenClawEnvironment(t *testing.T) {
	t.Setenv("OPENCLAW_CONFIG_PATH", "host-config")
	t.Setenv("OPENCLAW_HOME", "host-home")
	t.Setenv("OPENCLAW_STATE_DIR", "host-state")
	t.Setenv("OPENCLAW_FUTURE_SETTING", "host-future")
	output := filepath.Join(t.TempDir(), "environment")
	spec := ProcessSpec{
		Path:              os.Args[0],
		Args:              []string{"-test.run=TestLauncherProcessHelper", "--", output},
		Env:               []string{"UCLAW_HELPER_MODE=write-openclaw"},
		EnvRemovePrefixes: []string{"OPENCLAW_"},
		Lease:             processTestLease(filepath.Dir(os.Args[0])),
	}
	process, err := StartManagedProcess(spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "|||" {
		t.Fatalf("inherited OpenClaw environment = %q", content)
	}
}

func TestNormalProcessSpecPreservesManifestArgumentsAndOpenClawEnvironment(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	paths := PortablePaths{
		DataDir:       filepath.Join(t.TempDir(), "data"),
		HostCacheRoot: filepath.Join(t.TempDir(), "host-cache"),
	}
	manifest := validRuntimeManifest()
	manifest.EntryArgs = []string{"resources/app.asar", "--inspect=0"}
	lease := processTestLease(root)

	spec := NormalProcessSpec(paths, manifest, lease)

	wantArgs := append(append([]string(nil), manifest.EntryArgs...), "--uclaw-startup-mode=normal")
	if !reflect.DeepEqual(spec.Args, wantArgs) {
		t.Fatalf("args = %v", spec.Args)
	}
	hasOpenClawEnvironment := false
	for _, entry := range spec.Env {
		if strings.HasPrefix(entry, "OPENCLAW_STATE_DIR=") {
			hasOpenClawEnvironment = true
		}
	}
	if !hasOpenClawEnvironment {
		t.Fatalf("normal environment = %v", spec.Env)
	}
}

func TestActivationCompletedRecognizesOnlyExitCode20(t *testing.T) {
	for _, test := range []struct {
		name string
		mode string
		want bool
	}{
		{name: "activation complete", mode: "exit20", want: true},
		{name: "other exit", mode: "exit21", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			process, err := StartManagedProcess(ProcessSpec{
				Path:  os.Args[0],
				Args:  []string{"-test.run=TestLauncherProcessHelper"},
				Env:   []string{"UCLAW_HELPER_MODE=" + test.mode},
				Lease: processTestLease(filepath.Dir(os.Args[0])),
			})
			if err != nil {
				t.Fatal(err)
			}
			if got := ActivationCompleted(process.Wait()); got != test.want {
				t.Fatalf("ActivationCompleted = %v, want %v", got, test.want)
			}
		})
	}
	if ActivationCompleted(nil) {
		t.Fatal("successful exit was treated as activation completion")
	}
	if ActivationCompleted(errors.New("exit status 20")) {
		t.Fatal("error text was treated as activation completion")
	}
}

func processTestLease(root string) *fakeRuntimeLease {
	return &fakeRuntimeLease{root: root}
}

func TestManagedProcessPassesExplicitArgumentsAndEnvironment(t *testing.T) {
	output := filepath.Join(t.TempDir(), "child output.txt")
	process, err := StartManagedProcess(ProcessSpec{
		Path:  os.Args[0],
		Args:  []string{"-test.run=TestLauncherProcessHelper", "--", output, "argument with spaces"},
		Env:   []string{"UCLAW_HELPER_MODE=write", "UCLAW_DATA_DIR=U盘数据"},
		Lease: processTestLease(filepath.Dir(os.Args[0])),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "U盘数据|argument with spaces" {
		t.Fatalf("content = %q", content)
	}
}

func TestManagedProcessStopTerminatesProcessGroup(t *testing.T) {
	process, err := StartManagedProcess(ProcessSpec{
		Path:  os.Args[0],
		Args:  []string{"-test.run=TestLauncherProcessHelper", "--"},
		Env:   []string{"UCLAW_HELPER_MODE=sleep"},
		Lease: processTestLease(filepath.Dir(os.Args[0])),
	})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if err := process.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := process.Wait(); err == nil {
		t.Fatal("stopped process exited successfully")
	}
}

func TestStartManagedProcessVerifiesEntrypointBeforeStarting(t *testing.T) {
	verifyErr := errors.New("entrypoint identity changed")
	lease := processTestLease(filepath.Dir(os.Args[0]))
	lease.verifyErr = verifyErr
	sentinel := filepath.Join(t.TempDir(), "started")
	process, err := StartManagedProcess(ProcessSpec{
		Path:  os.Args[0],
		Args:  []string{"-test.run=TestLauncherProcessHelper", "--", sentinel, "started"},
		Env:   []string{"UCLAW_HELPER_MODE=write"},
		Lease: lease,
	})
	if process != nil || !errors.Is(err, verifyErr) {
		t.Fatalf("process=%#v err=%v", process, err)
	}
	if !reflect.DeepEqual(lease.verified, []string{os.Args[0]}) {
		t.Fatalf("verified = %v", lease.verified)
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		_, err := os.Stat(sentinel)
		if err == nil {
			t.Fatal("process started and wrote sentinel")
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("stat sentinel: %v", err)
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestStartManagedProcessRejectsUnsafeSpec(t *testing.T) {
	for name, spec := range map[string]ProcessSpec{
		"relative":      {Path: "electron.exe", Lease: processTestLease(filepath.Dir(os.Args[0]))},
		"nul-arg":       {Path: os.Args[0], Args: []string{"bad\x00arg"}, Lease: processTestLease(filepath.Dir(os.Args[0]))},
		"nul-env":       {Path: os.Args[0], Env: []string{"TOKEN=bad\x00value"}, Lease: processTestLease(filepath.Dir(os.Args[0]))},
		"missing-lease": {Path: os.Args[0]},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := StartManagedProcess(spec); !errors.Is(err, ErrProcessInvalid) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestMergeEnvironmentWindowsOverridesKeysCaseInsensitively(t *testing.T) {
	merged := mergeEnvironmentForPlatform(
		[]string{"Path=C:\\Windows", "Uclaw_Data_Dir=C:\\Users\\host", "temp=C:\\host-temp"},
		[]string{"UCLAW_DATA_DIR=E:\\.uclaw\\data", "TEMP=C:\\U-Claw\\cache\\temp"},
		true,
	)
	want := []string{"Path=C:\\Windows", "TEMP=C:\\U-Claw\\cache\\temp", "UCLAW_DATA_DIR=E:\\.uclaw\\data"}
	if !reflect.DeepEqual(merged, want) {
		t.Fatalf("merged = %v", merged)
	}
}

func TestLauncherProcessHelper(t *testing.T) {
	mode := os.Getenv("UCLAW_HELPER_MODE")
	if mode == "" {
		return
	}
	separator := -1
	for index, argument := range os.Args {
		if argument == "--" {
			separator = index
			break
		}
	}
	switch mode {
	case "write":
		if separator < 0 || len(os.Args) < separator+3 {
			os.Exit(2)
		}
		content := strings.Join([]string{os.Getenv("UCLAW_DATA_DIR"), os.Args[separator+2]}, "|")
		if err := os.WriteFile(os.Args[separator+1], []byte(content), 0o600); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	case "sleep":
		for {
			time.Sleep(time.Second)
		}
	case "exit20":
		os.Exit(20)
	case "exit21":
		os.Exit(21)
	case "write-openclaw":
		if separator < 0 || len(os.Args) < separator+2 {
			os.Exit(2)
		}
		content := strings.Join([]string{
			os.Getenv("OPENCLAW_CONFIG_PATH"),
			os.Getenv("OPENCLAW_HOME"),
			os.Getenv("OPENCLAW_STATE_DIR"),
			os.Getenv("OPENCLAW_FUTURE_SETTING"),
		}, "|")
		if err := os.WriteFile(os.Args[separator+1], []byte(content), 0o600); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	default:
		os.Exit(4)
	}
}
