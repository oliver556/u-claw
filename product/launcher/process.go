package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

var ErrProcessInvalid = errors.New("process specification invalid")

type ProcessSpec struct {
	Path string
	Args []string
	Dir  string
	Env  []string
}

type ManagedProcess struct {
	command       *exec.Cmd
	container     processContainer
	stopOnce      sync.Once
	waitOnce      sync.Once
	containerOnce sync.Once
	stopErr       error
	waitErr       error
}

func StartManagedProcess(spec ProcessSpec) (*ManagedProcess, error) {
	if err := validateProcessSpec(spec); err != nil {
		return nil, err
	}
	command := exec.Command(spec.Path, spec.Args...)
	command.Dir = spec.Dir
	command.Env = mergeEnvironment(os.Environ(), spec.Env)
	container, err := prepareProcessContainer(command)
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		container.close()
		return nil, err
	}
	if err := container.attach(command); err != nil {
		_ = container.terminate(command)
		_ = container.close()
		_ = command.Wait()
		return nil, err
	}
	return &ManagedProcess{command: command, container: container}, nil
}

func (process *ManagedProcess) Wait() error {
	process.waitOnce.Do(func() {
		process.waitErr = process.command.Wait()
		process.closeContainer()
	})
	return process.waitErr
}

func (process *ManagedProcess) Stop() error {
	process.stopOnce.Do(func() {
		process.stopErr = process.container.terminate(process.command)
		process.closeContainer()
	})
	return process.stopErr
}

func (process *ManagedProcess) closeContainer() {
	process.containerOnce.Do(func() {
		if err := process.container.close(); process.stopErr == nil && err != nil {
			process.stopErr = err
		}
	})
}

func validateProcessSpec(spec ProcessSpec) error {
	if !filepath.IsAbs(spec.Path) || (spec.Dir != "" && !filepath.IsAbs(spec.Dir)) {
		return ErrProcessInvalid
	}
	for _, argument := range spec.Args {
		if strings.ContainsRune(argument, 0) {
			return ErrProcessInvalid
		}
	}
	for _, entry := range spec.Env {
		separator := strings.IndexByte(entry, '=')
		if separator <= 0 || strings.ContainsRune(entry, 0) {
			return ErrProcessInvalid
		}
	}
	return nil
}

func mergeEnvironment(base []string, overrides []string) []string {
	return mergeEnvironmentForPlatform(base, overrides, runtime.GOOS == "windows")
}

func mergeEnvironmentForPlatform(base []string, overrides []string, caseInsensitive bool) []string {
	values := make(map[string]string, len(base)+len(overrides))
	for _, entry := range append(append([]string{}, base...), overrides...) {
		separator := strings.IndexByte(entry, '=')
		if separator > 0 {
			key := entry[:separator]
			normalized := key
			if caseInsensitive {
				normalized = strings.ToUpper(key)
			}
			values[normalized] = key + "=" + entry[separator+1:]
		}
	}
	keys := make([]string, 0, len(values))
	for normalized := range values {
		keys = append(keys, normalized)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, normalized := range keys {
		result = append(result, values[normalized])
	}
	return result
}

type processContainer interface {
	attach(command *exec.Cmd) error
	terminate(command *exec.Cmd) error
	close() error
}
