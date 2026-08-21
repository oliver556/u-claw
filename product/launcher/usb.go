package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

var (
	ErrPortablePathInvalid = errors.New("portable path invalid")
	ErrUSBNotWritable      = errors.New("usb data directory not writable")
	ErrUSBDisconnected     = errors.New("usb disconnected")
)

var runtimeTargetForCurrentHost = func() (string, error) {
	return RuntimeTargetForPlatformArch(runtime.GOOS, runtime.GOARCH)
}

type PortablePaths struct {
	USBRoot         string
	PackageRoot     string
	DataDir         string
	HostCacheRoot   string
	CacheRoot       string
	Target          string
	TargetPaths     RuntimeTargetPaths
	TargetCacheRoot string
}

type RuntimeTargetPaths struct {
	Entry        string
	Package      string
	Manifest     string
	Current      string
	InstallState string
}

func ResolvePortablePaths(executablePath string, localAppData string) (PortablePaths, error) {
	target, err := runtimeTargetForCurrentHost()
	if err != nil {
		return PortablePaths{}, err
	}
	return ResolvePortablePathsForTarget(executablePath, localAppData, target)
}

func ResolvePortablePathsForTarget(executablePath string, localAppData string, target string) (PortablePaths, error) {
	if !filepath.IsAbs(executablePath) || !filepath.IsAbs(localAppData) {
		return PortablePaths{}, ErrPortablePathInvalid
	}
	usbRoot := filepath.Clean(filepath.Dir(executablePath))
	packageRoot := filepath.Join(usbRoot, ".uclaw")
	hostCacheRoot := filepath.Join(filepath.Clean(localAppData), "U-Claw")
	targetPaths, err := ResolveRuntimeTargetPaths(usbRoot, target)
	if err != nil {
		return PortablePaths{}, err
	}
	return PortablePaths{
		USBRoot:         usbRoot,
		PackageRoot:     packageRoot,
		DataDir:         filepath.Join(packageRoot, "data"),
		HostCacheRoot:   hostCacheRoot,
		CacheRoot:       filepath.Join(hostCacheRoot, "runtimes"),
		Target:          target,
		TargetPaths:     targetPaths,
		TargetCacheRoot: filepath.Join(hostCacheRoot, "runtimes", target),
	}, nil
}

func RuntimeTargetForPlatformArch(goos string, goarch string) (string, error) {
	if goos == "windows" && goarch == "amd64" {
		return "win-x64", nil
	}
	if goos == "darwin" && goarch == "arm64" {
		return "macos-arm64", nil
	}
	return "", ErrPortablePathInvalid
}

func RelativeRuntimeTargetPaths(target string) (RuntimeTargetPaths, error) {
	switch target {
	case "win-x64":
		return RuntimeTargetPaths{
			Entry:        "U-Claw.exe",
			Package:      filepath.FromSlash("app/packages/win-x64/runtime.pkg"),
			Manifest:     filepath.FromSlash("app/manifests/win-x64.version.json"),
			Current:      filepath.FromSlash("app/current/win-x64.json"),
			InstallState: filepath.FromSlash("app/install-state/win-x64.json"),
		}, nil
	case "macos-arm64":
		return RuntimeTargetPaths{
			Entry:        "U-Claw.app",
			Package:      filepath.FromSlash("app/packages/macos-arm64/runtime.pkg"),
			Manifest:     filepath.FromSlash("app/manifests/macos-arm64.version.json"),
			Current:      filepath.FromSlash("app/current/macos-arm64.json"),
			InstallState: filepath.FromSlash("app/install-state/macos-arm64.json"),
		}, nil
	default:
		return RuntimeTargetPaths{}, ErrPortablePathInvalid
	}
}

func ResolveRuntimeTargetPaths(usbRoot string, target string) (RuntimeTargetPaths, error) {
	if !filepath.IsAbs(usbRoot) {
		return RuntimeTargetPaths{}, ErrPortablePathInvalid
	}
	relative, err := RelativeRuntimeTargetPaths(target)
	if err != nil {
		return RuntimeTargetPaths{}, err
	}
	return RuntimeTargetPaths{
		Entry:        filepath.Join(usbRoot, relative.Entry),
		Package:      filepath.Join(usbRoot, relative.Package),
		Manifest:     filepath.Join(usbRoot, relative.Manifest),
		Current:      filepath.Join(usbRoot, relative.Current),
		InstallState: filepath.Join(usbRoot, relative.InstallState),
	}, nil
}

func ProbeDataDirectory(packageRoot string, dataDir string) error {
	if !filepath.IsAbs(packageRoot) || filepath.Clean(dataDir) != filepath.Join(filepath.Clean(packageRoot), "data") {
		return ErrUSBNotWritable
	}
	root, err := os.OpenRoot(packageRoot)
	if err != nil {
		return ErrUSBNotWritable
	}
	defer root.Close()
	if info, err := root.Lstat("data"); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ErrUSBNotWritable
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrUSBNotWritable
	} else if err := root.Mkdir("data", 0o700); err != nil {
		return ErrUSBNotWritable
	}

	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return ErrUSBNotWritable
	}
	probeName := filepath.Join("data", ".write-probe-"+hex.EncodeToString(random))
	probe, err := root.OpenFile(probeName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrUSBNotWritable
	}
	syncErr := probe.Sync()
	closeErr := probe.Close()
	removeErr := root.Remove(probeName)
	if syncErr != nil || closeErr != nil || removeErr != nil {
		return ErrUSBNotWritable
	}
	return nil
}

func MonitorUSB(ctx context.Context, root string, interval time.Duration) error {
	if interval <= 0 {
		return ErrPortablePathInvalid
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			info, err := os.Stat(root)
			if err != nil || !info.IsDir() {
				return ErrUSBDisconnected
			}
		}
	}
}
