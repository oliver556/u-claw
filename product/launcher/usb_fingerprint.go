package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"strconv"
	"strings"
)

const (
	usbFingerprintSchemeV1               = "uclaw-usb-v1"
	usbFingerprintSchemeV2               = "uclaw-usb-v2"
	storageDeviceProperty         uint32 = 0
	storageDeviceUniqueIDProperty uint32 = 3
	busTypeUSB                    uint32 = 7
)

type usbFingerprint struct {
	Scheme string `json:"scheme"`
	SHA256 string `json:"sha256"`
}

type storageDescriptorIdentity struct {
	BusType  uint32
	Vendor   string
	Product  string
	Revision string
	Serial   string
	Capacity uint64
}

func fingerprintUniqueDescriptor(descriptor []byte) (usbFingerprint, error) {
	if len(descriptor) == 0 || len(descriptor) > maxLicenseFileBytes {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	hasher := sha256.New()
	hasher.Write([]byte(usbFingerprintSchemeV1 + "\x00unique\x00"))
	hasher.Write(descriptor)
	return usbFingerprint{Scheme: usbFingerprintSchemeV1, SHA256: hex.EncodeToString(hasher.Sum(nil))}, nil
}

func fingerprintUniqueStorageDescriptor(descriptor []byte) (usbFingerprint, error) {
	if len(descriptor) < 20 {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	size := binary.LittleEndian.Uint32(descriptor[4:8])
	if size < 20 || size > uint32(len(descriptor)) {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	hasIdentity := false
	for _, start := range []int{8, 12, 16} {
		offset := binary.LittleEndian.Uint32(descriptor[start : start+4])
		if offset >= 20 && offset < size {
			hasIdentity = true
		}
	}
	if !hasIdentity {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	return fingerprintUniqueDescriptor(descriptor[:size])
}

func fingerprintStorageDescriptor(identity storageDescriptorIdentity) (usbFingerprint, error) {
	serial := normalizeUSBIdentityField(identity.Serial)
	if identity.BusType != busTypeUSB || serial == "" || identity.Capacity == 0 {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	canonical := strings.Join([]string{
		usbFingerprintSchemeV1, "fallback", normalizeUSBIdentityField(identity.Vendor),
		normalizeUSBIdentityField(identity.Product), normalizeUSBIdentityField(identity.Revision),
		serial, strconv.FormatUint(identity.Capacity, 10),
	}, "\x00")
	digest := sha256.Sum256([]byte(canonical))
	return usbFingerprint{Scheme: usbFingerprintSchemeV1, SHA256: hex.EncodeToString(digest[:])}, nil
}

func normalizeUSBIdentityField(value string) string {
	return strings.ToUpper(strings.Join(strings.Fields(strings.Trim(value, "\x00 \t\r\n")), " "))
}
