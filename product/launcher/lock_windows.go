//go:build windows

package main

import (
	"fmt"
	"sync"
	"syscall"
	"unsafe"
)

const errorAlreadyExists syscall.Errno = 183

var (
	kernel32Lock    = syscall.NewLazyDLL("kernel32.dll")
	createMutexW    = kernel32Lock.NewProc("CreateMutexW")
	closeHandleLock = kernel32Lock.NewProc("CloseHandle")
)

type mutexInstanceLock struct {
	handle    syscall.Handle
	closeOnce sync.Once
	closeErr  error
}

func AcquireInstanceLock(dataDir string) (InstanceLock, error) {
	id, err := instanceLockID(dataDir)
	if err != nil {
		return nil, err
	}
	name, err := syscall.UTF16PtrFromString(`Local\UClaw-` + id)
	if err != nil {
		return nil, err
	}
	handle, _, callErr := createMutexW.Call(0, 0, uintptr(unsafePointer(name)))
	if handle == 0 {
		return nil, fmt.Errorf("create instance mutex: %w", callErr)
	}
	if callErr == errorAlreadyExists {
		closeHandleLock.Call(handle)
		return nil, ErrInstanceRunning
	}
	return &mutexInstanceLock{handle: syscall.Handle(handle)}, nil
}

func (lock *mutexInstanceLock) Close() error {
	lock.closeOnce.Do(func() {
		result, _, callErr := closeHandleLock.Call(uintptr(lock.handle))
		if result == 0 {
			lock.closeErr = callErr
		}
	})
	return lock.closeErr
}

func unsafePointer[T any](value *T) unsafe.Pointer {
	return unsafe.Pointer(value)
}
