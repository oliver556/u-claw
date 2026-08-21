//go:build darwin

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const diskutilProbeTimeout = 2 * time.Second

type macOSUSBIdentity struct {
	Protocol       string
	DeviceLocation string
	RemovableMedia bool
	Ejectable      bool
	Vendor         string
	Product        string
	Revision       string
	Serial         string
	Capacity       uint64
	VolumeUUID     string
	MediaUUID      string
}

func ReadUSBFingerprint(usbRoot string) (usbFingerprint, error) {
	if !filepath.IsAbs(usbRoot) {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), diskutilProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "diskutil", "info", "-plist", filepath.Clean(usbRoot)).Output()
	if err != nil {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	identity, err := macOSUSBIdentityFromDiskutilPlist(output)
	if err != nil {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	return fingerprintMacOSUSBIdentity(identity)
}

func macOSUSBIdentityFromDiskutilPlist(content []byte) (macOSUSBIdentity, error) {
	values, err := parseDiskutilPlistScalars(content)
	if err != nil {
		return macOSUSBIdentity{}, err
	}
	capacity, _ := strconv.ParseUint(firstNonEmpty(values["TotalSize"], values["Size"]), 10, 64)
	return macOSUSBIdentity{
		Protocol:       firstNonEmpty(values["BusProtocol"], values["Protocol"]),
		DeviceLocation: values["DeviceLocation"],
		RemovableMedia: parsePlistBool(values["RemovableMedia"]),
		Ejectable:      parsePlistBool(values["Ejectable"]),
		Vendor:         firstNonEmpty(values["Vendor"], values["VendorName"], values["Manufacturer"]),
		Product:        firstNonEmpty(values["Product"], values["ProductName"], values["MediaName"], values["DeviceModel"]),
		Revision:       firstNonEmpty(values["Revision"], values["FirmwareRevision"]),
		Serial:         firstNonEmpty(values["SerialNumber"], values["USBSerialNumber"], values["DeviceSerial"]),
		Capacity:       capacity,
		VolumeUUID:     values["VolumeUUID"],
		MediaUUID:      firstNonEmpty(values["MediaUUID"], values["DiskUUID"]),
	}, nil
}

func fingerprintMacOSUSBIdentity(identity macOSUSBIdentity) (usbFingerprint, error) {
	protocol := normalizeUSBIdentityField(identity.Protocol)
	location := normalizeUSBIdentityField(identity.DeviceLocation)
	serial := normalizeUSBIdentityField(identity.Serial)
	if identity.Capacity == 0 || serial == "" ||
		(protocol != "USB" && location != "EXTERNAL" && !identity.RemovableMedia && !identity.Ejectable) {
		return usbFingerprint{}, ErrLicenseUSBIdentityUnavailable
	}
	canonical := strings.Join([]string{
		usbFingerprintSchemeV2, "darwin", "diskutil",
		protocol, location, strconv.FormatBool(identity.RemovableMedia), strconv.FormatBool(identity.Ejectable),
		normalizeUSBIdentityField(identity.Vendor), normalizeUSBIdentityField(identity.Product),
		normalizeUSBIdentityField(identity.Revision), serial, strconv.FormatUint(identity.Capacity, 10),
		normalizeUSBIdentityField(identity.MediaUUID), normalizeUSBIdentityField(identity.VolumeUUID),
	}, "\x00")
	digest := sha256.Sum256([]byte(canonical))
	return usbFingerprint{Scheme: usbFingerprintSchemeV2, SHA256: hex.EncodeToString(digest[:])}, nil
}

func parseDiskutilPlistScalars(content []byte) (map[string]string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(content))
	values := map[string]string{}
	currentKey := ""
	for {
		token, err := decoder.Token()
		if errors.Is(err, context.Canceled) {
			return nil, ErrLicenseUSBIdentityUnavailable
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, ErrLicenseUSBIdentityUnavailable
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		switch start.Name.Local {
		case "key":
			var key string
			if err := decoder.DecodeElement(&key, &start); err != nil {
				return nil, ErrLicenseUSBIdentityUnavailable
			}
			currentKey = key
		case "string", "integer":
			if currentKey == "" {
				continue
			}
			var value string
			if err := decoder.DecodeElement(&value, &start); err != nil {
				return nil, ErrLicenseUSBIdentityUnavailable
			}
			values[currentKey] = strings.TrimSpace(value)
			currentKey = ""
		case "true":
			if currentKey != "" {
				values[currentKey] = "true"
				currentKey = ""
			}
		case "false":
			if currentKey != "" {
				values[currentKey] = "false"
				currentKey = ""
			}
		}
	}
	if len(values) == 0 {
		return nil, ErrLicenseUSBIdentityUnavailable
	}
	return values, nil
}

func parsePlistBool(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), "true")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
