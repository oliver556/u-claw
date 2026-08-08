package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxManifestBytes = 1 << 20

var (
	ErrManifestInvalid = errors.New("runtime manifest invalid")
	ErrPackageInvalid  = errors.New("runtime package invalid")

	runtimeIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	sha256Pattern     = regexp.MustCompile(`^[A-Fa-f0-9]{64}$`)
	windowsDeviceName = regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$`)
)

type Manifest struct {
	SchemaVersion   int      `json:"schemaVersion"`
	ProductVersion  string   `json:"productVersion"`
	NodeVersion     string   `json:"nodeVersion"`
	ElectronVersion string   `json:"electronVersion"`
	RuntimeVersion  string   `json:"runtimeVersion"`
	RuntimeID       string   `json:"runtimeId"`
	TargetPlatform  string   `json:"targetPlatform"`
	TargetArch      string   `json:"targetArch"`
	RuntimeArchive  string   `json:"runtimeArchive"`
	RuntimeSHA256   string   `json:"runtimeSha256"`
	RuntimeBytes    int64    `json:"runtimeBytes"`
	UnpackedBytes   int64    `json:"unpackedBytes"`
	FileCount       int64    `json:"fileCount"`
	Entrypoint      string   `json:"entrypoint"`
	EntryArgs       []string `json:"entryArgs"`
}

func ReadManifest(path string) (Manifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return Manifest{}, ErrManifestInvalid
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, maxManifestBytes+1))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, ErrManifestInvalid
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return Manifest{}, ErrManifestInvalid
	}
	if err := ValidateManifest(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func ValidateManifest(manifest Manifest) error {
	if manifest.SchemaVersion != 1 ||
		!isSafeVersion(manifest.ProductVersion) ||
		!isSafeVersion(manifest.NodeVersion) ||
		!isSafeVersion(manifest.ElectronVersion) ||
		!isSafeVersion(manifest.RuntimeVersion) ||
		!runtimeIDPattern.MatchString(manifest.RuntimeID) ||
		manifest.TargetPlatform != "win32" ||
		manifest.TargetArch != "x64" ||
		!isSafeWindowsRelativePath(manifest.RuntimeArchive) ||
		!sha256Pattern.MatchString(manifest.RuntimeSHA256) ||
		manifest.RuntimeBytes <= 0 ||
		manifest.UnpackedBytes <= 0 ||
		manifest.FileCount <= 0 ||
		!isSafeWindowsRelativePath(manifest.Entrypoint) ||
		manifest.EntryArgs == nil ||
		len(manifest.EntryArgs) > 64 {
		return ErrManifestInvalid
	}
	for _, argument := range manifest.EntryArgs {
		if strings.ContainsRune(argument, 0) || utf8.RuneCountInString(argument) > 4096 {
			return ErrManifestInvalid
		}
	}
	return nil
}

func ValidatePackage(baseDir string, manifest Manifest) error {
	if err := ValidateManifest(manifest); err != nil {
		return err
	}
	root, err := os.OpenRoot(baseDir)
	if err != nil {
		return ErrPackageInvalid
	}
	defer root.Close()

	archivePath := strings.ReplaceAll(manifest.RuntimeArchive, `\`, string(os.PathSeparator))
	file, err := root.Open(archivePath)
	if err != nil {
		return ErrPackageInvalid
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != manifest.RuntimeBytes {
		return ErrPackageInvalid
	}

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return ErrPackageInvalid
	}
	expected := strings.ToLower(manifest.RuntimeSHA256)
	actual := hex.EncodeToString(hasher.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) != 1 {
		return ErrPackageInvalid
	}
	return nil
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("trailing JSON value")
	}
	return err
}

func isSafeVersion(value string) bool {
	if value == "" || utf8.RuneCountInString(value) > 128 {
		return false
	}
	return strings.IndexFunc(value, func(character rune) bool {
		return character < 0x20 || character == 0x7f
	}) == -1
}

func isSafeWindowsRelativePath(value string) bool {
	if value == "" || utf8.RuneCountInString(value) > 32767 || value[0] == '/' || value[0] == '\\' {
		return false
	}
	if strings.IndexFunc(value, func(character rune) bool {
		return character < 0x20 || character == 0x7f || strings.ContainsRune(`<>:"|?*`, character)
	}) != -1 {
		return false
	}

	normalized := strings.ReplaceAll(value, `\`, "/")
	for _, segment := range strings.Split(normalized, "/") {
		if segment == "" || segment == "." || segment == ".." ||
			strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
			return false
		}
		baseName := strings.SplitN(segment, ".", 2)[0]
		if windowsDeviceName.MatchString(baseName) {
			return false
		}
	}
	return true
}
