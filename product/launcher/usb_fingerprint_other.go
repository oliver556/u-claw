//go:build !windows && !darwin

package main

func ReadUSBFingerprint(string) (usbFingerprint, error) {
	return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
}
