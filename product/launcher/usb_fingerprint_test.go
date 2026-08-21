package main

import (
	"encoding/binary"
	"errors"
	"testing"
)

func TestUSBFingerprintFromUniqueDescriptorMatchesGolden(t *testing.T) {
	fingerprint, err := fingerprintUniqueDescriptor([]byte{1, 2, 3, 4})
	if err != nil {
		t.Fatal(err)
	}
	if fingerprint.Scheme != "uclaw-usb-v1" || fingerprint.SHA256 != "21b00a6444937c908260c93bb41b51ca71a408df382ee552b20bef1136066077" {
		t.Fatalf("unexpected fingerprint: %#v", fingerprint)
	}
}

func TestWindowsStoragePropertyIDsMatchNtddstor(t *testing.T) {
	if storageDeviceProperty != 0 || storageDeviceUniqueIDProperty != 3 {
		t.Fatalf("storage property IDs = %d, %d", storageDeviceProperty, storageDeviceUniqueIDProperty)
	}
}

func TestUSBFingerprintFallbackNormalizesStableFields(t *testing.T) {
	fingerprint, err := fingerprintStorageDescriptor(storageDescriptorIdentity{
		BusType: busTypeUSB, Vendor: " acme ", Product: "Flash   Drive",
		Revision: "1.00", Serial: " sn 123 ", Capacity: 64_000_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fingerprint.SHA256 != "0681185804e76ea49ef75e4828a1be3d9c12f8cd37d18dc5b46493e3728e7819" {
		t.Fatalf("unexpected fingerprint: %#v", fingerprint)
	}
}

func TestWindowsLegacyUSBFingerprintPayloadStillUsesV1(t *testing.T) {
	fingerprint, err := fingerprintStorageDescriptor(storageDescriptorIdentity{
		BusType: busTypeUSB, Vendor: "WINUSB", Product: "Legacy", Revision: "1", Serial: "SERIAL-001", Capacity: 8_000_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fingerprint.Scheme != usbFingerprintSchemeV1 || fingerprint.SHA256 != "26ab9bbe8bd931370c70725fe5c106a43853dacc4833eefd3458787f004479f7" {
		t.Fatalf("legacy fingerprint changed: %#v", fingerprint)
	}
}

func TestUSBFingerprintFallbackFailsClosedWithoutHardwareIdentity(t *testing.T) {
	tests := []storageDescriptorIdentity{
		{BusType: 0, Serial: "serial", Capacity: 1},
		{BusType: busTypeUSB, Serial: "", Capacity: 1},
		{BusType: busTypeUSB, Serial: "serial", Capacity: 0},
	}
	for _, identity := range tests {
		if _, err := fingerprintStorageDescriptor(identity); !errors.Is(err, ErrLicenseUSBIdentityUnavailable) {
			t.Fatalf("identity %#v returned %v", identity, err)
		}
	}
	if _, err := fingerprintUniqueDescriptor(nil); !errors.Is(err, ErrLicenseUSBIdentityUnavailable) {
		t.Fatalf("empty unique descriptor returned %v", err)
	}
}

func TestUSBFingerprintUniqueDescriptorRequiresIdentityOffsets(t *testing.T) {
	descriptor := make([]byte, 20)
	binary.LittleEndian.PutUint32(descriptor[0:4], 1)
	binary.LittleEndian.PutUint32(descriptor[4:8], uint32(len(descriptor)))
	if _, err := fingerprintUniqueStorageDescriptor(descriptor); !errors.Is(err, ErrLicenseUSBIdentityUnavailable) {
		t.Fatalf("empty descriptor returned %v", err)
	}
	descriptor = append(descriptor, 1, 2, 3, 4)
	binary.LittleEndian.PutUint32(descriptor[4:8], uint32(len(descriptor)))
	binary.LittleEndian.PutUint32(descriptor[8:12], 20)
	if _, err := fingerprintUniqueStorageDescriptor(descriptor); err != nil {
		t.Fatal(err)
	}
}
