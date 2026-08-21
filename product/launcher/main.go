package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"time"
)

var (
	licenseStatusEndpoint    = ""
	trustedLicenseStatusKeys = "{}"
	releasePolicyEndpoint    = ""
	trustedReleasePolicyKeys = "{}"
)

func runReleaseFSHelperEntry(
	args []string,
	executablePath string,
	localAppData string,
	input io.Reader,
	output io.Writer,
) error {
	paths, err := ResolvePortablePaths(executablePath, localAppData)
	if err != nil {
		return err
	}
	if err := ProbeDataDirectory(paths.PackageRoot, paths.DataDir); err != nil {
		return err
	}
	if err := verifyProductionStartupLicense(paths.PackageRoot, paths.USBRoot, paths.HostCacheRoot); err != nil {
		return err
	}
	return runReleaseFSHelper(args, input, output)
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--verify-official-release-policy-config" {
		if validateOfficialReleasePolicyConfig(releasePolicyEndpoint, trustedReleasePolicyKeys) != nil {
			os.Exit(2)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--release-fs-helper" {
		executablePath, err := os.Executable()
		if err != nil {
			_, _ = os.Stderr.WriteString("release filesystem helper failed\n")
			os.Exit(2)
		}
		if err := runReleaseFSHelperEntry(os.Args[2:], executablePath, os.Getenv("LOCALAPPDATA"), os.Stdin, os.Stdout); err != nil {
			_, _ = os.Stderr.WriteString("release filesystem helper failed\n")
			os.Exit(2)
		}
		return
	}
	reporter := NewStatusReporter()
	executablePath, err := os.Executable()
	if err != nil {
		reportFailure(reporter, err)
		reporter.Close()
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if err := launcherMain(ctx, executablePath, os.Getenv("LOCALAPPDATA"), reporter); err != nil {
		os.Exit(1)
	}
}

func validateOfficialReleasePolicyConfig(endpoint string, encodedKeys string) error {
	policyURL, err := url.Parse(endpoint)
	if err != nil || policyURL.Scheme != "https" || policyURL.Host == "" || policyURL.User != nil ||
		policyURL.RawQuery != "" || policyURL.Fragment != "" {
		return ErrReleasePolicyInvalid
	}
	host := strings.ToLower(policyURL.Hostname())
	if host == "localhost" || net.ParseIP(host) != nil || !strings.Contains(host, ".") ||
		strings.HasSuffix(host, ".test") || strings.HasSuffix(host, ".invalid") ||
		strings.HasSuffix(host, ".example") || strings.HasSuffix(host, ".example.com") ||
		strings.HasSuffix(host, ".example.net") || strings.HasSuffix(host, ".example.org") {
		return ErrReleasePolicyInvalid
	}
	keys, err := parseReleasePolicyKeys(encodedKeys)
	if err != nil || len(keys) > 16 {
		return ErrReleasePolicyInvalid
	}
	for keyID := range keys {
		lower := strings.ToLower(keyID)
		if strings.HasPrefix(lower, "test") || strings.HasPrefix(lower, "fixture") ||
			strings.HasPrefix(lower, "example") || strings.HasPrefix(lower, "dev-") {
			return ErrReleasePolicyInvalid
		}
	}
	return nil
}

func launcherMain(ctx context.Context, executablePath string, localAppData string, reporter Reporter) error {
	paths, err := ResolvePortablePaths(executablePath, localAppData)
	if err != nil {
		reportFailure(reporter, err)
		reporter.Close()
		return err
	}
	return Run(ctx, launcherDependencies(paths, reporter, executablePath))
}

func launcherDependencies(paths PortablePaths, reporter Reporter, executablePath string) Dependencies {
	policyKeys, policyConfigErr := parseReleasePolicyKeys(trustedReleasePolicyKeys)
	releaseClient, releaseClientErr := newReleaseHTTPClient(releaseHTTPClientOptions{
		PolicyEndpoint: releasePolicyEndpoint, TrustedPolicyKeys: policyKeys, Paths: paths,
	})
	policyConfigErr = errors.Join(policyConfigErr, releaseClientErr)
	return Dependencies{
		Paths:                 paths,
		Reporter:              reporter,
		USBInterval:           500 * time.Millisecond,
		StartupGrace:          2 * time.Second,
		ProcessStopTimeout:    2 * time.Second,
		RepairPollInterval:    30 * time.Second,
		ProbeDataDirectory:    ProbeDataDirectory,
		DetectActivationState: DetectActivationState,
		VerifyLocalLicense: func(packageRoot string, usbRoot string) (verifiedLicenseMaterial, error) {
			return verifyProductionLocalLicense(packageRoot, usbRoot)
		},
		VerifyOnlineLicense: func(material verifiedLicenseMaterial) error {
			return verifyProductionOnlineLicense(paths.PackageRoot, paths.HostCacheRoot, material)
		},
		EnsureHostCache:     EnsureHostCacheOwnership,
		AcquireInstanceLock: AcquireInstanceLock,
		EnforceRelease: func(ctx context.Context, progress func(State)) (requiredReleaseResult, error) {
			if policyConfigErr != nil {
				return requiredReleaseResult{}, ErrReleasePolicyUnavailable
			}
			return releaseClient.Enforce(ctx, progress)
		},
		RestartBootstrap:      func() error { return RestartBootstrap(executablePath) },
		AcquireRuntime:        AcquireRuntimeLease,
		ActivationProcessSpec: ActivationProcessSpec,
		ReadUSBFingerprint:    ReadUSBFingerprint,
		StartProcess: func(spec ProcessSpec) (ChildProcess, error) {
			return StartManagedProcess(spec)
		},
		MonitorUSB: MonitorUSB,
		AppendLog:  appendLauncherLog,
	}
}

func verifyProductionStartupLicense(packageRoot string, usbRoot string, anchorRoot string) error {
	material, err := verifyProductionLocalLicense(packageRoot, usbRoot)
	if err != nil {
		return err
	}
	return verifyProductionOnlineLicense(packageRoot, anchorRoot, material)
}

func verifyProductionLocalLicense(packageRoot string, usbRoot string) (verifiedLicenseMaterial, error) {
	keys, err := parseTrustedStartupLicenseKeys(trustedStartupLicenseKeys)
	if err != nil {
		return verifiedLicenseMaterial{}, err
	}
	material, err := VerifyStartupLicenseMaterial(licenseVerificationOptions{
		PackageRoot:       packageRoot,
		USBRoot:           usbRoot,
		Now:               time.Now,
		ReadFingerprint:   ReadUSBFingerprint,
		TrustedPublicKeys: keys,
	})
	if err != nil {
		return verifiedLicenseMaterial{}, err
	}
	return material, nil
}

func verifyProductionOnlineLicense(packageRoot string, anchorRoot string, material verifiedLicenseMaterial) error {
	query, statusKeys, err := productionLicenseLifecycleConfig(packageRoot)
	if err != nil {
		return err
	}
	return VerifyLicenseLifecycle(licenseLifecycleVerificationOptions{
		PackageRoot:       packageRoot,
		AnchorRoot:        anchorRoot,
		Material:          material,
		Now:               time.Now,
		QueryStatus:       query,
		TrustedPublicKeys: statusKeys,
		Random:            rand.Reader,
	})
}

func parseReleasePolicyKeys(encoded string) (map[string]ed25519.PublicKey, error) {
	var values map[string]string
	if json.Unmarshal([]byte(encoded), &values) != nil || len(values) == 0 {
		return nil, ErrReleasePolicyInvalid
	}
	keys := make(map[string]ed25519.PublicKey, len(values))
	for keyID, value := range values {
		decoded, err := base64.StdEncoding.DecodeString(value)
		if !runtimeIDPattern.MatchString(keyID) || err != nil || len(decoded) != ed25519.PublicKeySize {
			return nil, ErrReleasePolicyInvalid
		}
		keys[keyID] = ed25519.PublicKey(decoded)
	}
	return keys, nil
}

func productionLicenseLifecycleConfig(packageRoot string) (
	func(verifiedLicenseMaterial) (licenseStatusResponse, error),
	map[string]ed25519.PublicKey,
	error,
) {
	keys, err := parseTrustedStartupLicenseKeys(trustedLicenseStatusKeys)
	if err != nil {
		return nil, nil, ErrLicenseLifecycleConfigAbsent
	}
	query, err := productionLicenseStatusQuery(packageRoot)
	if err != nil {
		return nil, nil, ErrLicenseLifecycleConfigAbsent
	}
	return query, keys, nil
}
