//go:build darwin

package main

import (
	"errors"
	"strings"
	"testing"
)

func TestMacOSDiskutilPlistIdentityNormalizesStableEvidence(t *testing.T) {
	base := fixtureDiskutilPlist("U-Claw", "/Volumes/U-Claw", "disk4s1", "64 GB")
	renamed := fixtureDiskutilPlist("Work", "/Volumes/Work", "disk9s1", "64 GB")
	first, err := macOSUSBIdentityFromDiskutilPlist([]byte(base))
	if err != nil {
		t.Fatal(err)
	}
	second, err := macOSUSBIdentityFromDiskutilPlist([]byte(renamed))
	if err != nil {
		t.Fatal(err)
	}
	firstFingerprint, err := fingerprintMacOSUSBIdentity(first)
	if err != nil {
		t.Fatal(err)
	}
	secondFingerprint, err := fingerprintMacOSUSBIdentity(second)
	if err != nil {
		t.Fatal(err)
	}
	if firstFingerprint.Scheme != usbFingerprintSchemeV2 || firstFingerprint.SHA256 != secondFingerprint.SHA256 {
		t.Fatalf("macOS fingerprint changed with mutable volume fields: %#v %#v", firstFingerprint, secondFingerprint)
	}
}

func TestMacOSDiskutilPlistIdentityChangesWithStableEvidence(t *testing.T) {
	base, err := macOSUSBIdentityFromDiskutilPlist([]byte(fixtureDiskutilPlist("U-Claw", "/Volumes/U-Claw", "disk4s1", "64 GB")))
	if err != nil {
		t.Fatal(err)
	}
	changed, err := macOSUSBIdentityFromDiskutilPlist([]byte(strings.Replace(fixtureDiskutilPlist("U-Claw", "/Volumes/U-Claw", "disk4s1", "128 GB"), "64000000000", "128000000000", 1)))
	if err != nil {
		t.Fatal(err)
	}
	firstFingerprint, err := fingerprintMacOSUSBIdentity(base)
	if err != nil {
		t.Fatal(err)
	}
	secondFingerprint, err := fingerprintMacOSUSBIdentity(changed)
	if err != nil {
		t.Fatal(err)
	}
	if firstFingerprint.SHA256 == secondFingerprint.SHA256 {
		t.Fatalf("capacity change did not affect fingerprint: %#v", firstFingerprint)
	}
}

func TestMacOSUSBIdentityFailsClosedWithoutExternalHardwareEvidence(t *testing.T) {
	_, err := fingerprintMacOSUSBIdentity(macOSUSBIdentity{
		Protocol: "PCI-Express", Serial: "APPLE-SSD", Capacity: 1_000_000,
	})
	if !errors.Is(err, ErrLicenseUSBIdentityUnavailable) {
		t.Fatalf("internal disk returned %v", err)
	}
	_, err = fingerprintMacOSUSBIdentity(macOSUSBIdentity{
		Protocol: "USB", Capacity: 1_000_000,
	})
	if !errors.Is(err, ErrLicenseUSBIdentityUnavailable) {
		t.Fatalf("missing serial returned %v", err)
	}
}

func fixtureDiskutilPlist(volumeName string, mountPoint string, deviceIdentifier string, displaySize string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>BusProtocol</key><string> USB </string>
	<key>DeviceLocation</key><string>External</string>
	<key>RemovableMedia</key><true/>
	<key>Ejectable</key><true/>
	<key>Vendor</key><string> acme </string>
	<key>Product</key><string>Flash   Drive</string>
	<key>Revision</key><string>1.00</string>
	<key>SerialNumber</key><string> sn 123 </string>
	<key>TotalSize</key><integer>64000000000</integer>
	<key>MediaUUID</key><string>7A9877AE-2941-4F87-83EF-C9B7DF8DA111</string>
	<key>VolumeUUID</key><string>4f2b2fc0-3e70-49a0-9dfc-0e012aef0001</string>
	<key>VolumeName</key><string>` + volumeName + `</string>
	<key>MountPoint</key><string>` + mountPoint + `</string>
	<key>DeviceIdentifier</key><string>` + deviceIdentifier + `</string>
	<key>TotalSizeHuman</key><string>` + displaySize + `</string>
</dict>
</plist>`
}
