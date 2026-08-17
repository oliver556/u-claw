//go:build windows

package main

import "os"

// Windows does not expose a portable directory fsync through os.File.
func syncDirectory(_ *os.File) error {
	return nil
}
