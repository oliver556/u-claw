//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
)

type processGroup struct{}

func prepareProcessContainer(command *exec.Cmd) (processContainer, error) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return processGroup{}, nil
}

func (processGroup) attach(_ *exec.Cmd) error {
	return nil
}

func (processGroup) terminate(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func (processGroup) close() error {
	return nil
}
