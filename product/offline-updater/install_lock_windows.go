//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const installLockAlreadyExists syscall.Errno = 183

var (
	installLockKernel32   = syscall.NewLazyDLL("kernel32.dll")
	installLockCreate     = installLockKernel32.NewProc("CreateMutexW")
	installLockClose      = installLockKernel32.NewProc("CloseHandle")
	errApplicationRunning = errors.New("U-Claw is running; close it before updating")
)

type windowsInstallLock struct {
	handle syscall.Handle
}

func acquireInstallLock(root string) (io.Closer, error) {
	dataDirectory, err := filepath.Abs(filepath.Join(root, "data"))
	if err != nil {
		return nil, err
	}
	normalized := strings.ToLower(filepath.Clean(dataDirectory))
	digest := sha256.Sum256([]byte(normalized))
	name, err := syscall.UTF16PtrFromString(`Local\UClaw-` + hex.EncodeToString(digest[:]))
	if err != nil {
		return nil, err
	}
	handle, _, callErr := installLockCreate.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return nil, fmt.Errorf("create U-Claw update mutex: %w", callErr)
	}
	if callErr == installLockAlreadyExists {
		installLockClose.Call(handle)
		return nil, errApplicationRunning
	}
	return &windowsInstallLock{handle: syscall.Handle(handle)}, nil
}

func (lock *windowsInstallLock) Close() error {
	result, _, callErr := installLockClose.Call(uintptr(lock.handle))
	if result == 0 {
		return callErr
	}
	return nil
}
