package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Populated at release build time with public keys only. Private keys never enter the binary.
var trustedRuntimeKeys = "{}"
var revokedRuntimeKeyIDs = "[]"
var releaseFeedBaseURL = ""

const maxManifestBytes = 1 << 20
const maxSafeJSONInteger = int64(9007199254740991)

var (
	ErrManifestInvalid = errors.New("runtime manifest invalid")
	ErrPackageInvalid  = errors.New("runtime package invalid")

	runtimeIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	sha256Pattern     = regexp.MustCompile(`^[A-Fa-f0-9]{64}$`)
	windowsDeviceName = regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$`)
)

type Manifest struct {
	SchemaVersion     int                 `json:"schemaVersion"`
	ReleaseID         string              `json:"releaseId"`
	ReleaseSequence   uint64              `json:"releaseSequence"`
	ProductVersion    string              `json:"productVersion"`
	NodeVersion       string              `json:"nodeVersion"`
	ElectronVersion   string              `json:"electronVersion"`
	RuntimeVersion    string              `json:"runtimeVersion"`
	RuntimeID         string              `json:"runtimeId"`
	TargetPlatform    string              `json:"targetPlatform"`
	TargetArch        string              `json:"targetArch"`
	RuntimeArchive    string              `json:"runtimeArchive"`
	RuntimeSHA256     string              `json:"runtimeSha256"`
	RuntimeTreeSHA256 string              `json:"runtimeTreeSha256"`
	RuntimeBytes      int64               `json:"runtimeBytes"`
	UnpackedBytes     int64               `json:"unpackedBytes"`
	FileCount         int64               `json:"fileCount"`
	Entrypoint        string              `json:"entrypoint"`
	EntryArgs         []string            `json:"entryArgs"`
	CriticalFiles     []RuntimeFileDigest `json:"criticalFiles"`
	Signature         *ManifestSignature  `json:"signature,omitempty"`
}

type RuntimeFileDigest struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type ManifestSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	SignedAt  string `json:"signedAt"`
	ExpiresAt string `json:"expiresAt"`
	Sequence  uint64 `json:"sequence"`
	Value     string `json:"value"`
}

func ReadManifest(path string) (Manifest, error) {
	manifest, err := readManifestFile(path)
	if err != nil {
		return Manifest{}, err
	}
	if err := VerifyManifestSignature(manifest, time.Now()); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func readManifestFile(path string) (Manifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return Manifest{}, ErrManifestInvalid
	}
	defer file.Close()
	return readManifest(file)
}

func readManifest(reader io.Reader) (Manifest, error) {
	decoder := json.NewDecoder(io.LimitReader(reader, maxManifestBytes+1))
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

func manifestSigningPayload(manifest Manifest) ([]byte, error) {
	if manifest.Signature == nil {
		return nil, ErrManifestInvalid
	}
	value := []any{
		"uclaw-runtime-manifest-v2", manifest.SchemaVersion, manifest.ReleaseID, manifest.ReleaseSequence, manifest.ProductVersion,
		manifest.NodeVersion, manifest.ElectronVersion, manifest.RuntimeVersion,
		manifest.RuntimeID, manifest.TargetPlatform, manifest.TargetArch,
		manifest.RuntimeArchive, manifest.RuntimeSHA256, manifest.RuntimeTreeSHA256,
		manifest.RuntimeBytes, manifest.UnpackedBytes, manifest.FileCount,
		manifest.Entrypoint, manifest.EntryArgs, manifest.CriticalFiles, manifest.Signature.Algorithm,
		manifest.Signature.KeyID, manifest.Signature.SignedAt, manifest.Signature.ExpiresAt,
		manifest.Signature.Sequence,
	}
	var output strings.Builder
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	payload := strings.TrimSuffix(output.String(), "\n")
	payload = strings.ReplaceAll(payload, `\u2028`, " ")
	payload = strings.ReplaceAll(payload, `\u2029`, " ")
	return []byte(payload), nil
}

func VerifyManifestSignature(manifest Manifest, now time.Time) error {
	signature := manifest.Signature
	if signature == nil || signature.Algorithm != "ed25519" || signature.KeyID == "" || signature.Sequence == 0 {
		return ErrManifestInvalid
	}
	var encodedKeys map[string]string
	var revoked []string
	if json.Unmarshal([]byte(trustedRuntimeKeys), &encodedKeys) != nil || json.Unmarshal([]byte(revokedRuntimeKeyIDs), &revoked) != nil {
		return ErrManifestInvalid
	}
	for _, keyID := range revoked {
		if keyID == signature.KeyID {
			return ErrManifestInvalid
		}
	}
	encodedKey, ok := encodedKeys[signature.KeyID]
	if !ok {
		return ErrManifestInvalid
	}
	publicKey, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return ErrManifestInvalid
	}
	signedAt, signedErr := time.Parse(time.RFC3339, signature.SignedAt)
	expiresAt, expiresErr := time.Parse(time.RFC3339, signature.ExpiresAt)
	if signedErr != nil || expiresErr != nil || signedAt.After(now.Add(5*time.Minute)) || !expiresAt.After(now) || !expiresAt.After(signedAt) {
		return ErrManifestInvalid
	}
	value, err := base64.StdEncoding.DecodeString(signature.Value)
	if err != nil || len(value) != ed25519.SignatureSize {
		return ErrManifestInvalid
	}
	payload, err := manifestSigningPayload(manifest)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(publicKey), payload, value) {
		return ErrManifestInvalid
	}
	return nil
}

func ValidateManifest(manifest Manifest) error {
	if manifest.SchemaVersion != 1 ||
		!runtimeIDPattern.MatchString(manifest.ReleaseID) ||
		manifest.ReleaseSequence == 0 || manifest.ReleaseSequence > uint64(maxSafeJSONInteger) ||
		!isSafeVersion(manifest.ProductVersion) ||
		!isSafeVersion(manifest.NodeVersion) ||
		!isSafeVersion(manifest.ElectronVersion) ||
		!isSafeVersion(manifest.RuntimeVersion) ||
		!runtimeIDPattern.MatchString(manifest.RuntimeID) ||
		manifest.TargetPlatform != "win32" ||
		manifest.TargetArch != "x64" ||
		!isSafeWindowsRelativePath(manifest.RuntimeArchive) ||
		!sha256Pattern.MatchString(manifest.RuntimeSHA256) ||
		!sha256Pattern.MatchString(manifest.RuntimeTreeSHA256) ||
		manifest.RuntimeBytes <= 0 || manifest.RuntimeBytes > maxSafeJSONInteger ||
		manifest.UnpackedBytes <= 0 || manifest.UnpackedBytes > maxSafeJSONInteger ||
		manifest.FileCount <= 0 || manifest.FileCount > maxSafeJSONInteger ||
		!isSafeWindowsRelativePath(manifest.Entrypoint) ||
		manifest.EntryArgs == nil ||
		len(manifest.EntryArgs) > 64 ||
		len(manifest.CriticalFiles) == 0 || len(manifest.CriticalFiles) > 512 {
		return ErrManifestInvalid
	}
	for _, argument := range manifest.EntryArgs {
		if strings.ContainsRune(argument, 0) || utf8.RuneCountInString(argument) > 4096 || strings.HasPrefix(argument, "--uclaw-startup-mode") {
			return ErrManifestInvalid
		}
	}
	entrypointCovered := false
	seenCritical := make(map[string]struct{}, len(manifest.CriticalFiles))
	for _, file := range manifest.CriticalFiles {
		canonical := strings.ToLower(strings.ReplaceAll(file.Path, `\`, "/"))
		if !isSafeWindowsRelativePath(file.Path) || file.Size < 0 || file.Size > maxSafeJSONInteger || !sha256Pattern.MatchString(file.SHA256) {
			return ErrManifestInvalid
		}
		if _, exists := seenCritical[canonical]; exists {
			return ErrManifestInvalid
		}
		seenCritical[canonical] = struct{}{}
		if strings.EqualFold(canonical, strings.ReplaceAll(manifest.Entrypoint, `\`, "/")) {
			entrypointCovered = true
		}
	}
	if !entrypointCovered {
		return ErrManifestInvalid
	}
	if manifest.Signature != nil && (manifest.Signature.Sequence > uint64(maxSafeJSONInteger) || !runtimeIDPattern.MatchString(manifest.Signature.KeyID)) {
		return ErrManifestInvalid
	}
	if manifest.Signature != nil && manifest.Signature.Sequence != manifest.ReleaseSequence {
		return ErrManifestInvalid
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
	return validatePackageFile(file, manifest)
}

func validatePackageFile(file *os.File, manifest Manifest) error {
	info, err := file.Stat()
	if err != nil {
		return ErrPackageInvalid
	}
	links, linkErr := fileLinkCount(file, info)
	if linkErr != nil || links != 1 || !info.Mode().IsRegular() || info.Size() != manifest.RuntimeBytes {
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
