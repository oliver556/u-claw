package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	lifecycleCacheFilename           = ".lifecycle-cache.json"
	hostAuthorizationAnchorDirectory = "license-anchors"
	maxLifecycleCacheBytes           = 128 << 10
	maxHostAuthorizationAnchorBytes  = 8 << 10
	maxOfflineGrace                  = 24 * time.Hour
)

var (
	ErrLicenseStatusUnavailable     = errors.New("license status unavailable")
	ErrLicenseStatusReceiptInvalid  = errors.New("license status receipt invalid")
	ErrLicenseStatusDeviceMismatch  = errors.New("license status device mismatch")
	ErrLicenseStatusLicenseMismatch = errors.New("license status license mismatch")
	ErrLicenseOfflineCacheMissing   = errors.New("license offline cache missing")
	ErrLicenseOfflineCacheInvalid   = errors.New("license offline cache invalid")
	ErrLicenseClockRollback         = errors.New("license clock rollback")
	ErrLicenseOfflineGraceExpired   = errors.New("license offline grace expired")
	ErrLicenseProvisioning          = errors.New("license provisioning")
	ErrLicenseRevoked               = errors.New("license revoked")
	ErrLicenseReissued              = errors.New("license reissued")
	ErrLicenseDisabled              = errors.New("license disabled")
	ErrLicenseLifecycleConfigAbsent = errors.New("license lifecycle configuration unavailable")
)

type licenseLifecycleStatus string

const (
	licenseStatusProvisioning licenseLifecycleStatus = "provisioning"
	licenseStatusActive       licenseLifecycleStatus = "active"
	licenseStatusRevoked      licenseLifecycleStatus = "revoked"
	licenseStatusReissued     licenseLifecycleStatus = "reissued"
	licenseStatusExpired      licenseLifecycleStatus = "expired"
	licenseStatusDisabled     licenseLifecycleStatus = "disabled"
)

type licenseStatusSummary struct {
	LicenseID            string                 `json:"licenseId"`
	DeviceID             string                 `json:"deviceId"`
	Status               licenseLifecycleStatus `json:"status"`
	Revision             int64                  `json:"revision"`
	NotBefore            string                 `json:"notBefore"`
	ExpiresAt            string                 `json:"expiresAt"`
	ReplacementLicenseID string                 `json:"replacementLicenseId"`
	UpdatedAt            string                 `json:"updatedAt"`
}

type licenseStatusReceipt struct {
	Value string `json:"value"`
}

type licenseStatusResponse struct {
	Status  licenseStatusSummary `json:"status"`
	Receipt licenseStatusReceipt `json:"receipt"`
}

type licenseLifecycleVerificationOptions struct {
	PackageRoot       string
	AnchorRoot        string
	Material          verifiedLicenseMaterial
	Now               func() time.Time
	QueryStatus       func(verifiedLicenseMaterial) (licenseStatusResponse, error)
	TrustedPublicKeys map[string]ed25519.PublicKey
	Random            io.Reader
}

type verifiedStatusReceipt struct {
	Status     licenseStatusSummary
	CheckedAt  time.Time
	GraceUntil time.Time
	Raw        string
}

type lifecycleCacheEnvelope struct {
	SchemaVersion int    `json:"schemaVersion"`
	Nonce         string `json:"nonce"`
	Ciphertext    string `json:"ciphertext"`
}

type lifecycleCachePayload struct {
	Receipt      string `json:"receipt"`
	LastObserved string `json:"lastObservedAt"`
}

type hostAuthorizationAnchor struct {
	HighestRevision int64                  `json:"highestRevision"`
	Status          licenseLifecycleStatus `json:"status"`
	LastObserved    string                 `json:"lastObservedAt"`
	Authentication  string                 `json:"authentication"`
}

func VerifyLicenseLifecycle(options licenseLifecycleVerificationOptions) error {
	if !filepath.IsAbs(options.PackageRoot) || !filepath.IsAbs(options.AnchorRoot) || options.Now == nil || options.QueryStatus == nil || options.Random == nil ||
		!validLicenseIdentifier(options.Material.DeviceID) || !validLicenseIdentifier(options.Material.LicenseID) ||
		options.Material.StartupSecret == "" || !lowerSHA256Pattern.MatchString(options.Material.USBFingerprint) ||
		options.Material.ExpiresAt.IsZero() || len(options.TrustedPublicKeys) == 0 {
		return ErrLicenseLifecycleConfigAbsent
	}
	now := options.Now().UTC()
	response, queryErr := options.QueryStatus(options.Material)
	if queryErr == nil {
		receipt, err := verifyLicenseStatusResponse(response, options.Material, now, options.TrustedPublicKeys)
		if err != nil {
			return err
		}
		if now.Before(receipt.CheckedAt) {
			return ErrLicenseClockRollback
		}
		if receipt.Status.Status == licenseStatusActive && !now.Before(receipt.GraceUntil) {
			return ErrLicenseOfflineGraceExpired
		}
		anchor, found, err := readHostAuthorizationAnchor(options)
		if err != nil {
			return ErrLicenseStatusReceiptInvalid
		}
		if found {
			lastObserved, err := time.Parse(time.RFC3339Nano, anchor.LastObserved)
			if err != nil {
				return ErrLicenseStatusReceiptInvalid
			}
			if now.Before(lastObserved.UTC()) {
				return ErrLicenseClockRollback
			}
			if receipt.Status.Revision < anchor.HighestRevision ||
				(receipt.Status.Revision == anchor.HighestRevision && receipt.Status.Status != anchor.Status) ||
				(terminalLifecycleStatus(anchor.Status) && receipt.Status.Status == licenseStatusActive) {
				return ErrLicenseStatusReceiptInvalid
			}
		}
		if err := writeHostAuthorizationAnchor(options, hostAuthorizationAnchor{
			HighestRevision: receipt.Status.Revision,
			Status:          receipt.Status.Status,
			LastObserved:    now.Format(time.RFC3339Nano),
		}); err != nil {
			return err
		}
		if err := writeLifecycleCache(options, receipt, now); err != nil {
			return err
		}
		return lifecycleStatusError(receipt.Status.Status)
	}
	if !errors.Is(queryErr, ErrLicenseStatusUnavailable) {
		return queryErr
	}
	anchor, found, err := readHostAuthorizationAnchor(options)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	if !found {
		return ErrLicenseOfflineCacheMissing
	}
	anchorObserved, err := time.Parse(time.RFC3339Nano, anchor.LastObserved)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	anchorObserved = anchorObserved.UTC()
	if now.Before(anchorObserved) {
		return ErrLicenseClockRollback
	}
	if terminalLifecycleStatus(anchor.Status) {
		return lifecycleStatusError(anchor.Status)
	}
	payload, err := readLifecycleCache(options)
	if err != nil {
		return err
	}
	receipt, err := verifyOpaqueStatusReceipt(payload.Receipt, options.Material, now, options.TrustedPublicKeys)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	lastObserved, err := time.Parse(time.RFC3339Nano, payload.LastObserved)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	lastObserved = lastObserved.UTC()
	if anchor.HighestRevision != receipt.Status.Revision || anchor.Status != receipt.Status.Status {
		return ErrLicenseOfflineCacheInvalid
	}
	if !anchorObserved.Equal(lastObserved) {
		return ErrLicenseOfflineCacheInvalid
	}
	if now.Before(receipt.CheckedAt) || now.Before(lastObserved) || now.Before(anchorObserved) {
		return ErrLicenseClockRollback
	}
	if stateErr := lifecycleStatusError(receipt.Status.Status); stateErr != nil {
		return stateErr
	}
	effectiveUntil := receipt.GraceUntil
	if cap := receipt.CheckedAt.Add(maxOfflineGrace); effectiveUntil.After(cap) {
		effectiveUntil = cap
	}
	if effectiveUntil.After(options.Material.ExpiresAt) {
		effectiveUntil = options.Material.ExpiresAt
	}
	if !now.Before(effectiveUntil) {
		return ErrLicenseOfflineGraceExpired
	}
	if err := writeHostAuthorizationAnchor(options, hostAuthorizationAnchor{
		HighestRevision: anchor.HighestRevision,
		Status:          anchor.Status,
		LastObserved:    now.Format(time.RFC3339Nano),
	}); err != nil {
		return err
	}
	if err := writeLifecycleCache(options, receipt, now); err != nil {
		return err
	}
	return nil
}

func verifyLicenseStatusResponse(
	response licenseStatusResponse,
	material verifiedLicenseMaterial,
	now time.Time,
	trustedKeys map[string]ed25519.PublicKey,
) (verifiedStatusReceipt, error) {
	receipt, err := verifyOpaqueStatusReceipt(response.Receipt.Value, material, now, trustedKeys)
	if err != nil {
		return verifiedStatusReceipt{}, err
	}
	if !sameLicenseStatus(response.Status, receipt.Status) {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	return receipt, nil
}

func verifyOpaqueStatusReceipt(
	value string,
	material verifiedLicenseMaterial,
	now time.Time,
	trustedKeys map[string]ed25519.PublicKey,
) (verifiedStatusReceipt, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 || len(value) > 64<<10 {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	encoding := base64.RawURLEncoding.Strict()
	payload, err := encoding.DecodeString(parts[0])
	if err != nil || len(payload) == 0 || len(payload) > 48<<10 || encoding.EncodeToString(payload) != parts[0] {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	signature, err := encoding.DecodeString(parts[1])
	if err != nil || len(signature) != ed25519.SignatureSize || encoding.EncodeToString(signature) != parts[1] {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	var fields []json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(&fields); err != nil || len(fields) != 13 || ensureJSONEnd(decoder) != nil {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	var domain, licenseID, deviceID, statusValue, notBeforeValue, expiresAtValue, updatedAtValue, checkedAtValue, graceUntilValue, keyID string
	var version int
	var revision int64
	var replacement *string
	values := []struct {
		index int
		out   any
	}{
		{0, &domain}, {1, &version}, {2, &licenseID}, {3, &deviceID}, {4, &statusValue}, {5, &revision},
		{6, &notBeforeValue}, {7, &expiresAtValue}, {8, &replacement}, {9, &updatedAtValue}, {10, &checkedAtValue}, {11, &graceUntilValue}, {12, &keyID},
	}
	for _, value := range values {
		if err := json.Unmarshal(fields[value.index], value.out); err != nil {
			return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
		}
	}
	publicKey, ok := trustedKeys[keyID]
	if domain != "uclaw-license-status-v1" || version != 1 || !validLicenseIdentifier(keyID) || !ok ||
		len(publicKey) != ed25519.PublicKeySize || !ed25519.Verify(publicKey, payload, signature) {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	status := licenseLifecycleStatus(statusValue)
	if !validLifecycleStatus(status) || revision < 1 || !validLicenseIdentifier(licenseID) || !validLicenseIdentifier(deviceID) {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	if licenseID != material.LicenseID {
		return verifiedStatusReceipt{}, ErrLicenseStatusLicenseMismatch
	}
	if deviceID != material.DeviceID {
		return verifiedStatusReceipt{}, ErrLicenseStatusDeviceMismatch
	}
	notBefore, notBeforeErr := time.Parse(time.RFC3339Nano, notBeforeValue)
	expiresAt, expiresAtErr := time.Parse(time.RFC3339Nano, expiresAtValue)
	updatedAt, updatedAtErr := time.Parse(time.RFC3339Nano, updatedAtValue)
	checkedAt, checkedAtErr := time.Parse(time.RFC3339Nano, checkedAtValue)
	graceUntil, graceUntilErr := time.Parse(time.RFC3339Nano, graceUntilValue)
	if notBeforeErr != nil || expiresAtErr != nil || updatedAtErr != nil || checkedAtErr != nil || graceUntilErr != nil || !expiresAt.After(notBefore) {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	notBefore, expiresAt, updatedAt, checkedAt, graceUntil = notBefore.UTC(), expiresAt.UTC(), updatedAt.UTC(), checkedAt.UTC(), graceUntil.UTC()
	if !expiresAt.Equal(material.ExpiresAt.UTC()) || graceUntil.Before(checkedAt) ||
		graceUntil.After(checkedAt.Add(maxOfflineGrace)) || graceUntil.After(expiresAt) || updatedAt.After(checkedAt) {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	replacementID := ""
	if replacement != nil {
		replacementID = *replacement
	}
	if (status == licenseStatusReissued) != (replacementID != "") || (replacementID != "" && !validLicenseIdentifier(replacementID)) {
		return verifiedStatusReceipt{}, ErrLicenseStatusReceiptInvalid
	}
	return verifiedStatusReceipt{
		Status: licenseStatusSummary{
			LicenseID: licenseID, DeviceID: deviceID, Status: status, Revision: revision,
			NotBefore: notBeforeValue, ExpiresAt: expiresAtValue, ReplacementLicenseID: replacementID, UpdatedAt: updatedAtValue,
		},
		CheckedAt: checkedAt, GraceUntil: graceUntil, Raw: value,
	}, nil
}

func validLifecycleStatus(status licenseLifecycleStatus) bool {
	switch status {
	case licenseStatusProvisioning, licenseStatusActive, licenseStatusRevoked, licenseStatusReissued, licenseStatusExpired, licenseStatusDisabled:
		return true
	default:
		return false
	}
}

func sameLicenseStatus(left licenseStatusSummary, right licenseStatusSummary) bool {
	return left.LicenseID == right.LicenseID && left.DeviceID == right.DeviceID && left.Status == right.Status &&
		left.Revision == right.Revision && left.NotBefore == right.NotBefore && left.ExpiresAt == right.ExpiresAt &&
		left.ReplacementLicenseID == right.ReplacementLicenseID && left.UpdatedAt == right.UpdatedAt
}

func lifecycleStatusError(status licenseLifecycleStatus) error {
	switch status {
	case licenseStatusActive:
		return nil
	case licenseStatusProvisioning:
		return ErrLicenseProvisioning
	case licenseStatusRevoked:
		return ErrLicenseRevoked
	case licenseStatusReissued:
		return ErrLicenseReissued
	case licenseStatusExpired:
		return ErrLicenseExpired
	case licenseStatusDisabled:
		return ErrLicenseDisabled
	default:
		return ErrLicenseStatusReceiptInvalid
	}
}

func terminalLifecycleStatus(status licenseLifecycleStatus) bool {
	switch status {
	case licenseStatusRevoked, licenseStatusReissued, licenseStatusExpired, licenseStatusDisabled:
		return true
	default:
		return false
	}
}

func hostAuthorizationAnchorFilename(material verifiedLicenseMaterial) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte("uclaw-license-host-anchor-name-v1\x00"))
	_, _ = hash.Write([]byte(material.LicenseID))
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(material.DeviceID))
	return hex.EncodeToString(hash.Sum(nil)) + ".json"
}

func hostAuthorizationAnchorKey(secret string) [32]byte {
	return sha256.Sum256(append([]byte("uclaw-license-host-anchor-hmac-key-v1\x00"), []byte(secret)...))
}

func hostAuthorizationAnchorMessage(material verifiedLicenseMaterial, anchor hostAuthorizationAnchor) ([]byte, error) {
	return json.Marshal([]any{
		"uclaw-license-host-anchor-v1", 1, material.LicenseID, material.DeviceID,
		anchor.HighestRevision, anchor.Status, anchor.LastObserved,
	})
}

func authenticateHostAuthorizationAnchor(material verifiedLicenseMaterial, anchor hostAuthorizationAnchor) (string, error) {
	message, err := hostAuthorizationAnchorMessage(material, anchor)
	if err != nil {
		return "", err
	}
	key := hostAuthorizationAnchorKey(material.StartupSecret)
	authenticator := hmac.New(sha256.New, key[:])
	_, _ = authenticator.Write(message)
	return base64.RawURLEncoding.EncodeToString(authenticator.Sum(nil)), nil
}

func readHostAuthorizationAnchor(options licenseLifecycleVerificationOptions) (hostAuthorizationAnchor, bool, error) {
	info, err := os.Lstat(options.AnchorRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return hostAuthorizationAnchor{}, false, nil
		}
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	root, err := os.OpenRoot(options.AnchorRoot)
	if err != nil {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	defer root.Close()
	directory, err := root.Lstat(hostAuthorizationAnchorDirectory)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return hostAuthorizationAnchor{}, false, nil
		}
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	if !directory.IsDir() || directory.Mode()&os.ModeSymlink != 0 {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	path := filepath.Join(hostAuthorizationAnchorDirectory, hostAuthorizationAnchorFilename(options.Material))
	before, err := root.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return hostAuthorizationAnchor{}, false, nil
		}
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() > maxHostAuthorizationAnchorBytes {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	file, err := root.Open(path)
	if err != nil {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || !after.Mode().IsRegular() || after.Size() > maxHostAuthorizationAnchorBytes {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	links, err := fileLinkCount(file, after)
	if err != nil || links != 1 {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	content, err := io.ReadAll(io.LimitReader(file, maxHostAuthorizationAnchorBytes+1))
	if err != nil || len(content) > maxHostAuthorizationAnchorBytes || rejectDuplicateJSONKeys(content) != nil {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	var anchor hostAuthorizationAnchor
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&anchor); err != nil || ensureJSONEnd(decoder) != nil ||
		anchor.HighestRevision < 1 || !validLifecycleStatus(anchor.Status) || anchor.LastObserved == "" || anchor.Authentication == "" {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	if _, err := time.Parse(time.RFC3339Nano, anchor.LastObserved); err != nil {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	expected, err := authenticateHostAuthorizationAnchor(options.Material, hostAuthorizationAnchor{
		HighestRevision: anchor.HighestRevision,
		Status:          anchor.Status,
		LastObserved:    anchor.LastObserved,
	})
	if err != nil || !hmac.Equal([]byte(anchor.Authentication), []byte(expected)) {
		return hostAuthorizationAnchor{}, false, ErrLicenseOfflineCacheInvalid
	}
	return anchor, true, nil
}

func writeHostAuthorizationAnchor(options licenseLifecycleVerificationOptions, anchor hostAuthorizationAnchor) error {
	if anchor.HighestRevision < 1 || !validLifecycleStatus(anchor.Status) {
		return ErrLicenseOfflineCacheInvalid
	}
	if _, err := time.Parse(time.RFC3339Nano, anchor.LastObserved); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	authentication, err := authenticateHostAuthorizationAnchor(options.Material, anchor)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	anchor.Authentication = authentication
	encoded, err := json.Marshal(anchor)
	if err != nil || len(encoded) > maxHostAuthorizationAnchorBytes {
		return ErrLicenseOfflineCacheInvalid
	}
	if err := os.MkdirAll(options.AnchorRoot, 0o700); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	info, err := os.Lstat(options.AnchorRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrLicenseOfflineCacheInvalid
	}
	root, err := os.OpenRoot(options.AnchorRoot)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	defer root.Close()
	if info, err := root.Lstat(hostAuthorizationAnchorDirectory); err != nil {
		if !errors.Is(err, os.ErrNotExist) || root.Mkdir(hostAuthorizationAnchorDirectory, 0o700) != nil {
			return ErrLicenseOfflineCacheInvalid
		}
	} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrLicenseOfflineCacheInvalid
	}
	path := filepath.Join(hostAuthorizationAnchorDirectory, hostAuthorizationAnchorFilename(options.Material))
	if before, err := root.Lstat(path); err == nil {
		if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
			return ErrLicenseOfflineCacheInvalid
		}
		file, openErr := root.Open(path)
		if openErr != nil {
			return ErrLicenseOfflineCacheInvalid
		}
		after, statErr := file.Stat()
		var links uint64
		var linkErr error
		if statErr == nil {
			links, linkErr = fileLinkCount(file, after)
		}
		closeErr := file.Close()
		if statErr != nil || !os.SameFile(before, after) || linkErr != nil || links != 1 || closeErr != nil {
			return ErrLicenseOfflineCacheInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrLicenseOfflineCacheInvalid
	}
	token := make([]byte, 8)
	if _, err := io.ReadFull(options.Random, token); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	temporary := filepath.Join(hostAuthorizationAnchorDirectory, ".anchor-"+base64.RawURLEncoding.EncodeToString(token)+".tmp")
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = root.Remove(temporary)
		}
	}()
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		return ErrLicenseOfflineCacheInvalid
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return ErrLicenseOfflineCacheInvalid
	}
	if err := file.Close(); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	if err := root.Rename(temporary, path); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	removeTemporary = false
	if directory, err := root.Open(hostAuthorizationAnchorDirectory); err == nil {
		defer directory.Close()
		if err := syncDirectory(directory); err != nil {
			return ErrLicenseOfflineCacheInvalid
		}
	}
	return nil
}

func lifecycleCacheKey(secret string) [32]byte {
	return sha256.Sum256(append([]byte("uclaw-license-cache-aead-v1\x00"), []byte(secret)...))
}

func lifecycleCacheAdditionalData(material verifiedLicenseMaterial) []byte {
	encoded, _ := json.Marshal([]any{"uclaw-license-cache-aead-v1", 1, material.LicenseID, material.DeviceID, material.USBFingerprint})
	return encoded
}

func writeLifecycleCache(options licenseLifecycleVerificationOptions, receipt verifiedStatusReceipt, observedAt time.Time) error {
	payload, err := json.Marshal(lifecycleCachePayload{Receipt: receipt.Raw, LastObserved: observedAt.UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	key := lifecycleCacheKey(options.Material.StartupSecret)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(options.Random, nonce); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	ciphertext := aead.Seal(nil, nonce, payload, lifecycleCacheAdditionalData(options.Material))
	encoded, err := json.Marshal(lifecycleCacheEnvelope{
		SchemaVersion: 1,
		Nonce:         base64.RawURLEncoding.EncodeToString(nonce),
		Ciphertext:    base64.RawURLEncoding.EncodeToString(ciphertext),
	})
	if err != nil || len(encoded) > maxLifecycleCacheBytes {
		return ErrLicenseOfflineCacheInvalid
	}
	return atomicWriteLifecycleCache(options.PackageRoot, encoded, options.Random)
}

func atomicWriteLifecycleCache(packageRoot string, content []byte, random io.Reader) error {
	root, err := os.OpenRoot(packageRoot)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	defer root.Close()
	if info, err := root.Lstat("license"); err != nil {
		if !errors.Is(err, os.ErrNotExist) || root.Mkdir("license", 0o700) != nil {
			return ErrLicenseOfflineCacheInvalid
		}
	} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrLicenseOfflineCacheInvalid
	}
	if info, err := root.Lstat(filepath.Join("license", lifecycleCacheFilename)); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return ErrLicenseOfflineCacheInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrLicenseOfflineCacheInvalid
	}
	token := make([]byte, 8)
	if _, err := io.ReadFull(random, token); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	temporary := filepath.Join("license", ".lifecycle-cache-"+base64.RawURLEncoding.EncodeToString(token)+".tmp")
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = root.Remove(temporary)
		}
	}()
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return ErrLicenseOfflineCacheInvalid
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return ErrLicenseOfflineCacheInvalid
	}
	if err := file.Close(); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	if err := root.Rename(temporary, filepath.Join("license", lifecycleCacheFilename)); err != nil {
		return ErrLicenseOfflineCacheInvalid
	}
	removeTemporary = false
	if directory, err := root.Open("license"); err == nil {
		defer directory.Close()
		if err := syncDirectory(directory); err != nil {
			return ErrLicenseOfflineCacheInvalid
		}
	}
	return nil
}

func readLifecycleCache(options licenseLifecycleVerificationOptions) (lifecycleCachePayload, error) {
	root, err := os.OpenRoot(options.PackageRoot)
	if err != nil {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheMissing
	}
	defer root.Close()
	directory, err := root.Lstat("license")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return lifecycleCachePayload{}, ErrLicenseOfflineCacheMissing
		}
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	if !directory.IsDir() || directory.Mode()&os.ModeSymlink != 0 {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	path := filepath.Join("license", lifecycleCacheFilename)
	before, err := root.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return lifecycleCachePayload{}, ErrLicenseOfflineCacheMissing
		}
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() > maxLifecycleCacheBytes {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	file, err := root.Open(path)
	if err != nil {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || !after.Mode().IsRegular() || after.Size() > maxLifecycleCacheBytes {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	links, err := fileLinkCount(file, after)
	if err != nil || links != 1 {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	content, err := io.ReadAll(io.LimitReader(file, maxLifecycleCacheBytes+1))
	if err != nil || len(content) > maxLifecycleCacheBytes || rejectDuplicateJSONKeys(content) != nil {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	var envelope lifecycleCacheEnvelope
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil || ensureJSONEnd(decoder) != nil || envelope.SchemaVersion != 1 {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	nonce, nonceErr := base64.RawURLEncoding.DecodeString(envelope.Nonce)
	ciphertext, ciphertextErr := base64.RawURLEncoding.DecodeString(envelope.Ciphertext)
	key := lifecycleCacheKey(options.Material.StartupSecret)
	block, blockErr := aes.NewCipher(key[:])
	if nonceErr != nil || ciphertextErr != nil || blockErr != nil {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(nonce) != aead.NonceSize() || len(ciphertext) < aead.Overhead() {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, lifecycleCacheAdditionalData(options.Material))
	if err != nil || rejectDuplicateJSONKeys(plaintext) != nil {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	var payload lifecycleCachePayload
	payloadDecoder := json.NewDecoder(bytes.NewReader(plaintext))
	payloadDecoder.DisallowUnknownFields()
	if err := payloadDecoder.Decode(&payload); err != nil || ensureJSONEnd(payloadDecoder) != nil || payload.Receipt == "" || payload.LastObserved == "" {
		return lifecycleCachePayload{}, ErrLicenseOfflineCacheInvalid
	}
	return payload, nil
}
