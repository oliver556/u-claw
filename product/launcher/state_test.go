package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
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
	manifest.RuntimeTreeSHA256 = digest

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
	lease := &fakeRuntimeLease{root: filepath.Join(paths.CacheRoot, manifest.RuntimeID)}
	var startedSpec ProcessSpec
	return Dependencies{
		Paths:              paths,
		Reporter:           reporter,
		USBInterval:        time.Hour,
		ProcessStopTimeout: time.Second,
		ReadManifest: func(path string) (Manifest, error) {
			if path != filepath.Join(paths.PackageRoot, "version.json") {
				t.Fatalf("manifest path = %q", path)
			}
			return manifest, nil
		},
		ProbeDataDirectory: func(packageRoot string, dataDir string) error {
			if packageRoot != paths.PackageRoot || dataDir != paths.DataDir {
				t.Fatalf("probe paths = %q, %q", packageRoot, dataDir)
			}
			return nil
		},
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
		PrepareRuntime: func(_ context.Context, cacheRoot string, packageRoot string, got Manifest, extracting func()) (CacheResult, error) {
			if cacheRoot != paths.CacheRoot || packageRoot != paths.PackageRoot || !reflect.DeepEqual(got, manifest) {
				t.Fatalf("runtime inputs differ")
			}
			extracting()
			return CacheResult{Path: filepath.Join(paths.CacheRoot, manifest.RuntimeID)}, nil
		},
		AcquireRuntime: func(root string, got Manifest) (RuntimeLease, error) {
			if root != filepath.Join(paths.CacheRoot, manifest.RuntimeID) || !reflect.DeepEqual(got, manifest) {
				t.Fatalf("runtime lease inputs differ")
			}
			return lease, nil
		},
		CheckSequence: func(cacheRoot string, got Manifest) error {
			if cacheRoot != paths.HostCacheRoot || !reflect.DeepEqual(got, manifest) {
				t.Fatalf("sequence preflight inputs differ")
			}
			return nil
		},
		AcceptSequence: func(cacheRoot string, got Manifest) error {
			if cacheRoot != paths.HostCacheRoot || !reflect.DeepEqual(got, manifest) {
				t.Fatalf("sequence inputs differ")
			}
			return nil
		},
		FinalizeUpdate: func(packageRoot string, got Manifest) error {
			if packageRoot != paths.PackageRoot || !reflect.DeepEqual(got, manifest) {
				t.Fatalf("update finalization inputs differ")
			}
			return nil
		},
		StartProcess: func(spec ProcessSpec) (ChildProcess, error) {
			startedSpec = spec
			return &fakeChildProcess{}, nil
		},
		MonitorUSB: func(ctx context.Context, _ string, _ time.Duration) error {
			<-ctx.Done()
			return ctx.Err()
		},
	}, lock, &startedSpec
}

func TestRunReportsExtractingLaunchSequence(t *testing.T) {
	reporter := &recordingReporter{}
	deps, lock, startedSpec := successfulDependencies(t, reporter)
	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	wantStates := []State{
		StateStarting,
		StateValidatingUSB,
		StateCheckingRuntime,
		StateExtractingRuntime,
		StateStartingApp,
		StateReady,
	}
	if !reflect.DeepEqual(reporter.states, wantStates) {
		t.Fatalf("states = %v", reporter.states)
	}
	if !reporter.closed || !lock.closed {
		t.Fatalf("cleanup reporter=%v lock=%v", reporter.closed, lock.closed)
	}
	wantEntrypoint := filepath.Join(deps.Paths.CacheRoot, validRuntimeManifest().RuntimeID, "electron", "electron.exe")
	if startedSpec.Path != wantEntrypoint || startedSpec.Dir != filepath.Dir(wantEntrypoint) {
		t.Fatalf("process path/dir = %q, %q", startedSpec.Path, startedSpec.Dir)
	}
	if startedSpec.Lease == nil || startedSpec.Lease.RootPath() != filepath.Join(deps.Paths.CacheRoot, validRuntimeManifest().RuntimeID) {
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
		"UCLAW_RUNTIME_DIR=" + filepath.Join(deps.Paths.CacheRoot, validRuntimeManifest().RuntimeID),
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
	deps.PrepareRuntime = func(context.Context, string, string, Manifest, func()) (CacheResult, error) {
		events = append(events, "prepare")
		return CacheResult{Path: filepath.Join(deps.Paths.CacheRoot, manifest.RuntimeID)}, nil
	}
	deps.AcquireRuntime = func(root string, got Manifest) (RuntimeLease, error) {
		events = append(events, "acquire")
		if root != filepath.Join(deps.Paths.CacheRoot, manifest.RuntimeID) || !reflect.DeepEqual(got, manifest) {
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
	if !reflect.DeepEqual(events, []string{"prepare", "acquire", "start"}) {
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

func TestRunSkipsExtractingStateForReusableRuntime(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.PrepareRuntime = func(_ context.Context, _ string, _ string, manifest Manifest, _ func()) (CacheResult, error) {
		return CacheResult{Path: filepath.Join(deps.Paths.CacheRoot, manifest.RuntimeID), Reused: true}, nil
	}
	if err := Run(context.Background(), deps); err != nil {
		t.Fatal(err)
	}
	wantStates := []State{StateStarting, StateValidatingUSB, StateCheckingRuntime, StateStartingApp, StateReady}
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

func TestRunStopsBeforeRuntimeWhenHostCacheOwnershipFails(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.EnsureHostCache = func(string) error { return ErrCachePreparationFailed }
	prepared := false
	started := false
	deps.PrepareRuntime = func(context.Context, string, string, Manifest, func()) (CacheResult, error) {
		prepared = true
		return CacheResult{}, nil
	}
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		started = true
		return &fakeChildProcess{}, nil
	}

	if err := Run(context.Background(), deps); !errors.Is(err, ErrCachePreparationFailed) {
		t.Fatalf("returned %v", err)
	}
	if prepared || started {
		t.Fatalf("prepared=%v started=%v", prepared, started)
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
	accepted := false
	finalized := false
	deps.AcceptSequence = func(string, Manifest) error { accepted = true; return nil }
	deps.FinalizeUpdate = func(string, Manifest) error { finalized = true; return nil }
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
	if accepted || finalized {
		t.Fatalf("failed process committed update: accepted=%v finalized=%v", accepted, finalized)
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

func TestRunPreservesUpdateWhenProcessExitsBeforeReadiness(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.StartupGrace = time.Second
	accepted := false
	finalized := false
	deps.AcceptSequence = func(string, Manifest) error { accepted = true; return nil }
	deps.FinalizeUpdate = func(string, Manifest) error { finalized = true; return nil }
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) {
		return &fakeChildProcess{waitErr: errors.New("runtime initialization failed")}, nil
	}

	if err := Run(context.Background(), deps); !errors.Is(err, ErrAppExited) {
		t.Fatalf("returned %v", err)
	}
	if accepted || finalized {
		t.Fatalf("early process exit committed update: accepted=%v finalized=%v", accepted, finalized)
	}
}

func TestRunDoesNotBlockWhenProcessStopFails(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	deps.AcceptSequence = func(string, Manifest) error { return ErrManifestInvalid }
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return &stopFailingChildProcess{}, nil }
	result := make(chan error, 1)
	go func() { result <- Run(context.Background(), deps) }()

	select {
	case err := <-result:
		if !errors.Is(err, ErrManifestInvalid) {
			t.Fatalf("returned %v", err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("launcher blocked after process stop failed")
	}
}

func TestRunKeepsRuntimeLeaseUntilWaitCompletesAfterStopFailure(t *testing.T) {
	reporter := &recordingReporter{}
	deps, _, _ := successfulDependencies(t, reporter)
	lease := &fakeRuntimeLease{root: filepath.Join(t.TempDir(), "runtime")}
	process := &releasableStopFailingChildProcess{result: make(chan error, 1)}
	deps.AcquireRuntime = func(string, Manifest) (RuntimeLease, error) { return lease, nil }
	deps.AcceptSequence = func(string, Manifest) error { return ErrManifestInvalid }
	deps.StartProcess = func(ProcessSpec) (ChildProcess, error) { return process, nil }

	result := make(chan error, 1)
	go func() { result <- Run(context.Background(), deps) }()
	select {
	case err := <-result:
		if !errors.Is(err, ErrManifestInvalid) {
			t.Fatalf("returned %v", err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("launcher blocked after process stop failed")
	}
	if lease.CloseCalls() != 0 {
		t.Fatalf("lease closed before wait completed: %d", lease.CloseCalls())
	}
	process.result <- nil
	deadline := time.Now().Add(time.Second)
	for lease.CloseCalls() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if lease.CloseCalls() != 1 {
		t.Fatalf("lease close calls = %d", lease.CloseCalls())
	}
}

func TestStateTextUsesFixedChineseStatus(t *testing.T) {
	want := map[State]string{
		StateStarting:          "正在启动 U-Claw...",
		StateValidatingUSB:     "正在检查 U 盘数据目录...",
		StateCheckingRuntime:   "正在检查运行环境...",
		StateExtractingRuntime: "首次启动，正在准备运行环境...",
		StateStartingApp:       "正在打开 U-Claw...",
		StateReady:             "U-Claw 已就绪。",
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
