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
	StateValidatingLicense State = "VALIDATING_LICENSE"
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
	case StateValidatingLicense:
		return "正在验证启动授权..."
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
	VerifyLicense       func(packageRoot string, usbRoot string) error
	EnsureHostCache     func(cacheRoot string) error
	AcquireInstanceLock func(dataDir string) (InstanceLock, error)
	PrepareRuntime      func(context.Context, string, string, Manifest, func()) (CacheResult, error)
	AcquireRuntime      func(string, Manifest) (RuntimeLease, error)
	CheckSequence       func(string, Manifest) error
	AcceptSequence      func(string, Manifest) error
	FinalizeUpdate      func(string, Manifest) error
	StartProcess        func(ProcessSpec) (ChildProcess, error)
	MonitorUSB          func(context.Context, string, time.Duration) error
}

type processWaitResult struct {
	processErr error
	leaseErr   error
}

func Run(ctx context.Context, deps Dependencies) error {
	reporter := deps.Reporter
	defer reporter.Close()
	reporter.State(StateStarting)

	reporter.State(StateValidatingUSB)
	if err := deps.ProbeDataDirectory(deps.Paths.PackageRoot, deps.Paths.DataDir); err != nil {
		return reportFailure(reporter, err)
	}
	reporter.State(StateValidatingLicense)
	if err := deps.VerifyLicense(deps.Paths.PackageRoot, deps.Paths.USBRoot); err != nil {
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
	lease, err := deps.AcquireRuntime(cache.Path, manifest)
	if err != nil {
		return reportFailure(reporter, err)
	}
	reporter.State(StateStartingApp)
	runtimeRoot := lease.RootPath()
	entrypoint := filepath.Join(runtimeRoot, filepath.FromSlash(strings.ReplaceAll(manifest.Entrypoint, `\`, "/")))
	process, err := deps.StartProcess(ProcessSpec{
		Path:  entrypoint,
		Args:  append([]string(nil), manifest.EntryArgs...),
		Dir:   filepath.Dir(entrypoint),
		Env:   append(portableProcessEnvironment(deps.Paths), "UCLAW_RUNTIME_DIR="+runtimeRoot),
		Lease: lease,
	})
	if err != nil {
		return reportFailure(reporter, errors.Join(ErrAppStartFailed, err, lease.Close()))
	}
	waitResult := make(chan processWaitResult, 1)
	go func() {
		waitResult <- processWaitResult{processErr: process.Wait(), leaseErr: lease.Close()}
	}()
	if deps.StartupGrace > 0 {
		grace := time.NewTimer(deps.StartupGrace)
		select {
		case result := <-waitResult:
			grace.Stop()
			return reportFailure(reporter, errors.Join(ErrAppExited, result.processErr, result.leaseErr))
		case <-grace.C:
			select {
			case result := <-waitResult:
				return reportFailure(reporter, errors.Join(ErrAppExited, result.processErr, result.leaseErr))
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
	case result := <-waitResult:
		if err := errors.Join(result.processErr, result.leaseErr); err != nil {
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

func stopAndWait(process ChildProcess, waitResult <-chan processWaitResult, timeout time.Duration) error {
	stopErr := process.Stop()
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if stopErr == nil {
		timer := time.NewTimer(timeout)
		select {
		case result := <-waitResult:
			timer.Stop()
			// Process termination commonly makes Wait return an error. Only lease
			// cleanup failure changes the result of an intentional stop.
			return result.leaseErr
		case <-timer.C:
			stopErr = ErrProcessStopFailed
		}
	}
	// The launcher process owns the lease handles. It must remain alive after a
	// stop failure or timeout until the child actually exits and releases them.
	result := <-waitResult
	return errors.Join(stopErr, result.leaseErr)
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
		"UCLAW_RELEASE_BASE_URL=" + releaseFeedBaseURL,
		"UCLAW_RELEASE_REVOKED_KEY_IDS=" + revokedRuntimeKeyIDs,
		"UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS=" + trustedRuntimeKeys,
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
	case errors.Is(err, ErrStartupCredentialMissing):
		return "E_LICENSE_CREDENTIAL_MISSING", "未找到启动授权凭据，请联系服务人员。"
	case errors.Is(err, ErrStartupSecretMissing):
		return "E_LICENSE_SECRET_MISSING", "启动授权凭据不完整，请联系服务人员。"
	case errors.Is(err, ErrStartupSecretInvalid):
		return "E_LICENSE_SECRET_INVALID", "启动授权凭据无效，请联系服务人员。"
	case errors.Is(err, ErrLicenseFileMissing):
		return "E_LICENSE_FILE_MISSING", "未找到授权文件，请联系服务人员。"
	case errors.Is(err, ErrLicenseFileUnsafe):
		return "E_LICENSE_FILE_UNSAFE", "授权文件存储异常，请联系服务人员。"
	case errors.Is(err, ErrLicenseFormatInvalid):
		return "E_LICENSE_FORMAT_INVALID", "授权文件格式无效，请联系服务人员。"
	case errors.Is(err, ErrLicenseTrustUnavailable):
		return "E_LICENSE_TRUST_UNAVAILABLE", "启动授权信任配置不可用，请联系服务人员。"
	case errors.Is(err, ErrLicenseSignatureInvalid):
		return "E_LICENSE_SIGNATURE_INVALID", "授权文件签名无效，请联系服务人员。"
	case errors.Is(err, ErrLicenseDeviceMismatch):
		return "E_LICENSE_DEVICE_MISMATCH", "授权设备不匹配，请联系服务人员。"
	case errors.Is(err, ErrLicenseIDMismatch):
		return "E_LICENSE_ID_MISMATCH", "许可证标识不匹配，请联系服务人员。"
	case errors.Is(err, ErrLicenseUSBIdentityUnavailable):
		return "E_LICENSE_USB_ID_UNAVAILABLE", "无法读取 U 盘硬件身份，请更换接口后重试。"
	case errors.Is(err, ErrLicenseFingerprintMismatch):
		return "E_LICENSE_USB_MISMATCH", "当前 U 盘与授权不匹配。"
	case errors.Is(err, ErrLicenseNotYetValid):
		return "E_LICENSE_NOT_YET_VALID", "授权尚未生效，请联系服务人员。"
	case errors.Is(err, ErrLicenseExpired):
		return "E_LICENSE_EXPIRED", "授权已过期，请联系服务人员。"
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
