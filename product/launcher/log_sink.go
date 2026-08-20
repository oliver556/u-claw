package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

var launcherLogEvents = map[string]bool{
	"launcher-started":     true,
	"runtime-started":      true,
	"runtime-stopped":      true,
	"launcher-failed":      true,
	"runtime-verify-fast":  true,
	"runtime-verify-full":  true,
	"runtime-audit-failed": true,
}

func appendLauncherLog(dataDir string, event string) error {
	if !filepath.IsAbs(dataDir) || !launcherLogEvents[event] {
		return errors.New("invalid launcher log event")
	}
	dataDir = filepath.Clean(dataDir)
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	dataInfo, err := os.Lstat(dataDir)
	if err != nil || !dataInfo.IsDir() || dataInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe launcher data directory")
	}
	dataRoot, err := os.OpenRoot(dataDir)
	if err != nil {
		return err
	}
	defer dataRoot.Close()
	pinnedDataInfo, err := dataRoot.Stat(".")
	if err != nil || !os.SameFile(dataInfo, pinnedDataInfo) {
		return errors.New("unsafe launcher data directory")
	}
	logsDir := filepath.Join("diagnostics", "desktop-logs")
	if err := dataRoot.MkdirAll(logsDir, 0o700); err != nil {
		return err
	}
	for _, directory := range []string{"diagnostics", logsDir} {
		info, statErr := dataRoot.Lstat(directory)
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe launcher log directory")
		}
	}
	logsInfo, err := dataRoot.Lstat(logsDir)
	if err != nil {
		return errors.New("unsafe launcher log directory")
	}
	logsRoot, err := dataRoot.OpenRoot(logsDir)
	if err != nil {
		return errors.New("unsafe launcher log directory")
	}
	defer logsRoot.Close()
	pinnedLogsInfo, err := logsRoot.Stat(".")
	if err != nil || !os.SameFile(logsInfo, pinnedLogsInfo) {
		return errors.New("unsafe launcher log directory")
	}
	const name = "uclaw-launcher.jsonl"
	before, err := logsRoot.Lstat(name)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && (!before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Sys() == nil) {
		return errors.New("unsafe launcher log target")
	}
	file, err := logsRoot.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, openedErr := file.Stat()
	target, targetErr := logsRoot.Lstat(name)
	if openedErr != nil || targetErr != nil || !opened.Mode().IsRegular() || !target.Mode().IsRegular() || target.Mode()&os.ModeSymlink != 0 || !os.SameFile(opened, target) || before != nil && !os.SameFile(before, opened) {
		return errors.New("unsafe launcher log target")
	}
	line, err := json.Marshal(map[string]string{"timestamp": time.Now().UTC().Format(time.RFC3339Nano), "source": "launcher", "event": event})
	if err != nil {
		return err
	}
	if _, err = file.Write(append(line, '\n')); err != nil {
		return err
	}
	return file.Sync()
}
