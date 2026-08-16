//go:build !windows

package main

import "io"

type noInstallLock struct{}

func (noInstallLock) Close() error { return nil }

func acquireInstallLock(string) (io.Closer, error) {
	return noInstallLock{}, nil
}
