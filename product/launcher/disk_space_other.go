//go:build !windows

package main

import "syscall"

func hostHasRuntimeInstallSpace(path string, required uint64) bool {
	var stats syscall.Statfs_t
	if syscall.Statfs(path, &stats) != nil {
		return false
	}
	return stats.Bavail*uint64(stats.Bsize) >= required
}
