package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"
)

type State string

const (
	StateStarting          State = "STARTING"
	StateValidatingUSB     State = "VALIDATING_USB"
	StateCheckingRuntime   State = "CHECKING_RUNTIME"
	StateExtractingRuntime State = "EXTRACTING_RUNTIME"
	StateStartingApp       State = "STARTING_APP"
	StateReady             State = "READY"
)

func stateText(state State) string {
	switch state {
	case StateStarting:
		return "正在启动 U-Claw..."
	case StateValidatingUSB:
		return "正在检查 U 盘数据目录..."
	case StateCheckingRuntime:
		return "正在检查运行环境..."
	case StateExtractingRuntime:
		return "首次启动，正在准备运行环境..."
	case StateStartingApp:
		return "正在打开 U-Claw..."
	case StateReady:
		return "U-Claw 已就绪。"
	default:
		return "正在启动 U-Claw..."
	}
}

type Reporter interface {
	State(State)
	Fail(code string, message string)
	Close()
}

type ChildProcess interface {
	Wait() error
	Stop() error
}

type Dependencies struct {
	Paths               PortablePaths
	Reporter            Reporter
	USBInterval         time.Duration
	StartupGrace        time.Duration
	ProcessStopTimeout  time.Duration
	ReadManifest        func(path string) (Manifest, error)
	ProbeDataDirectory  func(packageRoot string, dataDir string) error
	EnsureHostCache     func(cacheRoot string) error
	AcquireInstanceLock func(dataDir string) (InstanceLock, error)
	PrepareRuntime      func(context.Context, string, string, Manifest, func()) (CacheResult, error)
	CheckSequence       func(string, Manifest) error
	AcceptSequence      func(string, Manifest) error
	FinalizeUpdate      func(string, Manifest) error
	StartProcess        func(ProcessSpec) (ChildProcess, error)
	MonitorUSB          func(context.Context, string, time.Duration) error
}

func Run(ctx context.Context, deps Dependencies) error {
	reporter := deps.Reporter
	defer reporter.Close()
	reporter.State(StateStarting)

	reporter.State(StateValidatingUSB)
	if err := deps.ProbeDataDirectory(deps.Paths.PackageRoot, deps.Paths.DataDir); err != nil {
		return reportFailure(reporter, err)
	}
	lock, err := deps.AcquireInstanceLock(deps.Paths.DataDir)
	if err != nil {
		return reportFailure(reporter, err)
	}
	defer lock.Close()
	if err := deps.EnsureHostCache(deps.Paths.HostCacheRoot); err != nil {
		return reportFailure(reporter, err)
	}

	reporter.State(StateCheckingRuntime)
	manifest, err := deps.ReadManifest(filepath.Join(deps.Paths.PackageRoot, "version.json"))
	if err != nil {
		return reportFailure(reporter, err)
	}
	if err := deps.CheckSequence(deps.Paths.HostCacheRoot, manifest); err != nil {
		return reportFailure(reporter, err)
	}
	cache, err := deps.PrepareRuntime(
		ctx,
		deps.Paths.CacheRoot,
		deps.Paths.PackageRoot,
		manifest,
		func() { reporter.State(StateExtractingRuntime) },
	)
	if err != nil {
		return reportFailure(reporter, err)
	}
	reporter.State(StateStartingApp)
	entrypoint := filepath.Join(cache.Path, filepath.FromSlash(strings.ReplaceAll(manifest.Entrypoint, `\`, "/")))
	process, err := deps.StartProcess(ProcessSpec{
		Path: entrypoint,
		Args: append([]string(nil), manifest.EntryArgs...),
		Dir:  filepath.Dir(entrypoint),
		Env:  append(portableProcessEnvironment(deps.Paths), "UCLAW_RUNTIME_DIR="+cache.Path),
	})
	if err != nil {
		return reportFailure(reporter, errors.Join(ErrAppStartFailed, err))
	}
	waitResult := make(chan error, 1)
	go func() { waitResult <- process.Wait() }()
	if deps.StartupGrace > 0 {
		grace := time.NewTimer(deps.StartupGrace)
		select {
		case err := <-waitResult:
			grace.Stop()
			return reportFailure(reporter, errors.Join(ErrAppExited, err))
		case <-grace.C:
			select {
			case err := <-waitResult:
				return reportFailure(reporter, errors.Join(ErrAppExited, err))
			default:
			}
		case <-ctx.Done():
			if cleanupErr := stopAndWait(process, waitResult, deps.ProcessStopTimeout); cleanupErr != nil {
				return reportFailure(reporter, errors.Join(ErrAppExited, cleanupErr))
			}
			return ctx.Err()
		}
	}
	if err := deps.AcceptSequence(deps.Paths.HostCacheRoot, manifest); err != nil {
		return reportFailure(reporter, errors.Join(err, stopAndWait(process, waitResult, deps.ProcessStopTimeout)))
	}
	if err := deps.FinalizeUpdate(deps.Paths.PackageRoot, manifest); err != nil {
		return reportFailure(reporter, errors.Join(err, stopAndWait(process, waitResult, deps.ProcessStopTimeout)))
	}
	reporter.State(StateReady)

	monitorCtx, cancelMonitor := context.WithCancel(ctx)
	defer cancelMonitor()
	usbResult := make(chan error, 1)
	go func() { usbResult <- deps.MonitorUSB(monitorCtx, deps.Paths.USBRoot, deps.USBInterval) }()

	select {
	case err := <-waitResult:
		if err != nil {
			return reportFailure(reporter, errors.Join(ErrAppExited, err))
		}
		return nil
	case err := <-usbResult:
		if ctx.Err() != nil {
			if cleanupErr := stopAndWait(process, waitResult, deps.ProcessStopTimeout); cleanupErr != nil {
				return reportFailure(reporter, errors.Join(ErrAppExited, cleanupErr))
			}
			return ctx.Err()
		}
		return reportFailure(reporter, errors.Join(err, stopAndWait(process, waitResult, deps.ProcessStopTimeout)))
	case <-ctx.Done():
		if cleanupErr := stopAndWait(process, waitResult, deps.ProcessStopTimeout); cleanupErr != nil {
			return reportFailure(reporter, errors.Join(ErrAppExited, cleanupErr))
		}
		return ctx.Err()
	}
}

func stopAndWait(process ChildProcess, waitResult <-chan error, timeout time.Duration) error {
	if err := process.Stop(); err != nil {
		return err
	}
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-waitResult:
		return nil
	case <-timer.C:
		return ErrProcessStopFailed
	}
}

func portableProcessEnvironment(paths PortablePaths) []string {
	stateDir := filepath.Join(paths.DataDir, ".openclaw")
	return []string{
		"NODE_COMPILE_CACHE=" + filepath.Join(paths.HostCacheRoot, "cache", "node-compile"),
		"OPENCLAW_CONFIG_PATH=" + filepath.Join(stateDir, "openclaw.json"),
		"OPENCLAW_HOME=" + paths.DataDir,
		"OPENCLAW_STATE_DIR=" + stateDir,
		"TEMP=" + filepath.Join(paths.HostCacheRoot, "cache", "temp"),
		"TMP=" + filepath.Join(paths.HostCacheRoot, "cache", "temp"),
		"UCLAW_CACHE_DIR=" + filepath.Join(paths.HostCacheRoot, "cache"),
		"UCLAW_DATA_DIR=" + paths.DataDir,
	}
}

var (
	ErrAppStartFailed    = errors.New("application start failed")
	ErrAppExited         = errors.New("application exited unexpectedly")
	ErrProcessStopFailed = errors.New("application stop failed")
)

func reportFailure(reporter Reporter, err error) error {
	code, message := diagnosticFor(err)
	reporter.Fail(code, message)
	return err
}

func diagnosticFor(err error) (string, string) {
	switch {
	case errors.Is(err, ErrInstanceRunning):
		return "E_INSTANCE_RUNNING", "U-Claw 已在使用这个 U 盘数据目录。"
	case errors.Is(err, ErrUSBDisconnected):
		return "E_USB_DISCONNECTED", "U 盘已断开，请重新插入后再启动。"
	case errors.Is(err, ErrUSBNotWritable), errors.Is(err, ErrPortablePathInvalid):
		return "E_USB_UNAVAILABLE", "无法使用 U 盘数据目录，请检查连接和写入权限。"
	case errors.Is(err, ErrManifestInvalid):
		return "E_MANIFEST_INVALID", "运行时清单无效，请重新下载 U-Claw。"
	case errors.Is(err, ErrPackageInvalid):
		return "E_PACKAGE_INVALID", "运行时文件校验失败，请重新下载 U-Claw。"
	case errors.Is(err, ErrCachePreparationFailed), errors.Is(err, ErrExtractionFailed):
		return "E_CACHE_FAILED", "无法准备本机运行缓存，请检查磁盘空间。"
	case errors.Is(err, ErrAppStartFailed), errors.Is(err, ErrProcessInvalid):
		return "E_APP_START_FAILED", "无法启动 U-Claw，请重新启动。"
	case errors.Is(err, ErrAppExited):
		return "E_APP_EXITED", "U-Claw 意外退出，请重新启动。"
	default:
		return "E_INTERNAL", "U-Claw 启动失败，请重新启动。"
	}
}
