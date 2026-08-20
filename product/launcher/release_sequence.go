package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	installedCurrentName = "installed-current.json"
	releaseSequenceName  = installedCurrentName
	runtimeAnchorName    = ".uclaw-runtime-anchor"
	runtimeAnchorBytes   = 32
)

type releaseSequenceRecord struct {
	SchemaVersion     int    `json:"schemaVersion"`
	ReleaseSequence   uint64 `json:"releaseSequence"`
	ReleaseID         string `json:"releaseId"`
	RuntimeTreeSHA256 string `json:"runtimeTreeSha256"`
	ManifestSHA256    string `json:"manifestSha256"`
	SignatureValue    string `json:"signatureValue"`
	MAC               string `json:"mac"`
}

func runtimeSequenceIdentity(manifest Manifest) (releaseSequenceRecord, error) {
	if manifest.Signature == nil || manifest.ReleaseSequence == 0 || manifest.Signature.Sequence != manifest.ReleaseSequence {
		return releaseSequenceRecord{}, ErrManifestInvalid
	}
	payload, err := manifestSigningPayload(manifest)
	if err != nil {
		return releaseSequenceRecord{}, ErrManifestInvalid
	}
	digest := sha256.New()
	digest.Write(payload)
	digest.Write([]byte{0})
	digest.Write([]byte(manifest.Signature.Value))
	return releaseSequenceRecord{
		SchemaVersion: 1, ReleaseSequence: manifest.ReleaseSequence, ReleaseID: manifest.ReleaseID,
		RuntimeTreeSHA256: strings.ToLower(manifest.RuntimeTreeSHA256),
		ManifestSHA256:    hex.EncodeToString(digest.Sum(nil)), SignatureValue: manifest.Signature.Value,
	}, nil
}

func sameRuntimeSequenceIdentity(record releaseSequenceRecord, manifest Manifest) bool {
	candidate, err := runtimeSequenceIdentity(manifest)
	return err == nil && record.ReleaseSequence == candidate.ReleaseSequence && record.ReleaseID == candidate.ReleaseID &&
		record.RuntimeTreeSHA256 == candidate.RuntimeTreeSHA256 && record.ManifestSHA256 == candidate.ManifestSHA256 &&
		record.SignatureValue == candidate.SignatureValue
}

func AcceptRuntimeSequence(cacheRoot string, manifest Manifest) error {
	candidate, err := runtimeSequenceIdentity(manifest)
	if err != nil {
		return err
	}
	current, root, anchor, err := readRuntimeSequence(cacheRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	if candidate.ReleaseSequence < current.ReleaseSequence || candidate.ReleaseSequence == current.ReleaseSequence &&
		current.ReleaseSequence != 0 && !sameRuntimeSequenceIdentity(current, manifest) {
		return ErrManifestInvalid
	}
	if current.ReleaseSequence == candidate.ReleaseSequence {
		return nil
	}
	candidate.MAC = installedCurrentMAC(anchor, candidate)
	return writeInstalledCurrent(root, candidate)
}

func CheckRuntimeSequence(cacheRoot string, manifest Manifest) error {
	candidate, err := runtimeSequenceIdentity(manifest)
	if err != nil {
		return err
	}
	current, root, _, err := readRuntimeSequence(cacheRoot)
	if root != nil {
		defer root.Close()
	}
	if err != nil || candidate.ReleaseSequence < current.ReleaseSequence || candidate.ReleaseSequence == current.ReleaseSequence &&
		current.ReleaseSequence != 0 && !sameRuntimeSequenceIdentity(current, manifest) {
		return ErrManifestInvalid
	}
	return nil
}

func readRuntimeSequence(cacheRoot string) (releaseSequenceRecord, *os.Root, []byte, error) {
	root, err := os.OpenRoot(cacheRoot)
	if err != nil {
		return releaseSequenceRecord{}, nil, nil, ErrManifestInvalid
	}
	anchor, err := readRuntimeAnchor(root)
	if err != nil {
		root.Close()
		return releaseSequenceRecord{}, nil, nil, ErrManifestInvalid
	}
	entry, entryErr := root.Lstat(installedCurrentName)
	if errors.Is(entryErr, os.ErrNotExist) {
		return releaseSequenceRecord{}, root, anchor, nil
	}
	if entryErr != nil || !entry.Mode().IsRegular() || entry.Mode()&os.ModeSymlink != 0 || entry.Size() > 8192 {
		root.Close()
		return releaseSequenceRecord{}, nil, nil, ErrManifestInvalid
	}
	file, openErr := root.Open(installedCurrentName)
	if openErr != nil {
		root.Close()
		return releaseSequenceRecord{}, nil, nil, ErrManifestInvalid
	}
	info, statErr := file.Stat()
	if statErr != nil {
		file.Close()
		root.Close()
		return releaseSequenceRecord{}, nil, nil, ErrManifestInvalid
	}
	links, linkErr := fileLinkCount(file, info)
	decoder := json.NewDecoder(io.LimitReader(file, 8193))
	decoder.DisallowUnknownFields()
	var record releaseSequenceRecord
	decodeErr := decoder.Decode(&record)
	trailingErr := decoder.Decode(&struct{}{})
	closeErr := file.Close()
	if statErr != nil || linkErr != nil || links != 1 || !os.SameFile(entry, info) || !info.Mode().IsRegular() || info.Size() > 8192 ||
		decodeErr != nil || !errors.Is(trailingErr, io.EOF) || closeErr != nil || !validInstalledCurrent(record, anchor) {
		root.Close()
		return releaseSequenceRecord{}, nil, nil, ErrManifestInvalid
	}
	return record, root, anchor, nil
}

func validInstalledCurrent(record releaseSequenceRecord, anchor []byte) bool {
	if record.SchemaVersion != 1 || record.ReleaseSequence == 0 || !runtimeIDPattern.MatchString(record.ReleaseID) ||
		!sha256Pattern.MatchString(record.RuntimeTreeSHA256) || !sha256Pattern.MatchString(record.ManifestSHA256) ||
		record.SignatureValue == "" || len(record.SignatureValue) > 256 || !sha256Pattern.MatchString(record.MAC) {
		return false
	}
	expected := installedCurrentMAC(anchor, record)
	return subtle.ConstantTimeCompare([]byte(strings.ToLower(record.MAC)), []byte(expected)) == 1
}

func installedCurrentMAC(anchor []byte, record releaseSequenceRecord) string {
	mac := hmac.New(sha256.New, anchor)
	_, _ = io.WriteString(mac, "uclaw-installed-current-v1\n")
	_, _ = io.WriteString(mac, fmt.Sprintf("%d\n", record.ReleaseSequence))
	_, _ = io.WriteString(mac, record.ReleaseID+"\n")
	_, _ = io.WriteString(mac, strings.ToLower(record.RuntimeTreeSHA256)+"\n")
	_, _ = io.WriteString(mac, strings.ToLower(record.ManifestSHA256)+"\n")
	_, _ = io.WriteString(mac, record.SignatureValue+"\n")
	return hex.EncodeToString(mac.Sum(nil))
}

func writeInstalledCurrent(root *os.Root, record releaseSequenceRecord) error {
	temporary := installedCurrentName + ".new"
	_ = root.Remove(temporary)
	out, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrManifestInvalid
	}
	encodeErr := json.NewEncoder(out).Encode(record)
	syncErr := out.Sync()
	closeErr := out.Close()
	if encodeErr != nil || syncErr != nil || closeErr != nil {
		_ = root.Remove(temporary)
		return ErrManifestInvalid
	}
	if err := root.Rename(temporary, installedCurrentName); err != nil {
		_ = root.Remove(temporary)
		return ErrManifestInvalid
	}
	directory, err := root.Open(".")
	if err != nil {
		return ErrManifestInvalid
	}
	syncErr = directory.Sync()
	closeErr = directory.Close()
	if syncErr != nil || closeErr != nil {
		return ErrManifestInvalid
	}
	return nil
}

func ensureRuntimeAnchor(root *os.Root) error {
	if _, err := readRuntimeAnchor(root); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrCachePreparationFailed
	}
	value := make([]byte, runtimeAnchorBytes)
	if _, err := rand.Read(value); err != nil {
		return ErrCachePreparationFailed
	}
	file, err := root.OpenFile(runtimeAnchorName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrCachePreparationFailed
	}
	_, writeErr := file.Write(value)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		_ = root.Remove(runtimeAnchorName)
		return ErrCachePreparationFailed
	}
	return nil
}

func readRuntimeAnchor(root *os.Root) ([]byte, error) {
	entry, err := root.Lstat(runtimeAnchorName)
	if err != nil {
		return nil, err
	}
	if !entry.Mode().IsRegular() || entry.Mode()&os.ModeSymlink != 0 || entry.Size() != runtimeAnchorBytes {
		return nil, ErrManifestInvalid
	}
	file, err := root.Open(runtimeAnchorName)
	if err != nil {
		return nil, err
	}
	info, statErr := file.Stat()
	if statErr != nil {
		file.Close()
		return nil, ErrManifestInvalid
	}
	links, linkErr := fileLinkCount(file, info)
	value, readErr := io.ReadAll(io.LimitReader(file, runtimeAnchorBytes+1))
	closeErr := file.Close()
	if statErr != nil || linkErr != nil || links != 1 || !os.SameFile(entry, info) || !info.Mode().IsRegular() || info.Size() != runtimeAnchorBytes ||
		readErr != nil || closeErr != nil || len(value) != runtimeAnchorBytes {
		return nil, ErrManifestInvalid
	}
	return value, nil
}
