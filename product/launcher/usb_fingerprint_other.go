//go:build !windows

package main

func ReadUSBFingerprint(string) (usbFingerprint, error) {
	return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
}
