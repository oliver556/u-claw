package main

import (
	"context"
	"errors"
	"path/filepath"
	"time"
)

type State string

const (
	StateStarting           State = "STARTING"
	StateActivationRequired State = "ACTIVATION_REQUIRED"
	StateStartingActivation State = "STARTING_ACTIVATION"
	StateValidatingUSB      State = "VALIDATING_USB"
	StateValidatingLicense  State = "VALIDATING_LICENSE"
	StateCheckingRuntime    State = "CHECKING_RUNTIME"
	StateExtractingRuntime  State = "EXTRACTING_RUNTIME"
	StateStartingApp        State = "STARTING_APP"
	StateReady              State = "READY"
)

func stateText(state State) string {
	switch state {
	case StateStarting:
		return "正在启动 U-Claw..."
	case StateActivationRequired:
		return "需要先激活 U-Claw。"
	case StateStartingActivation:
		return "正在打开激活窗口..."
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
	Paths                 PortablePaths
	Reporter              Reporter
	USBInterval           time.Duration
	StartupGrace          time.Duration
	ProcessStopTimeout    time.Duration
	ReadManifest          func(path string) (Manifest, error)
	ProbeDataDirectory    func(packageRoot string, dataDir string) error
	DetectActivationState func(packageRoot string) (ActivationState, error)
	VerifyLicense         func(packageRoot string, usbRoot string) error
	EnsureHostCache       func(cacheRoot string) error
	AcquireInstanceLock   func(dataDir string) (InstanceLock, error)
	PrepareRuntime        func(context.Context, string, string, Manifest, func()) (CacheResult, error)
	AcquireRuntime        func(string, Manifest) (RuntimeLease, error)
	CheckSequence         func(string, Manifest) error
	AcceptSequence        func(string, Manifest) error
	FinalizeUpdate        func(string, Manifest) error
	ActivationProcessSpec func(PortablePaths, Manifest, RuntimeLease) ProcessSpec
	StartProcess          func(ProcessSpec) (ChildProcess, error)
	MonitorUSB            func(context.Context, string, time.Duration) error
	AppendLog             func(dataDir string, event string) error
}

type processWaitResult struct {
	processErr error
	leaseErr   error
}

func Run(ctx context.Context, deps Dependencies) error {
	reporter := deps.Reporter
	defer reporter.Close()
	appendLog := func(event string) {
		if deps.AppendLog != nil {
			_ = deps.AppendLog(deps.Paths.DataDir, event)
		}
	}
	appendLog("launcher-started")
	for activationRuns := 0; ; {
		reporter.State(StateStarting)

		reporter.State(StateValidatingUSB)
		if err := deps.ProbeDataDirectory(deps.Paths.PackageRoot, deps.Paths.DataDir); err != nil {
			return reportFailure(reporter, err)
		}
		activationState, err := deps.DetectActivationState(deps.Paths.PackageRoot)
		if err != nil {
			return reportFailure(reporter, err)
		}
		activationOnly := activationState == ActivationRequired
		if activationState == LicenseLocalInvalid {
			reporter.State(StateValidatingLicense)
			if err := deps.VerifyLicense(deps.Paths.PackageRoot, deps.Paths.USBRoot); err != nil {
				return reportFailure(reporter, err)
			}
			return reportFailure(reporter, ErrLicenseLocalInvalid)
		}
		if activationOnly {
			if activationRuns >= 1 {
				return reportFailure(reporter, ErrActivationRestartLimit)
			}
			reporter.State(StateActivationRequired)
		} else {
			reporter.State(StateValidatingLicense)
			if err := deps.VerifyLicense(deps.Paths.PackageRoot, deps.Paths.USBRoot); err != nil {
				return reportFailure(reporter, err)
			}
			lock, err := deps.AcquireInstanceLock(deps.Paths.DataDir)
			if err != nil {
				return reportFailure(reporter, err)
			}
			defer lock.Close()
		}
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
		if activationOnly {
			reporter.State(StateStartingActivation)
			process, err := deps.StartProcess(deps.ActivationProcessSpec(deps.Paths, manifest, lease))
			if err != nil {
				return reportFailure(reporter, errors.Join(ErrAppStartFailed, err, lease.Close()))
			}
			waitResult := make(chan processWaitResult, 1)
			go func() {
				waitResult <- processWaitResult{processErr: process.Wait(), leaseErr: lease.Close()}
			}()
			monitorCtx, cancelMonitor := context.WithCancel(ctx)
			usbResult := make(chan error, 1)
			go func() { usbResult <- deps.MonitorUSB(monitorCtx, deps.Paths.USBRoot, deps.USBInterval) }()
			select {
			case result := <-waitResult:
				cancelMonitor()
				if ActivationCompleted(result.processErr) && result.leaseErr == nil {
					activationRuns++
					continue
				}
				return reportFailure(reporter, errors.Join(ErrActivationExited, result.processErr, result.leaseErr))
			case err := <-usbResult:
				cancelMonitor()
				cleanupErr := stopAndWait(process, waitResult, deps.ProcessStopTimeout)
				if ctx.Err() != nil {
					if cleanupErr != nil {
						return reportFailure(reporter, errors.Join(ErrActivationExited, cleanupErr))
					}
					return ctx.Err()
				}
				return reportFailure(reporter, errors.Join(err, cleanupErr))
			case <-ctx.Done():
				cancelMonitor()
				if cleanupErr := stopAndWait(process, waitResult, deps.ProcessStopTimeout); cleanupErr != nil {
					return reportFailure(reporter, errors.Join(ErrActivationExited, cleanupErr))
				}
				return ctx.Err()
			}
		}

		reporter.State(StateStartingApp)
		process, err := deps.StartProcess(NormalProcessSpec(deps.Paths, manifest, lease))
		if err != nil {
			appendLog("launcher-failed")
			return reportFailure(reporter, errors.Join(ErrAppStartFailed, err, lease.Close()))
		}
		appendLog("runtime-started")
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
			appendLog("runtime-stopped")
			if err := errors.Join(result.processErr, result.leaseErr); err != nil {
				return reportFailure(reporter, errors.Join(ErrAppExited, err))
			}
			return nil
		case err := <-usbResult:
			appendLog("runtime-stopped")
			if ctx.Err() != nil {
				if cleanupErr := stopAndWait(process, waitResult, deps.ProcessStopTimeout); cleanupErr != nil {
					return reportFailure(reporter, errors.Join(ErrAppExited, cleanupErr))
				}
				return ctx.Err()
			}
			return reportFailure(reporter, errors.Join(err, stopAndWait(process, waitResult, deps.ProcessStopTimeout)))
		case <-ctx.Done():
			appendLog("runtime-stopped")
			if cleanupErr := stopAndWait(process, waitResult, deps.ProcessStopTimeout); cleanupErr != nil {
				return reportFailure(reporter, errors.Join(ErrAppExited, cleanupErr))
			}
			return ctx.Err()
		}
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
	ErrAppStartFailed         = errors.New("application start failed")
	ErrAppExited              = errors.New("application exited unexpectedly")
	ErrProcessStopFailed      = errors.New("application stop failed")
	ErrLicenseLocalInvalid    = errors.New("local license material invalid")
	ErrActivationExited       = errors.New("activation window exited unexpectedly")
	ErrActivationRestartLimit = errors.New("activation restart limit reached")
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
	case errors.Is(err, ErrLicenseStatusUnavailable), errors.Is(err, ErrLicenseLifecycleConfigAbsent):
		return "E_LICENSE_STATUS_UNAVAILABLE", "无法确认许可证在线状态，且没有可用的离线授权。"
	case errors.Is(err, ErrLicenseStatusAuthentication):
		return "E_LICENSE_STATUS_AUTH_FAILED", "许可证在线认证失败，请联系服务人员。"
	case errors.Is(err, ErrLicenseStatusResponseInvalid):
		return "E_LICENSE_STATUS_INVALID", "许可证在线状态响应无效，请联系服务人员。"
	case errors.Is(err, ErrLicenseStatusReceiptInvalid):
		return "E_LICENSE_STATUS_SIGNATURE_INVALID", "许可证状态回执无效，请联系服务人员。"
	case errors.Is(err, ErrLicenseStatusDeviceMismatch):
		return "E_LICENSE_STATUS_DEVICE_MISMATCH", "许可证状态设备不匹配，请联系服务人员。"
	case errors.Is(err, ErrLicenseStatusLicenseMismatch):
		return "E_LICENSE_STATUS_LICENSE_MISMATCH", "许可证状态标识不匹配，请联系服务人员。"
	case errors.Is(err, ErrLicenseOfflineCacheMissing):
		return "E_LICENSE_OFFLINE_FIRST_START", "首次启动需要联网确认许可证状态。"
	case errors.Is(err, ErrLicenseOfflineCacheInvalid):
		return "E_LICENSE_CACHE_INVALID", "许可证离线缓存无效，请联网重试。"
	case errors.Is(err, ErrLicenseClockRollback):
		return "E_LICENSE_CLOCK_ROLLBACK", "检测到系统时间回拨，请校准时间后联网重试。"
	case errors.Is(err, ErrLicenseOfflineGraceExpired):
		return "E_LICENSE_OFFLINE_GRACE_EXPIRED", "许可证离线有效期已结束，请联网确认。"
	case errors.Is(err, ErrLicenseProvisioning):
		return "E_LICENSE_PROVISIONING", "许可证仍在签发中，请稍后重试。"
	case errors.Is(err, ErrLicenseRevoked):
		return "E_LICENSE_REVOKED", "许可证已撤销，请联系服务人员。"
	case errors.Is(err, ErrLicenseReissued):
		return "E_LICENSE_REISSUED", "许可证已重制，请使用新的授权介质。"
	case errors.Is(err, ErrLicenseDisabled):
		return "E_LICENSE_DISABLED", "许可证已停用，请联系服务人员。"
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
	case errors.Is(err, ErrActivationExited):
		return "E_ACTIVATION_EXITED", "激活窗口意外退出，请重新启动 U-Claw。"
	case errors.Is(err, ErrActivationRestartLimit):
		return "E_ACTIVATION_RESTART_LIMIT", "激活完成后授权仍未生效，请重新启动 U-Claw。"
	case errors.Is(err, ErrLicenseLocalInvalid):
		return "E_LICENSE_LOCAL_INVALID", "本地授权材料不完整，请联系服务人员。"
	default:
		return "E_INTERNAL", "U-Claw 启动失败，请重新启动。"
	}
}
