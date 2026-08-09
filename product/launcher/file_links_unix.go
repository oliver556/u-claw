//go:build darwin || linux

package main

import (
	"os"
	"syscall"
)

func fileLinkCount(_ *os.File, info os.FileInfo) (uint64, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, ErrPackageInvalid
	}
	return uint64(stat.Nlink), nil
}
