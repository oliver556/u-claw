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
	originalEndpoint, originalKeys := activationServiceEndpoint, trustedStartupLicenseKeys
	activationServiceEndpoint = "https://activation.u-claw.org/"
	trustedStartupLicenseKeys = `{"activation-2026":"fixture-public-key"}`
	t.Cleanup(func() {
		activationServiceEndpoint, trustedStartupLicenseKeys = originalEndpoint, originalKeys
	})
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
		if strings.HasPrefix(entry, "UCLAW_NODE_BIN=") || strings.HasPrefix(entry, "UCLAW_OPENCLAW_ENTRY=") {
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
		"UCLAW_ACTIVATION_ENDPOINT=https://activation.u-claw.org/",
		`UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS={"activation-2026":"fixture-public-key"}`,
		"UCLAW_RUNTIME_DIR=" + root,
	}
	if !reflect.DeepEqual(spec.Env, wantEnv) {
		t.Fatalf("environment = %v", spec.Env)
	}
	if !reflect.DeepEqual(spec.EnvRemovePrefixes, []string{"OPENCLAW_", "UCLAW_USB_FINGERPRINT_", "UCLAW_CLIENT_VERSION", "UCLAW_PACKAGE_ROOT", "UCLAW_ACTIVATION_", "UCLAW_NODE_BIN=", "UCLAW_OPENCLAW_ENTRY="}) {
		t.Fatalf("environment removal prefixes = %v", spec.EnvRemovePrefixes)
	}
}

func TestFilterEnvironmentSupportsExactAssignmentPrefixes(t *testing.T) {
	base := []string{
		"UCLAW_NODE_BIN=C:\\host\\node.exe",
		"UCLAW_NODE_BINARY=keep",
		"UCLAW_OPENCLAW_ENTRY=C:\\host\\openclaw.mjs",
		"UCLAW_OPENCLAW_ENTRYPOINT=keep",
	}
	got := filterEnvironment(base, []string{"UCLAW_NODE_BIN=", "UCLAW_OPENCLAW_ENTRY="}, true)
	want := []string{"UCLAW_NODE_BINARY=keep", "UCLAW_OPENCLAW_ENTRYPOINT=keep"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filtered environment = %v", got)
	}
}

func TestManagedActivationProcessRemovesInheritedRuntimePaths(t *testing.T) {
	t.Setenv("UCLAW_NODE_BIN", "C:\\host\\node.exe")
	t.Setenv("UCLAW_OPENCLAW_ENTRY", "C:\\host\\openclaw.mjs")
	output := filepath.Join(t.TempDir(), "environment")
	paths := PortablePaths{
		DataDir:       filepath.Join(t.TempDir(), "data"),
		HostCacheRoot: filepath.Join(t.TempDir(), "host-cache"),
	}
	spec := ActivationProcessSpec(paths, validRuntimeManifest(), processTestLease(t.TempDir()), usbFingerprint{})
	spec.Path = os.Args[0]
	spec.Dir = filepath.Dir(os.Args[0])
	spec.Args = []string{"-test.run=TestLauncherProcessHelper", "--", output}
	spec.Env = append(spec.Env, "UCLAW_HELPER_MODE=write-runtime-paths")
	spec.Lease = processTestLease(filepath.Dir(os.Args[0]))

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
	if string(content) != "|" {
		t.Fatalf("inherited runtime paths = %q", content)
	}
}

func TestActivationProcessEnvironmentReplacesInheritedActivationConfiguration(t *testing.T) {
	base := []string{
		"UCLAW_ACTIVATION_ENDPOINT=https://attacker.example/",
		`UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS={"attacker":"key"}`,
		"UCLAW_ACTIVATION_FUTURE_SETTING=forged",
		"PATH=fixture-path",
	}
	overrides := []string{
		"UCLAW_ACTIVATION_ENDPOINT=https://activation.u-claw.org/",
		`UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS={"activation-2026":"fixture-public-key"}`,
	}
	got := mergeEnvironmentForPlatform(
		filterEnvironment(base, []string{"UCLAW_ACTIVATION_"}, true),
		overrides,
		true,
	)
	want := []string{
		"PATH=fixture-path",
		"UCLAW_ACTIVATION_ENDPOINT=https://activation.u-claw.org/",
		`UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS={"activation-2026":"fixture-public-key"}`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("activation environment = %v", got)
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
	wantRuntimeEnvironment := map[string]string{
		"UCLAW_NODE_BIN":       filepath.Join(root, "node", "node.exe"),
		"UCLAW_OPENCLAW_ENTRY": filepath.Join(root, "electron", "resources", "app", "node_modules", "openclaw", "openclaw.mjs"),
	}
	for key, wantValue := range wantRuntimeEnvironment {
		matches := environmentValues(spec.Env, key)
		if !reflect.DeepEqual(matches, []string{wantValue}) {
			t.Fatalf("%s values = %v, want [%s]", key, matches, wantValue)
		}
	}
}

func TestNormalProcessSpecUsesSingleRuntimeRootSnapshot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	lease := &rootPathSnapshotLease{fakeRuntimeLease: processTestLease(root)}
	manifest := validRuntimeManifest()
	manifest.Entrypoint = `electron\electron.exe`

	spec := NormalProcessSpec(PortablePaths{}, manifest, lease)

	if lease.rootPathCalls != 1 {
		t.Fatalf("RootPath calls = %d, want 1", lease.rootPathCalls)
	}
	if spec.Path != filepath.Join(root, "electron", "electron.exe") {
		t.Fatalf("process path = %q", spec.Path)
	}
	if got := environmentValues(spec.Env, "UCLAW_NODE_BIN"); !reflect.DeepEqual(got, []string{filepath.Join(root, "node", "node.exe")}) {
		t.Fatalf("UCLAW_NODE_BIN values = %v", got)
	}
	if got := environmentValues(spec.Env, "UCLAW_OPENCLAW_ENTRY"); !reflect.DeepEqual(got, []string{filepath.Join(root, "electron", "resources", "app", "node_modules", "openclaw", "openclaw.mjs")}) {
		t.Fatalf("UCLAW_OPENCLAW_ENTRY values = %v", got)
	}
}

type rootPathSnapshotLease struct {
	*fakeRuntimeLease
	rootPathCalls int
}

func (lease *rootPathSnapshotLease) RootPath() string {
	lease.rootPathCalls++
	if lease.rootPathCalls == 1 {
		return lease.root
	}
	return lease.root + "-changed"
}

func TestNormalProcessEnvironmentOverridesInheritedRuntimePaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	paths := PortablePaths{
		DataDir:       filepath.Join(t.TempDir(), "data"),
		HostCacheRoot: filepath.Join(t.TempDir(), "host-cache"),
	}
	spec := NormalProcessSpec(paths, validRuntimeManifest(), processTestLease(root))
	merged := mergeEnvironmentForPlatform(
		[]string{
			"UCLAW_NODE_BIN=C:\\host\\node.exe",
			"UCLAW_OPENCLAW_ENTRY=C:\\host\\openclaw.mjs",
		},
		spec.Env,
		true,
	)

	wantRuntimeEnvironment := map[string]string{
		"UCLAW_NODE_BIN":       filepath.Join(root, "node", "node.exe"),
		"UCLAW_OPENCLAW_ENTRY": filepath.Join(root, "electron", "resources", "app", "node_modules", "openclaw", "openclaw.mjs"),
	}
	for key, wantValue := range wantRuntimeEnvironment {
		matches := environmentValues(merged, key)
		if !reflect.DeepEqual(matches, []string{wantValue}) {
			t.Fatalf("merged %s values = %v, want [%s]", key, matches, wantValue)
		}
	}
}

func environmentValues(environment []string, key string) []string {
	prefix := key + "="
	var values []string
	for _, entry := range environment {
		if strings.HasPrefix(entry, prefix) {
			values = append(values, strings.TrimPrefix(entry, prefix))
		}
	}
	return values
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
	case "write-runtime-paths":
		if separator < 0 || len(os.Args) < separator+2 {
			os.Exit(2)
		}
		content := strings.Join([]string{
			os.Getenv("UCLAW_NODE_BIN"),
			os.Getenv("UCLAW_OPENCLAW_ENTRY"),
		}, "|")
		if err := os.WriteFile(os.Args[separator+1], []byte(content), 0o600); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	default:
		os.Exit(4)
	}
}
