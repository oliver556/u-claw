package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAcquireRuntimeLeaseVerifiesRuntimeTree(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "runtime.bin"), []byte("trusted"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := runtimeTreeDigestAt(root)
	if err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	manifest.Entrypoint = "runtime.bin"
	fileDigest := sha256.Sum256([]byte("trusted"))
	manifest.CriticalFiles = []RuntimeFileDigest{{Path: "runtime.bin", Size: 7, SHA256: hex.EncodeToString(fileDigest[:])}}
	manifest.RuntimeTreeSHA256 = digest
	if err := writeCacheMarker(root, manifest); err != nil {
		t.Fatal(err)
	}

	lease, err := AcquireRuntimeLease(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if lease.RootPath() != root {
		t.Fatalf("lease root = %q", lease.RootPath())
	}
	if err := lease.VerifyEntrypoint(filepath.Join(root, "runtime.bin")); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAcquireRuntimeLeaseMapsDigestErrorsToInvalidPackage(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink("missing-target", filepath.Join(root, "changed-link")); err != nil {
		t.Fatal(err)
	}
	manifest := validRuntimeManifest()
	_, err := AcquireRuntimeLease(root, manifest)
	if !errors.Is(err, ErrPackageInvalid) || errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("returned %v", err)
	}
}

type recordingReporter struct {
	states   []State
	failures [][2]string
	closed   bool
}

func (reporter *recordingReporter) State(state State) {
	reporter.states = append(reporter.states, state)
}

func (reporter *recordingReporter) Fail(code string, message string) {
	reporter.failures = append(reporter.failures, [2]string{code, message})
}

func (reporter *recordingReporter) Close() {
	reporter.closed = true
}

type fakeInstanceLock struct {
	closed bool
}

func (lock *fakeInstanceLock) Close() error {
	lock.closed = true
	return nil
}

type fakeRuntimeLease struct {
	root       string
	verifyErr  error
	verified   []string
	closeErr   error
	closeCalls atomic.Int32
}

func (lease *fakeRuntimeLease) RootPath() string {
	return lease.root
}

func (lease *fakeRuntimeLease) VerifyEntrypoint(path string) error {
	lease.verified = append(lease.verified, path)
	return lease.verifyErr
}

func (lease *fakeRuntimeLease) Close() error {
	lease.closeCalls.Add(1)
	return lease.closeErr
}

func (lease *fakeRuntimeLease) CloseCalls() int {
	return int(lease.closeCalls.Load())
}

type fakeChildProcess struct {
	waitErr error
	stopped bool
}

func processExitError(t *testing.T, code string) error {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=TestLauncherProcessHelper")
	command.Env = append(os.Environ(), "UCLAW_HELPER_MODE=exit"+code)
	err := command.Run()
	if err == nil {
		t.Fatalf("helper exit %s returned nil", code)
	}
	return err
}

func (process *fakeChildProcess) Wait() error {
	return process.waitErr
}

func (process *fakeChildProcess) Stop() error {
	process.stopped = true
	return nil
}

type blockingChildProcess struct {
	result  chan error
	stopped bool
}

type stopFailingChildProcess struct{}

func (*stopFailingChildProcess) Wait() error {
	select {}
}

func (*stopFailingChildProcess) Stop() error {
	return errors.New("terminate failed")
}

type releasableStopFailingChildProcess struct {
	result chan error
}

func (process *releasableStopFailingChildProcess) Wait() error {
	return <-process.result
}

func (*releasableStopFailingChildProcess) Stop() error {
	return errors.New("terminate failed")
}

type releasableTimeoutChildProcess struct {
	result chan error
}

func (process *releasableTimeoutChildProcess) Wait() error {
	return <-process.result
}

func (*releasableTimeoutChildProcess) Stop() error {
	return nil
}

func (process *blockingChildProcess) Wait() error {
	return <-process.result
}

func (process *blockingChildProcess) Stop() error {
	process.stopped = true
	process.result <- errors.New("stopped")
	return nil
}

func successfulDependencies(t *testing.T, reporter Reporter) (Dependencies, *fakeInstanceLock, *ProcessSpec) {
	t.Helper()
	root := t.TempDir()
	paths := PortablePaths{
		USBRoot:       root,
		PackageRoot:   filepath.Join(root, ".uclaw"),
		DataDir:       filepath.Join(root, ".uclaw", "data"),
		HostCacheRoot: filepath.Join(t.TempDir(), "U-Claw"),
		CacheRoot:     filepath.Join(t.TempDir(), "runtime"),
	}
	manifest := validRuntimeManifest()
	manifest.Entrypoint = `electron\electron.exe`
	lock := &fakeInstanceLock{}
	lease := &fakeRuntimeLease{root: filepath.Join(paths.CacheRoot, runtimeInstallName(manifest))}
	var startedSpec ProcessSpec
	return Dependencies{
		Paths:              paths,
		Reporter:           reporter,
		USBInterval:        time.Hour,
		ProcessStopTimeout: time.Second,
		ProbeDataDirectory: func(packageRoot string, dataDir string) error {
			if packageRoot != paths.PackageRoot || dataDir != paths.DataDir {
				t.Fatalf("probe paths = %q, %q", packageRoot, dataDir)
			}
			return nil
		},
		DetectActivationState: func(packageRoot string) (ActivationState, error) {
			if packageRoot != paths.PackageRoot {
				t.Fatalf("activation package root = %q", packageRoot)
			}
			return LicenseGateRequired, nil
		},
		VerifyLocalLicense: func(packageRoot string, usbRoot string) (verifiedLicenseMaterial, error) {
			if packageRoot != paths.PackageRoot || usbRoot != paths.USBRoot {
				t.Fatalf("license paths = %q, %q", packageRoot, usbRoot)
			}
			return verifiedLicenseMaterial{}, nil
		},
		VerifyOnlineLicense: func(verifiedLicenseMaterial) error { return nil },
		EnsureHostCache: func(cacheRoot string) error {
			if cacheRoot != paths.HostCacheRoot {
				t.Fatalf("host cache root = %q", cacheRoot)
			}
			return nil
		},
		AcquireInstanceLock: func(dataDir string) (InstanceLock, error) {
			if dataDir != paths.DataDir {
				t.Fatalf("lock path = %q", dataDir)
			}
			return lock, nil
		},
		EnforceRelease: func(_ context.Context, progress func(State)) (requiredReleaseResult, error) {
			progress(StateCheckingVersion)
			return requiredReleaseResult{
				Manifest: manifest, RuntimePath: filepath.Join(paths.CacheRoot, runtimeInstallName(manifest)),
			}, nil
		},
		RestartBootstrap: func() error { return errors.New("unexpected bootstrap restart") },
		AcquireRuntime: func(root string, got Manifest) (RuntimeLease, error) {
			if root != filepath.Join(paths.CacheRoot, runtimeInstallName(manifest)) || !reflect.DeepEqual(got, manifest) {
				t.Fatalf("runtime lease inputs differ")
			}
			return lease, nil
		},
		StartProcess: func(spec ProcessSpec) (ChildProcess, error) {
			startedSpec = spec
			return &fakeChildProcess{}, nil
		},
		ActivationProcessSpec: ActivationProcessSpec,
		ReadUSBFingerprint: func(string) (usbFingerprint, error) {
			return usbFingerprint{Scheme: "uclaw-usb-v1", SHA256: strings.Repeat("a", 64)}, nil
		},
		MonitorUSB: func(ctx context.Context, _ string, _ time.Duration) error {
			<-ctx.Done()
			return ctx.Err()
		},
	}, lock, &startedSpec
}

func TestRunOrdersLocalReleaseOnlineLicenseThenShell(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	events := []string{}
	deps.ProbeDataDirectory = func(string, string) error { events = append(events, "usb"); return nil }
	deps.DetectActivationState = func(string) (ActivationState, error) {
		events = append(events, "classify")
		return LicenseGateRequired, nil
	}
	deps.VerifyLocalLicense = func(string, string) (verifiedLicenseMaterial, error) {
		events = append(events, "local-license")
		return verifiedLicenseMaterial{DeviceID: "device-1"}, nil
	}
	deps.EnsureHostCache = func(string) error { events = append(events, "host-cache"); return nil }
	deps.EnforceRelease = func(context.Context, func(State)) (requiredReleaseResult, error) {
		events = append(events, "online-release")
		manifest := validRuntimeManifest()
		return requiredReleaseResult{Manifest: manifest, RuntimePath: filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(manifest))}, nil
	}
	deps.VerifyOnlineLicense = func(material verifiedLicenseMaterial) error {
		if material.DeviceID != "device-1" {
			t.Fatalf("license material = %#v", material)
		}
		events = append(events, "online-license")
		return nil
	}
	deps.AcquireInstanceLock = func(string) (InstanceLock, error) { events = append(events, "lock"); return &fakeInstanceLock{}, nil }
	deps.AcquireRuntime = func(root string, manifest Manifest) (RuntimeLease, error) {
		events = append(events, "runtime")
		return &fakeRuntimeLease{root: root}, nil
	}
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		events = append(events, "shell")
		return &fakeChildProcess{}, nil
	}

	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	want := []string{"usb", "classify", "local-license", "host-cache", "online-release", "online-license", "lock", "runtime", "shell"}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("events = %v", events)
	}
}

func TestRunUpdatesUnactivatedDeviceBeforeActivationOnly(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.DetectActivationState = func(string) (ActivationState, error) { return ActivationRequired, nil }
	manifest := validRuntimeManifest()
	deps.EnforceRelease = func(context.Context, func(State)) (requiredReleaseResult, error) {
		return requiredReleaseResult{
			Manifest: manifest, RuntimePath: filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(manifest)), RestartRequired: true,
		}, nil
	}
	restarted := false
	deps.RestartBootstrap = func() error { restarted = true; return nil }
	started := false
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { started = true; return &fakeChildProcess{}, nil }

	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	if !restarted || started {
		t.Fatalf("restarted=%v activation started=%v", restarted, started)
	}
	if !slices.Contains(reporter.states, StateRestarting) {
		t.Fatalf("states = %v", reporter.states)
	}
}

func TestRunFailsClosedWhenReleaseServiceUnavailable(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.EnforceRelease = func(context.Context, func(State)) (requiredReleaseResult, error) {
		return requiredReleaseResult{}, ErrReleasePolicyUnavailable
	}
	onlineLicense, started := false, false
	deps.VerifyOnlineLicense = func(verifiedLicenseMaterial) error { onlineLicense = true; return nil }
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { started = true; return &fakeChildProcess{}, nil }

	if err := Run(context.Background(), deps); !errors.Is(err, ErrReleasePolicyUnavailable) {
		t.Fatalf("returned %v", err)
	}
	if onlineLicense || started {
		t.Fatalf("onlineLicense=%v shell=%v", onlineLicense, started)
	}
	if !reflect.DeepEqual(reporter.failures, [][2]string{{"E_RELEASE_POLICY_UNAVAILABLE", "无法确认必需版本，请检查网络后重试。"}}) {
		t.Fatalf("failures = %v", reporter.failures)
	}
}

func TestRunActivationCompletionRestartsFullGateOnce(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	activationExit := processExitError(t, "20")
	classifications := []ActivationState{ActivationRequired, LicenseGateRequired}
	probeCalls := 0
	classifyCalls := 0
	verifyCalls := 0
	activationSpecs := 0
	started := 0
	deps.ProbeDataDirectory = func(string, string) error { probeCalls++; return nil }
	deps.DetectActivationState = func(string) (ActivationState, error) {
		state := classifications[classifyCalls]
		classifyCalls++
		return state, nil
	}
	deps.VerifyLocalLicense = func(string, string) (verifiedLicenseMaterial, error) {
		verifyCalls++
		return verifiedLicenseMaterial{}, nil
	}
	deps.AcquireRuntime = func(root string, _ Manifest) (RuntimeLease, error) {
		return &fakeRuntimeLease{root: root}, nil
	}
	deps.ActivationProcessSpec = func(paths PortablePaths, manifest Manifest, lease RuntimeLease, fingerprint usbFingerprint) ProcessSpec {
		activationSpecs++
		return ActivationProcessSpec(paths, manifest, lease, fingerprint)
	}
	deps.StartProcess = func(spec ProcessSpec) (ChildProcess, error) {
		started++
		if started == 1 {
			if !slices.Contains(spec.Args, activationStartupArgument) {
				t.Fatalf("activation args = %v", spec.Args)
			}
			return &fakeChildProcess{waitErr: activationExit}, nil
		}
		if slices.Contains(spec.Args, activationStartupArgument) {
			t.Fatalf("normal args = %v", spec.Args)
		}
		if !slices.Contains(spec.Args, normalStartupArgument) {
			t.Fatalf("normal args = %v", spec.Args)
		}
		return &fakeChildProcess{}, nil
	}

	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	if probeCalls != 2 || classifyCalls != 2 || verifyCalls != 1 || activationSpecs != 1 || started != 2 {
		t.Fatalf("probe=%d classify=%d verify=%d activationSpecs=%d started=%d", probeCalls, classifyCalls, verifyCalls, activationSpecs, started)
	}
	wantPrefix := []State{StateStarting, StateValidatingUSB, StateActivationRequired, StateCheckingVersion, StateStartingActivation, StateStarting}
	if !reflect.DeepEqual(reporter.states[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("states = %v", reporter.states)
	}
}

func TestRunDoesNotStartActivationWhenUSBFingerprintCannotBeRead(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.DetectActivationState = func(string) (ActivationState, error) { return ActivationRequired, nil }
	deps.ReadUSBFingerprint = func(string) (usbFingerprint, error) { return usbFingerprint{}, errors.New("fingerprint unavailable") }
	started := false
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { started = true; return &fakeChildProcess{}, nil }

	err := Run(context.Background(), deps)
	if err == nil || !strings.Contains(err.Error(), "fingerprint unavailable") {
		t.Fatalf("Run() error = %v", err)
	}
	if started {
		t.Fatal("activation process started without a trusted USB fingerprint")
	}
}

func TestRunDoesNotLaunchActivationTwice(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	activationExit := processExitError(t, "20")
	classifyCalls := 0
	started := 0
	deps.DetectActivationState = func(string) (ActivationState, error) {
		classifyCalls++
		return ActivationRequired, nil
	}
	deps.AcquireRuntime = func(root string, _ Manifest) (RuntimeLease, error) {
		return &fakeRuntimeLease{root: root}, nil
	}
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		started++
		return &fakeChildProcess{waitErr: activationExit}, nil
	}

	err := Run(context.Background(), deps)
	if !errors.Is(err, ErrActivationRestartLimit) {
		t.Fatalf("returned %v", err)
	}
	if classifyCalls != 2 || started != 1 {
		t.Fatalf("classify=%d started=%d", classifyCalls, started)
	}
	want := [][2]string{{"E_ACTIVATION_RESTART_LIMIT", "激活完成后授权仍未生效，请重新启动 U-Claw。"}}
	if !reflect.DeepEqual(reporter.failures, want) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
}

func TestRunDoesNotRestartAfterOtherActivationExit(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	activationExit := processExitError(t, "21")
	classifyCalls := 0
	deps.DetectActivationState = func(string) (ActivationState, error) {
		classifyCalls++
		return ActivationRequired, nil
	}
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		return &fakeChildProcess{waitErr: activationExit}, nil
	}

	err := Run(context.Background(), deps)
	if !errors.Is(err, ErrActivationExited) {
		t.Fatalf("returned %v", err)
	}
	if classifyCalls != 1 {
		t.Fatalf("classify calls = %d", classifyCalls)
	}
	want := [][2]string{{"E_ACTIVATION_EXITED", "激活窗口意外退出，请重新启动 U-Claw。"}}
	if !reflect.DeepEqual(reporter.failures, want) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
}

func TestRunStopsActivationOnCancellationAndClosesLeaseOnce(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	lease := &fakeRuntimeLease{root: filepath.Join(t.TempDir(), "runtime")}
	process := &blockingChildProcess{result: make(chan error, 1)}
	deps.DetectActivationState = func(string) (ActivationState, error) { return ActivationRequired, nil }
	deps.AcquireRuntime = func(string, Manifest) (RuntimeLease, error) { return lease, nil }
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return process, nil }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := Run(ctx, deps)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("returned %v", err)
	}
	if !process.stopped || lease.CloseCalls() != 1 {
		t.Fatalf("stopped=%v lease closes=%d", process.stopped, lease.CloseCalls())
	}
	if len(reporter.failures) != 0 {
		t.Fatalf("failures = %v", reporter.failures)
	}
}

func TestRunStopsActivationWhenUSBIsRemovedAndClosesLeaseOnce(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	lease := &fakeRuntimeLease{root: filepath.Join(t.TempDir(), "runtime")}
	process := &blockingChildProcess{result: make(chan error, 1)}
	deps.DetectActivationState = func(string) (ActivationState, error) { return ActivationRequired, nil }
	deps.AcquireRuntime = func(string, Manifest) (RuntimeLease, error) { return lease, nil }
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return process, nil }
	deps.MonitorUSB = func(context.Context, string, time.Duration) error { return ErrUSBDisconnected }

	err := Run(context.Background(), deps)
	if !errors.Is(err, ErrUSBDisconnected) {
		t.Fatalf("returned %v", err)
	}
	if !process.stopped || lease.CloseCalls() != 1 {
		t.Fatalf("stopped=%v lease closes=%d", process.stopped, lease.CloseCalls())
	}
	want := [][2]string{{"E_USB_DISCONNECTED", "U 盘已断开，请重新插入后再启动。"}}
	if !reflect.DeepEqual(reporter.failures, want) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
}

func TestRunReportsVersionAndLicenseGateSequence(t *testing.T) {
	reporter := &recordingReporter{}
	deps, lock, startedSpec := successfulDependencies(t, reporter)
	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	wantStates := []State{
		StateStarting,
		StateValidatingUSB,
		StateValidatingLicense,
		StateCheckingVersion,
		StateValidatingOnline,
		StateStartingApp,
		StateReady,
	}
	if !reflect.DeepEqual(reporter.states, wantStates) {
		t.Fatalf("states = %v", reporter.states)
	}
	if !reporter.closed || !lock.closed {
		t.Fatalf("cleanup reporter=%v lock=%v", reporter.closed, lock.closed)
	}
	wantEntrypoint := filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(validRuntimeManifest()), "electron", "electron.exe")
	if startedSpec.Path != wantEntrypoint || startedSpec.Dir != filepath.Dir(wantEntrypoint) {
		t.Fatalf("process path/dir = %q, %q", startedSpec.Path, startedSpec.Dir)
	}
	if startedSpec.Lease == nil || startedSpec.Lease.RootPath() != filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(validRuntimeManifest())) {
		t.Fatalf("process lease = %#v", startedSpec.Lease)
	}
	if startedSpec.Lease.(*fakeRuntimeLease).CloseCalls() != 1 {
		t.Fatalf("lease close calls = %d", startedSpec.Lease.(*fakeRuntimeLease).CloseCalls())
	}
	wantEnv := []string{
		"NODE_COMPILE_CACHE=" + filepath.Join(deps.Paths.HostCacheRoot, "cache", "node-compile"),
		"OPENCLAW_CONFIG_PATH=" + filepath.Join(deps.Paths.DataDir, ".openclaw", "openclaw.json"),
		"OPENCLAW_HOME=" + deps.Paths.DataDir,
		"OPENCLAW_STATE_DIR=" + filepath.Join(deps.Paths.DataDir, ".openclaw"),
		"TEMP=" + filepath.Join(deps.Paths.HostCacheRoot, "cache", "temp"),
		"TMP=" + filepath.Join(deps.Paths.HostCacheRoot, "cache", "temp"),
		"UCLAW_CACHE_DIR=" + filepath.Join(deps.Paths.HostCacheRoot, "cache"),
		"UCLAW_DATA_DIR=" + deps.Paths.DataDir,
		"UCLAW_RELEASE_BASE_URL=",
		"UCLAW_RELEASE_REVOKED_KEY_IDS=[]",
		"UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS={}",
		"UCLAW_RUNTIME_DIR=" + filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(validRuntimeManifest())),
	}
	if !reflect.DeepEqual(startedSpec.Env, wantEnv) {
		t.Fatalf("process env = %v", startedSpec.Env)
	}
}

func TestRunAcquiresRuntimeLeaseBeforeStart(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	manifest := validRuntimeManifest()
	manifest.Entrypoint = `electron\electron.exe`
	lease := &fakeRuntimeLease{root: filepath.Join(t.TempDir(), "leased-runtime")}
	var events []string
	deps.EnforceRelease = func(context.Context, func(State)) (requiredReleaseResult, error) {
		events = append(events, "release")
		return requiredReleaseResult{Manifest: manifest, RuntimePath: filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(manifest))}, nil
	}
	deps.AcquireRuntime = func(root string, got Manifest) (RuntimeLease, error) {
		events = append(events, "acquire")
		if root != filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(manifest)) || !reflect.DeepEqual(got, manifest) {
			t.Fatalf("acquire inputs differ")
		}
		return lease, nil
	}
	deps.StartProcess = func(spec ProcessSpec) (ChildProcess, error) {
		events = append(events, "start")
		if spec.Lease != lease {
			t.Fatalf("process lease = %#v", spec.Lease)
		}
		want := filepath.Join(lease.RootPath(), "electron", "electron.exe")
		if spec.Path != want || spec.Dir != filepath.Dir(want) {
			t.Fatalf("process path/dir = %q, %q", spec.Path, spec.Dir)
		}
		return &fakeChildProcess{}, nil
	}

	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(events, []string{"release", "acquire", "start"}) {
		t.Fatalf("events = %v", events)
	}
	if lease.CloseCalls() != 1 {
		t.Fatalf("lease close calls = %d", lease.CloseCalls())
	}
}

func TestRunRejectsRuntimeLeaseFailure(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	acquireErr := errors.Join(ErrPackageInvalid, errors.New("runtime changed"))
	deps.AcquireRuntime = func(string, Manifest) (RuntimeLease, error) {
		return nil, acquireErr
	}
	started := false
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		started = true
		return &fakeChildProcess{}, nil
	}

	if err := Run(context.Background(), deps); !errors.Is(err, ErrPackageInvalid) {
		t.Fatalf("returned %v", err)
	}
	if started {
		t.Fatal("process started")
	}
	want := [][2]string{{"E_PACKAGE_INVALID", "运行时文件校验失败，请重新下载 U-Claw。"}}
	if !reflect.DeepEqual(reporter.failures, want) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
}

func TestRunClosesRuntimeLeaseOnRepresentativeExitPaths(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(context.Context, context.CancelFunc, *Dependencies)
	}{
		{
			name: "start failure",
			run: func(_ context.Context, _ context.CancelFunc, deps *Dependencies) {
				deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
					return nil, errors.New("start failed")
				}
			},
		},
		{
			name: "normal exit",
			run:  func(_ context.Context, _ context.CancelFunc, _ *Dependencies) {},
		},
		{
			name: "cancellation",
			run: func(_ context.Context, cancel context.CancelFunc, deps *Dependencies) {
				process := &blockingChildProcess{result: make(chan error, 1)}
				deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return process, nil }
				deps.MonitorUSB = func(ctx context.Context, _ string, _ time.Duration) error {
					cancel()
					<-ctx.Done()
					return ctx.Err()
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			reporter := &recordingReporter{}
			deps, _, _ := successfulDependencies(t, reporter)
			lease := &fakeRuntimeLease{root: filepath.Join(t.TempDir(), "runtime")}
			deps.AcquireRuntime = func(string, Manifest) (RuntimeLease, error) { return lease, nil }
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			test.run(ctx, cancel, &deps)

			_ = Run(ctx, deps)
			if lease.CloseCalls() != 1 {
				t.Fatalf("lease close calls = %d", lease.CloseCalls())
			}
		})
	}
}

func TestRunLaunchesAlreadyRequiredRuntimeWithoutUpdateStates(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	wantStates := []State{StateStarting, StateValidatingUSB, StateValidatingLicense, StateCheckingVersion, StateValidatingOnline, StateStartingApp, StateReady}
	if !reflect.DeepEqual(reporter.states, wantStates) {
		t.Fatalf("states = %v", reporter.states)
	}
}

func TestRunMapsFailureWithoutLeakingSensitiveDetails(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	secret := `C:\Users\private-user\.uclaw token=secret message=private`
	deps.AcquireInstanceLock = func(string) (InstanceLock, error) {
		return nil, errors.Join(ErrInstanceRunning, errors.New(secret))
	}
	err := Run(context.Background(), deps)
	if !errors.Is(err, ErrInstanceRunning) {
		t.Fatalf("returned %v", err)
	}
	want := [][2]string{{"E_INSTANCE_RUNNING", "U-Claw 已在使用这个 U 盘数据目录。"}}
	if !reflect.DeepEqual(reporter.failures, want) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
	if !reporter.closed {
		t.Fatal("reporter was not closed")
	}
}

func TestRunRejectsLicenseBeforeLockOrRuntimeWork(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	locked := false
	releaseChecked := false
	started := false
	deps.VerifyLocalLicense = func(packageRoot string, usbRoot string) (verifiedLicenseMaterial, error) {
		if packageRoot != deps.Paths.PackageRoot || usbRoot != deps.Paths.USBRoot {
			t.Fatalf("license paths = %q, %q", packageRoot, usbRoot)
		}
		return verifiedLicenseMaterial{}, errors.Join(ErrStartupSecretInvalid, errors.New("secret=must-not-leak device=dev_private"))
	}
	deps.AcquireInstanceLock = func(string) (InstanceLock, error) {
		locked = true
		return &fakeInstanceLock{}, nil
	}
	deps.EnforceRelease = func(context.Context, func(State)) (requiredReleaseResult, error) {
		releaseChecked = true
		return requiredReleaseResult{}, nil
	}
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		started = true
		return &fakeChildProcess{}, nil
	}

	err := Run(context.Background(), deps)
	if !errors.Is(err, ErrStartupSecretInvalid) {
		t.Fatalf("returned %v", err)
	}
	if locked || releaseChecked || started {
		t.Fatalf("post-license work ran: lock=%v release=%v start=%v", locked, releaseChecked, started)
	}
	wantStates := []State{StateStarting, StateValidatingUSB, StateValidatingLicense}
	if !reflect.DeepEqual(reporter.states, wantStates) {
		t.Fatalf("states = %v", reporter.states)
	}
	wantFailures := [][2]string{{"E_LICENSE_SECRET_INVALID", "启动授权凭据无效，请联系服务人员。"}}
	if !reflect.DeepEqual(reporter.failures, wantFailures) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
}

func TestLifecycleFailuresHaveDistinctFixedDiagnostics(t *testing.T) {
	tests := []struct {
		err  error
		code string
	}{
		{ErrLicenseStatusUnavailable, "E_LICENSE_STATUS_UNAVAILABLE"},
		{ErrLicenseStatusAuthentication, "E_LICENSE_STATUS_AUTH_FAILED"},
		{ErrLicenseStatusResponseInvalid, "E_LICENSE_STATUS_INVALID"},
		{ErrLicenseStatusReceiptInvalid, "E_LICENSE_STATUS_SIGNATURE_INVALID"},
		{ErrLicenseStatusDeviceMismatch, "E_LICENSE_STATUS_DEVICE_MISMATCH"},
		{ErrLicenseStatusLicenseMismatch, "E_LICENSE_STATUS_LICENSE_MISMATCH"},
		{ErrLicenseOfflineCacheMissing, "E_LICENSE_OFFLINE_FIRST_START"},
		{ErrLicenseOfflineCacheInvalid, "E_LICENSE_CACHE_INVALID"},
		{ErrLicenseClockRollback, "E_LICENSE_CLOCK_ROLLBACK"},
		{ErrLicenseOfflineGraceExpired, "E_LICENSE_OFFLINE_GRACE_EXPIRED"},
		{ErrLicenseProvisioning, "E_LICENSE_PROVISIONING"},
		{ErrLicenseRevoked, "E_LICENSE_REVOKED"},
		{ErrLicenseReissued, "E_LICENSE_REISSUED"},
		{ErrLicenseDisabled, "E_LICENSE_DISABLED"},
	}
	for _, test := range tests {
		code, message := diagnosticFor(errors.Join(test.err, errors.New("Authorization: Bearer private-secret C:\\private")))
		if code != test.code || message == "" || strings.Contains(message, "private") || strings.Contains(message, "Authorization") {
			t.Fatalf("%v => %q %q", test.err, code, message)
		}
	}
}

func TestRunStopsBeforeRuntimeWhenHostCacheOwnershipFails(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.EnsureHostCache = func(string) error { return ErrCachePreparationFailed }
	releaseChecked := false
	started := false
	deps.EnforceRelease = func(context.Context, func(State)) (requiredReleaseResult, error) {
		releaseChecked = true
		return requiredReleaseResult{}, nil
	}
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		started = true
		return &fakeChildProcess{}, nil
	}

	if err := Run(context.Background(), deps); !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("returned %v", err)
	}
	if releaseChecked || started {
		t.Fatalf("releaseChecked=%v started=%v", releaseChecked, started)
	}
	if !reflect.DeepEqual(reporter.failures, [][2]string{{"E_CACHE_FAILED", "无法准备本机运行缓存，请检查磁盘空间。"}}) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
}

func TestRunStopsProcessWhenUSBDisconnects(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	process := &blockingChildProcess{result: make(chan error, 1)}
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return process, nil }
	deps.MonitorUSB = func(context.Context, string, time.Duration) error { return ErrUSBDisconnected }

	err := Run(context.Background(), deps)
	if !errors.Is(err, ErrUSBDisconnected) {
		t.Fatalf("returned %v", err)
	}
	if !process.stopped {
		t.Fatal("process was not stopped")
	}
	want := [][2]string{{"E_USB_DISCONNECTED", "U 盘已断开，请重新插入后再启动。"}}
	if !reflect.DeepEqual(reporter.failures, want) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
}

func TestRunCancellationStopsProcessWithoutFailureDialog(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	process := &blockingChildProcess{result: make(chan error, 1)}
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return process, nil }
	ctx, cancel := context.WithCancel(context.Background())
	deps.MonitorUSB = func(ctx context.Context, _ string, _ time.Duration) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}

	err := Run(ctx, deps)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("returned %v", err)
	}
	if !process.stopped || len(reporter.failures) != 0 {
		t.Fatalf("stopped=%v failures=%v", process.stopped, reporter.failures)
	}
}

func TestRunMapsProcessStartErrors(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		return nil, errors.New("CreateProcess failed at C:\\private")
	}
	if err := Run(context.Background(), deps); err == nil {
		t.Fatal("process start failure was ignored")
	}
	want := [][2]string{{"E_APP_START_FAILED", "无法启动 U-Claw，请重新启动。"}}
	if !reflect.DeepEqual(reporter.failures, want) {
		t.Fatalf("failures = %#v", reporter.failures)
	}
}

func TestRunJoinsRuntimeLeaseCloseErrorWhenStartFails(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	startErr := errors.New("start failed")
	closeErr := errors.New("lease close failed")
	lease := &fakeRuntimeLease{root: filepath.Join(t.TempDir(), "runtime"), closeErr: closeErr}
	deps.AcquireRuntime = func(string, Manifest) (RuntimeLease, error) { return lease, nil }
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return nil, startErr }

	err := Run(context.Background(), deps)
	if !errors.Is(err, ErrAppStartFailed) || !errors.Is(err, startErr) || !errors.Is(err, closeErr) {
		t.Fatalf("returned %v", err)
	}
	if lease.CloseCalls() != 1 {
		t.Fatalf("lease close calls = %d", lease.CloseCalls())
	}
}

func TestRunPropagatesRuntimeLeaseCloseErrorAfterWait(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	closeErr := errors.New("lease close failed")
	lease := &fakeRuntimeLease{root: filepath.Join(t.TempDir(), "runtime"), closeErr: closeErr}
	deps.AcquireRuntime = func(string, Manifest) (RuntimeLease, error) { return lease, nil }

	err := Run(context.Background(), deps)
	if !errors.Is(err, ErrAppExited) || !errors.Is(err, closeErr) {
		t.Fatalf("returned %v", err)
	}
	if lease.CloseCalls() != 1 {
		t.Fatalf("lease close calls = %d", lease.CloseCalls())
	}
}

func TestRunPropagatesRuntimeLeaseCloseErrorAfterStopAndWait(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	closeErr := errors.New("lease close failed")
	lease := &fakeRuntimeLease{root: filepath.Join(t.TempDir(), "runtime"), closeErr: closeErr}
	process := &blockingChildProcess{result: make(chan error, 1)}
	deps.AcquireRuntime = func(string, Manifest) (RuntimeLease, error) { return lease, nil }
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return process, nil }
	ctx, cancel := context.WithCancel(context.Background())
	deps.MonitorUSB = func(ctx context.Context, _ string, _ time.Duration) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}

	err := Run(ctx, deps)
	if !errors.Is(err, ErrAppExited) || !errors.Is(err, closeErr) {
		t.Fatalf("returned %v", err)
	}
	if lease.CloseCalls() != 1 {
		t.Fatalf("lease close calls = %d", lease.CloseCalls())
	}
}

func TestRunDoesNotRollbackWhenRequiredRuntimeExitsBeforeReadiness(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.StartupGrace = time.Second
	starts := 0
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		starts++
		return &fakeChildProcess{waitErr: errors.New("runtime initialization failed")}, nil
	}

	if err := Run(context.Background(), deps); !errors.Is(err, ErrAppExited) {
		t.Fatalf("returned %v", err)
	}
	if starts != 1 {
		t.Fatalf("required runtime starts = %d", starts)
	}
}

func TestRunFailedShellQueriesHigherSequenceWithoutStartingOldRuntime(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.StartupGrace = time.Second
	deps.RepairPollInterval = time.Millisecond
	first := validRuntimeManifest()
	second := first
	second.ReleaseSequence++
	second.ReleaseID = "release-43"
	second.Signature = &ManifestSignature{Sequence: second.ReleaseSequence, Value: "repair-signature"}
	checks := 0
	deps.EnforceRelease = func(context.Context, func(State)) (requiredReleaseResult, error) {
		checks++
		if checks == 1 {
			return requiredReleaseResult{Manifest: first, RuntimePath: filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(first))}, nil
		}
		return requiredReleaseResult{
			Manifest: second, RuntimePath: filepath.Join(deps.Paths.CacheRoot, runtimeInstallName(second)), RestartRequired: true,
		}, nil
	}
	starts := 0
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		starts++
		return &fakeChildProcess{waitErr: errors.New("required shell failed")}, nil
	}
	restarts := 0
	deps.RestartBootstrap = func() error { restarts++; return nil }

	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	if checks != 2 || starts != 1 || restarts != 1 {
		t.Fatalf("checks=%d starts=%d restarts=%d", checks, starts, restarts)
	}
}

func TestStateTextUsesFixedChineseStatus(t *testing.T) {
	want := map[State]string{
		StateStarting:           "正在启动 U-Claw...",
		StateActivationRequired: "需要先激活 U-Claw。",
		StateStartingActivation: "正在打开激活窗口...",
		StateValidatingUSB:      "正在检查 U 盘数据目录...",
		StateValidatingLicense:  "正在验证启动授权...",
		StateCheckingVersion:    "正在检查版本...",
		StateDownloadingUpdate:  "正在下载更新...",
		StateVerifyingUpdate:    "正在验证更新...",
		StateInstallingUpdate:   "正在安装更新...",
		StateRestarting:         "正在重启 U-Claw...",
		StateValidatingOnline:   "正在确认许可证在线状态...",
		StateStartingApp:        "正在打开 U-Claw...",
		StateReady:              "U-Claw 已就绪。",
	}
	for state, text := range want {
		if got := stateText(state); got != text {
			t.Fatalf("state %s text = %q", state, got)
		}
	}
}

func TestPortableProcessEnvironmentInjectsImmutableReleaseConfiguration(t *testing.T) {
	previousKeys, previousRevoked, previousFeed := trustedRuntimeKeys, revokedRuntimeKeyIDs, releaseFeedBaseURL
	trustedRuntimeKeys = `{"release-2026":"fixture-public-key"}`
	revokedRuntimeKeyIDs = `["release-old"]`
	releaseFeedBaseURL = "https://updates.example.test/releases/"
	t.Cleanup(func() {
		trustedRuntimeKeys, revokedRuntimeKeyIDs, releaseFeedBaseURL = previousKeys, previousRevoked, previousFeed
	})

	environment := portableProcessEnvironment(PortablePaths{DataDir: `E:\.uclaw\data`, HostCacheRoot: `C:\U-Claw`})
	for _, expected := range []string{
		`UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS={"release-2026":"fixture-public-key"}`,
		`UCLAW_RELEASE_REVOKED_KEY_IDS=["release-old"]`,
		`UCLAW_RELEASE_BASE_URL=https://updates.example.test/releases/`,
	} {
		if !containsString(environment, expected) {
			t.Fatalf("release environment missing %q: %v", expected, environment)
		}
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestDiagnosticMapsExtractionFailureToCacheFailure(t *testing.T) {
	code, message := diagnosticFor(ErrExtractionFailed)
	if code != "E_CACHE_FAILED" || message != "无法准备本机运行缓存，请检查磁盘空间。" {
		t.Fatalf("diagnostic = %q, %q", code, message)
	}
}

func TestDiagnosticMapsLicenseFailuresWithoutSensitiveDetails(t *testing.T) {
	tests := []struct {
		err  error
		code string
	}{
		{ErrStartupCredentialMissing, "E_LICENSE_CREDENTIAL_MISSING"},
		{ErrStartupSecretMissing, "E_LICENSE_SECRET_MISSING"},
		{ErrStartupSecretInvalid, "E_LICENSE_SECRET_INVALID"},
		{ErrLicenseFileMissing, "E_LICENSE_FILE_MISSING"},
		{ErrLicenseFileUnsafe, "E_LICENSE_FILE_UNSAFE"},
		{ErrLicenseFormatInvalid, "E_LICENSE_FORMAT_INVALID"},
		{ErrLicenseTrustUnavailable, "E_LICENSE_TRUST_UNAVAILABLE"},
		{ErrLicenseSignatureInvalid, "E_LICENSE_SIGNATURE_INVALID"},
		{ErrLicenseDeviceMismatch, "E_LICENSE_DEVICE_MISMATCH"},
		{ErrLicenseIDMismatch, "E_LICENSE_ID_MISMATCH"},
		{ErrLicenseUSBIdentityUnavailable, "E_LICENSE_USB_ID_UNAVAILABLE"},
		{ErrLicenseFingerprintMismatch, "E_LICENSE_USB_MISMATCH"},
		{ErrLicenseNotYetValid, "E_LICENSE_NOT_YET_VALID"},
		{ErrLicenseExpired, "E_LICENSE_EXPIRED"},
	}
	for _, test := range tests {
		code, message := diagnosticFor(errors.Join(test.err, errors.New(`C:\Users\private secret=value dev_private`)))
		if code != test.code || message == "" || strings.Contains(message, "private") || strings.Contains(message, "secret") {
			t.Fatalf("%v diagnostic = %q, %q", test.err, code, message)
		}
	}
}
