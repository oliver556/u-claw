//go:build !windows

package main

import "os"

func syncDirectory(directory *os.File) error {
	return directory.Sync()
}
