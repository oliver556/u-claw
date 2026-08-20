package main

import (
	"errors"
	"os/exec"
	"path/filepath"
)

var ErrBootstrapRestartFailed = errors.New("bootstrap restart failed")

func RestartBootstrap(executablePath string) error {
	if !filepath.IsAbs(executablePath) {
		return ErrBootstrapRestartFailed
	}
	command := exec.Command(executablePath)
	command.Dir = filepath.Dir(executablePath)
	if err := command.Start(); err != nil {
		return ErrBootstrapRestartFailed
	}
	if err := command.Process.Release(); err != nil {
		return ErrBootstrapRestartFailed
	}
	return nil
}
