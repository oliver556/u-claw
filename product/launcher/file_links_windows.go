//go:build windows

package main

import (
	"os"
	"syscall"
)

func fileLinkCount(file *os.File, _ os.FileInfo) (uint64, error) {
	var information syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &information); err != nil {
		return 0, err
	}
	return uint64(information.NumberOfLinks), nil
}
