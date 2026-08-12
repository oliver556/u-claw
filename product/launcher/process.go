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
	Path              string
	Args              []string
	Dir               string
	Env               []string
	EnvRemovePrefixes []string
	Lease             RuntimeLease
}

const (
	activationStartupArgument = "--uclaw-startup-mode=activation-only"
	normalStartupArgument     = "--uclaw-startup-mode=normal"
	activationCompletedCode   = 20
)

func NormalProcessSpec(paths PortablePaths, manifest Manifest, lease RuntimeLease) ProcessSpec {
	arguments := append(append([]string(nil), manifest.EntryArgs...), normalStartupArgument)
	return processSpec(paths, manifest, lease, arguments, portableProcessEnvironment(paths))
}

func ActivationProcessSpec(paths PortablePaths, manifest Manifest, lease RuntimeLease) ProcessSpec {
	environment := []string{
		"TEMP=" + filepath.Join(paths.HostCacheRoot, "cache", "temp"),
		"TMP=" + filepath.Join(paths.HostCacheRoot, "cache", "temp"),
		"UCLAW_CACHE_DIR=" + filepath.Join(paths.HostCacheRoot, "cache"),
		"UCLAW_DATA_DIR=" + paths.DataDir,
	}
	arguments := append(append([]string(nil), manifest.EntryArgs...), activationStartupArgument)
	spec := processSpec(paths, manifest, lease, arguments, environment)
	spec.EnvRemovePrefixes = []string{"OPENCLAW_"}
	return spec
}

func processSpec(paths PortablePaths, manifest Manifest, lease RuntimeLease, arguments []string, environment []string) ProcessSpec {
	runtimeRoot := lease.RootPath()
	entrypoint := filepath.Join(runtimeRoot, filepath.FromSlash(strings.ReplaceAll(manifest.Entrypoint, `\`, "/")))
	return ProcessSpec{
		Path:  entrypoint,
		Args:  append([]string(nil), arguments...),
		Dir:   filepath.Dir(entrypoint),
		Env:   append(append([]string(nil), environment...), "UCLAW_RUNTIME_DIR="+runtimeRoot),
		Lease: lease,
	}
}

func ActivationCompleted(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == activationCompletedCode
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
	command.Env = mergeEnvironmentFiltered(os.Environ(), spec.Env, spec.EnvRemovePrefixes)
	if err := spec.Lease.VerifyEntrypoint(spec.Path); err != nil {
		return nil, err
	}
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
	if spec.Lease == nil || !filepath.IsAbs(spec.Path) || (spec.Dir != "" && !filepath.IsAbs(spec.Dir)) {
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
	for _, prefix := range spec.EnvRemovePrefixes {
		if prefix == "" || strings.ContainsAny(prefix, "=\x00") {
			return ErrProcessInvalid
		}
	}
	return nil
}

func mergeEnvironment(base []string, overrides []string) []string {
	return mergeEnvironmentFiltered(base, overrides, nil)
}

func mergeEnvironmentFiltered(base []string, overrides []string, removePrefixes []string) []string {
	caseInsensitive := runtime.GOOS == "windows"
	filtered := make([]string, 0, len(base))
	for _, entry := range base {
		separator := strings.IndexByte(entry, '=')
		if separator > 0 && !hasEnvironmentPrefix(entry[:separator], removePrefixes, caseInsensitive) {
			filtered = append(filtered, entry)
		}
	}
	return mergeEnvironmentForPlatform(filtered, overrides, caseInsensitive)
}

func hasEnvironmentPrefix(key string, prefixes []string, caseInsensitive bool) bool {
	if caseInsensitive {
		key = strings.ToUpper(key)
	}
	for _, prefix := range prefixes {
		if caseInsensitive {
			prefix = strings.ToUpper(prefix)
		}
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
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
