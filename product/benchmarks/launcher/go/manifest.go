package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type Manifest struct {
	RuntimeID string `json:"runtimeId"`
	Archive   string `json:"archive"`
	SHA256    string `json:"sha256"`
}

var (
	runtimeIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	archiveSegmentPattern = regexp.MustCompile(`^[A-Za-z0-9._ -]+$`)
	sha256Pattern         = regexp.MustCompile(`^[A-Fa-f0-9]{64}$`)

	errInvalidRuntimeID = errors.New("invalid runtimeId")
	errInvalidArchive   = errors.New("invalid archive path")
	errInvalidSHA256    = errors.New("invalid sha256")
	errArchiveMissing   = errors.New("archive unavailable")
	errArchiveHash      = errors.New("archive hash mismatch")
)

func ValidateManifest(manifest Manifest) error {
	if !runtimeIDPattern.MatchString(manifest.RuntimeID) {
		return errInvalidRuntimeID
	}
	if !isSafeRelativeWindowsPath(manifest.Archive) {
		return errInvalidArchive
	}
	if !sha256Pattern.MatchString(manifest.SHA256) {
		return errInvalidSHA256
	}
	return nil
}

func ValidatePackage(baseDir string, manifest Manifest) error {
	if err := ValidateManifest(manifest); err != nil {
		return err
	}

	archivePath, err := containedArchivePath(baseDir, manifest.Archive)
	if err != nil {
		return errArchiveMissing
	}
	data, err := os.ReadFile(archivePath)
	if err != nil {
		return errArchiveMissing
	}
	actual := sha256.Sum256(data)
	expected := strings.ToLower(manifest.SHA256)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(hex.EncodeToString(actual[:]))) != 1 {
		return errArchiveHash
	}
	return nil
}

func isSafeRelativeWindowsPath(path string) bool {
	if path == "" {
		return false
	}
	if path[0] == '/' || path[0] == '\\' {
		return false
	}

	normalized := strings.ReplaceAll(path, `\`, "/")
	for _, segment := range strings.Split(normalized, "/") {
		normalizedSegment := strings.TrimRight(segment, " .")
		if normalizedSegment == "" || normalizedSegment != segment || !archiveSegmentPattern.MatchString(normalizedSegment) {
			return false
		}
		if isWindowsDeviceName(normalizedSegment) {
			return false
		}
	}
	return true
}

func isWindowsDeviceName(segment string) bool {
	baseName := strings.SplitN(segment, ".", 2)[0]
	baseName = strings.ToUpper(strings.TrimRight(baseName, " "))
	switch baseName {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(baseName) != 4 || baseName[3] < '1' || baseName[3] > '9' {
		return false
	}
	return baseName[:3] == "COM" || baseName[:3] == "LPT"
}

func containedArchivePath(baseDir, archive string) (string, error) {
	basePath, err := filepath.EvalSymlinks(baseDir)
	if err != nil {
		return "", err
	}
	basePath, err = filepath.Abs(basePath)
	if err != nil {
		return "", err
	}

	hostRelative := filepath.FromSlash(strings.ReplaceAll(archive, `\`, "/"))
	archivePath, err := filepath.EvalSymlinks(filepath.Join(basePath, hostRelative))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(basePath, archivePath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errInvalidArchive
	}
	return archivePath, nil
}
