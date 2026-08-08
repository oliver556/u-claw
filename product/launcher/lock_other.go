//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

type fileInstanceLock struct {
	file      *os.File
	closeOnce sync.Once
	closeErr  error
}

func AcquireInstanceLock(dataDir string) (InstanceLock, error) {
	if _, err := instanceLockID(dataDir); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(dataDir, ".uclaw-instance.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrInstanceRunning
		}
		return nil, err
	}
	return &fileInstanceLock{file: file}, nil
}

func (lock *fileInstanceLock) Close() error {
	lock.closeOnce.Do(func() {
		unlockErr := syscall.Flock(int(lock.file.Fd()), syscall.LOCK_UN)
		closeErr := lock.file.Close()
		if unlockErr != nil {
			lock.closeErr = unlockErr
		} else {
			lock.closeErr = closeErr
		}
	})
	return lock.closeErr
}
