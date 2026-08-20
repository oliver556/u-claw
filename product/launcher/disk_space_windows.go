//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var getDiskFreeSpaceExW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDiskFreeSpaceExW")

func hostHasRuntimeInstallSpace(path string, required uint64) bool {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	var available uint64
	result, _, _ := getDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&available)), 0, 0)
	return result != 0 && available >= required
}
