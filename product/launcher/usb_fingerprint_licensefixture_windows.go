//go:build windows && licensefixture

package main

import "strings"

// This source is compiled only by the Windows lifecycle fixture. Production
// builds use usb_fingerprint_windows.go and native DeviceIoControl evidence.
func ReadUSBFingerprint(string) (usbFingerprint, error) {
	return usbFingerprint{Scheme: "uclaw-usb-v1", SHA256: strings.Repeat("f", 64)}, nil
}
