//go:build !windows

package main

func newPlatformStatusReporter() Reporter {
	return headlessStatusReporter{}
}
