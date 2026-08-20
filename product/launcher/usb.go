package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"time"
)

var (
	ErrPortablePathInvalid = errors.New("portable path invalid")
	ErrUSBNotWritable      = errors.New("usb data directory not writable")
	ErrUSBDisconnected     = errors.New("usb disconnected")
)

type PortablePaths struct {
	USBRoot       string
	PackageRoot   string
	DataDir       string
	HostCacheRoot string
	CacheRoot     string
}

func ResolvePortablePaths(executablePath string, localAppData string) (PortablePaths, error) {
	if !filepath.IsAbs(executablePath) || !filepath.IsAbs(localAppData) {
		return PortablePaths{}, ErrPortablePathInvalid
	}
	usbRoot := filepath.Clean(filepath.Dir(executablePath))
	packageRoot := filepath.Join(usbRoot, ".uclaw")
	hostCacheRoot := filepath.Join(filepath.Clean(localAppData), "U-Claw")
	return PortablePaths{
		USBRoot:       usbRoot,
		PackageRoot:   packageRoot,
		DataDir:       filepath.Join(packageRoot, "data"),
		HostCacheRoot: hostCacheRoot,
		CacheRoot:     filepath.Join(hostCacheRoot, "runtimes"),
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
