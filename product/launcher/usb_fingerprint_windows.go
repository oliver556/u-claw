//go:build windows && !licensefixture

package main

import (
	"encoding/binary"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	ioctlStorageQueryProperty = 0x002d1400
	ioctlDiskGetLengthInfo    = 0x0007405c
	maxStorageDescriptorBytes = 64 << 10
)

func ReadUSBFingerprint(usbRoot string) (usbFingerprint, error) {
	volume := filepath.VolumeName(filepath.Clean(usbRoot))
	if len(volume) != 2 || volume[1] != ':' {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	path, err := syscall.UTF16PtrFromString(`\\.\` + strings.ToUpper(volume))
	if err != nil {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	handle, err := syscall.CreateFile(path, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	defer syscall.CloseHandle(handle)

	device, err := queryStorageProperty(handle, storageDeviceProperty)
	if err != nil || len(device) < 36 || binary.LittleEndian.Uint32(device[28:32]) != busTypeUSB {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	if unique, uniqueErr := queryStorageProperty(handle, storageDeviceUniqueIDProperty); uniqueErr == nil && len(unique) >= 20 {
		if fingerprint, fingerprintErr := fingerprintUniqueStorageDescriptor(unique); fingerprintErr == nil {
			return fingerprint, nil
		}
	}
	capacity, err := queryVolumeLength(handle)
	if err != nil {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	return fingerprintStorageDescriptor(storageDescriptorIdentity{
		BusType:  busTypeUSB,
		Vendor:   storageDescriptorString(device, binary.LittleEndian.Uint32(device[12:16])),
		Product:  storageDescriptorString(device, binary.LittleEndian.Uint32(device[16:20])),
		Revision: storageDescriptorString(device, binary.LittleEndian.Uint32(device[20:24])),
		Serial:   storageDescriptorString(device, binary.LittleEndian.Uint32(device[24:28])),
		Capacity: capacity,
	})
}

func queryStorageProperty(handle syscall.Handle, propertyID uint32) ([]byte, error) {
	query := make([]byte, 12)
	binary.LittleEndian.PutUint32(query[0:4], propertyID)
	output := make([]byte, maxStorageDescriptorBytes)
	var returned uint32
	err := syscall.DeviceIoControl(
		handle, ioctlStorageQueryProperty, &query[0], uint32(len(query)),
		&output[0], uint32(len(output)), &returned, nil,
	)
	if err != nil || returned < 8 || returned > uint32(len(output)) {
		return nil, ErrLicenseUSBIdentityUnavailable
	}
	size := binary.LittleEndian.Uint32(output[4:8])
	if size < 8 || size > returned {
		return nil, ErrLicenseUSBIdentityUnavailable
	}
	return output[:size], nil
}

func queryVolumeLength(handle syscall.Handle) (uint64, error) {
	output := make([]byte, 8)
	var returned uint32
	err := syscall.DeviceIoControl(handle, ioctlDiskGetLengthInfo, nil, 0, &output[0], uint32(len(output)), &returned, nil)
	if err != nil || returned != 8 {
		return 0, ErrLicenseUSBIdentityUnavailable
	}
	length := binary.LittleEndian.Uint64(output)
	if length == 0 {
		return 0, ErrLicenseUSBIdentityUnavailable
	}
	return length, nil
}

func storageDescriptorString(descriptor []byte, offset uint32) string {
	if offset == 0 || offset >= uint32(len(descriptor)) {
		return ""
	}
	end := offset
	for end < uint32(len(descriptor)) && descriptor[end] != 0 {
		end++
	}
	if end == uint32(len(descriptor)) {
		return ""
	}
	value := descriptor[offset:end]
	if len(value) == 0 {
		return ""
	}
	return string(value)
}
